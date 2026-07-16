import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import {
	createWriteStream,
	mkdirSync,
	readFileSync,
	type WriteStream,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { cwd } from "node:process";
import {
	type Client,
	ClientSideConnection,
	type McpServer,
	PROTOCOL_VERSION,
	type PromptResponse,
	type ReadTextFileRequest,
	type ReadTextFileResponse,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
	type Usage,
	type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import type {
	AgentMessage,
	AgentResultMessage,
	AgentSystemInitMessage,
	AgentUsage,
	IAgentRunner,
} from "cyrus-core";
import { spawnCodexAcp } from "./acpProcess.js";
import { CodexEventMapper } from "./CodexEventMapper.js";
import type {
	CodexRunnerConfig,
	CodexRunnerEvents,
	CodexSessionInfo,
} from "./types.js";

/** Built-in default Codex model when none is configured. */
const CODEX_DEFAULT_MODEL = "gpt-5-codex";

function normalizeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "Codex execution failed";
}

function toFiniteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function createResultUsage(usage?: Usage | null): AgentUsage {
	return {
		inputTokens: toFiniteNumber(usage?.inputTokens),
		outputTokens: toFiniteNumber(usage?.outputTokens),
		cacheReadTokens: toFiniteNumber(usage?.cachedReadTokens),
		cacheWriteTokens: toFiniteNumber(usage?.cachedWriteTokens),
		costUsd: 0,
	};
}

/**
 * Translate the Cyrus inline MCP config into ACP `McpServer` entries. In-process
 * SDK server instances (which expose `listTools`/`callTool` closures) cannot be
 * serialized across the stdio boundary and are skipped.
 */
export function mapMcpServersToAcp(
	mcpConfig: CodexRunnerConfig["mcpConfig"] | undefined,
): McpServer[] {
	const servers: McpServer[] = [];
	if (!mcpConfig) return servers;

	for (const [name, raw] of Object.entries(mcpConfig)) {
		const cfg = raw as Record<string, unknown>;
		if (
			typeof cfg.listTools === "function" ||
			typeof cfg.callTool === "function"
		) {
			continue;
		}

		if (typeof cfg.url === "string" && cfg.url.length > 0) {
			const headers =
				cfg.headers &&
				typeof cfg.headers === "object" &&
				!Array.isArray(cfg.headers)
					? Object.entries(cfg.headers as Record<string, string>).map(
							([key, value]) => ({ name: key, value: String(value) }),
						)
					: [];
			servers.push({ type: "http", name, url: cfg.url, headers });
			continue;
		}

		if (typeof cfg.command === "string" && cfg.command.length > 0) {
			const args = Array.isArray(cfg.args) ? (cfg.args as string[]) : [];
			const env =
				cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env)
					? Object.entries(cfg.env as Record<string, string>).map(
							([key, value]) => ({ name: key, value: String(value) }),
						)
					: [];
			servers.push({ name, command: cfg.command, args, env });
		}
	}

	return servers;
}

export declare interface CodexRunner {
	on<K extends keyof CodexRunnerEvents>(
		event: K,
		listener: CodexRunnerEvents[K],
	): this;
	emit<K extends keyof CodexRunnerEvents>(
		event: K,
		...args: Parameters<CodexRunnerEvents[K]>
	): boolean;
}

/**
 * Drives an OpenAI Codex session over the Agent Client Protocol (ACP).
 *
 * The runner spawns the Codex ACP adapter as a child process, speaks ACP over
 * its stdio as the *client*, and projects the agent's `session/update`
 * notifications into the neutral {@link AgentMessage} stream Cyrus consumes.
 * ACP is turn-based (one `session/prompt` per turn), so streaming input is not
 * supported — the runner mirrors the Cursor runner's single-prompt model.
 *
 * Permission requests are auto-approved: Cyrus runs unattended and relies on
 * worktree isolation and the sandbox for containment.
 */
export class CodexRunner extends EventEmitter implements IAgentRunner {
	readonly supportsStreamingInput = false;

	/** Provider dispatch tag (see IAgentRunner.provider). */
	readonly provider = "codex" as const;

	private config: CodexRunnerConfig;
	private sessionInfo: CodexSessionInfo | null = null;
	private messages: AgentMessage[] = [];
	private mapper: CodexEventMapper;
	private acpSessionId: string | null = null;
	private child: ReturnType<typeof spawnCodexAcp>["child"] | null = null;
	private connection: ClientSideConnection | null = null;
	private hasInitMessage = false;
	private wasStopped = false;
	private startTimestampMs = 0;
	private logStream: WriteStream | null = null;

	constructor(config: CodexRunnerConfig) {
		super();
		this.config = config;
		this.mapper = new CodexEventMapper({
			getSessionId: () => this.sessionInfo?.sessionId || "pending",
			emit: (message) => this.pushMessage(message),
		});

		if (config.onMessage) this.on("message", config.onMessage);
		if (config.onError) this.on("error", config.onError);
		if (config.onComplete) this.on("complete", config.onComplete);
	}

	async start(prompt: string): Promise<CodexSessionInfo> {
		if (this.isRunning()) {
			throw new Error("Codex session already running");
		}

		const initialSessionId = this.config.resumeSessionId || crypto.randomUUID();
		this.sessionInfo = {
			sessionId: initialSessionId,
			startedAt: new Date(),
			isRunning: true,
		};
		this.messages = [];
		this.hasInitMessage = false;
		this.wasStopped = false;
		this.startTimestampMs = Date.now();
		this.setupLogging(initialSessionId);

		const workspace = resolve(this.config.workingDirectory || cwd());

		// Test/CI fallback for environments without the Codex adapter or auth.
		if (process.env.CYRUS_CODEX_MOCK === "1") {
			this.emitInitMessage();
			this.mapper.handleUpdate({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Codex mock session completed" },
			});
			this.mapper.flush();
			this.finalizeSuccess("end_turn", null);
			return this.sessionInfo;
		}

		try {
			const { child, stream } = spawnCodexAcp(this.config, (chunk) =>
				this.log(`[stderr] ${chunk.trimEnd()}`),
			);
			this.child = child;

			const client = this.createClient();
			const connection = new ClientSideConnection(() => client, stream);
			this.connection = connection;

			child.on("error", (error) => this.log(`[spawn-error] ${error.message}`));

			await connection.initialize({
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {
					fs: { readTextFile: true, writeTextFile: true },
				},
			});

			const { sessionId } = await connection.newSession({
				cwd: workspace,
				mcpServers: mapMcpServersToAcp(this.config.mcpConfig),
			});
			this.acpSessionId = sessionId;
			if (this.sessionInfo) this.sessionInfo.sessionId = sessionId;
			this.emitInitMessage();

			const response: PromptResponse = await connection.prompt({
				sessionId,
				prompt: [{ type: "text", text: prompt }],
			});

			this.mapper.flush();
			if (response.stopReason === "cancelled" || this.wasStopped) {
				this.finalizeError("Codex session cancelled", response.usage);
			} else {
				this.finalizeSuccess(response.stopReason, response.usage);
			}
		} catch (error) {
			this.mapper.flush();
			this.finalizeError(normalizeError(error), null);
		} finally {
			this.teardownProcess();
		}

		return this.sessionInfo;
	}

	async startStreaming(_initialPrompt?: string): Promise<CodexSessionInfo> {
		throw new Error("CodexRunner does not support streaming input");
	}

	addStreamMessage(_content: string): void {
		throw new Error("CodexRunner does not support streaming input messages");
	}

	completeStream(): void {
		// No-op: CodexRunner does not support streaming input.
	}

	stop(): void {
		this.wasStopped = true;
		const connection = this.connection;
		const sessionId = this.acpSessionId;
		if (connection && sessionId) {
			void connection.cancel({ sessionId }).catch(() => {});
		}
		this.teardownProcess();
		if (this.sessionInfo) this.sessionInfo.isRunning = false;
	}

	isRunning(): boolean {
		return this.sessionInfo?.isRunning ?? false;
	}

	getMessages(): AgentMessage[] {
		return [...this.messages];
	}

	// ---------- ACP client handler ----------

	private createClient(): Client {
		return {
			sessionUpdate: (params: SessionNotification): void => {
				if (this.wasStopped) return;
				this.mapper.handleUpdate(params.update);
			},
			requestPermission: (
				params: RequestPermissionRequest,
			): RequestPermissionResponse => {
				// Auto-approve: prefer a durable "allow always" option so the agent is
				// not re-prompted for the same tool, else a one-shot allow.
				const options = params.options ?? [];
				const chosen =
					options.find((option) => option.kind === "allow_always") ??
					options.find((option) => option.kind === "allow_once") ??
					options[0];
				if (!chosen) {
					return { outcome: { outcome: "cancelled" } };
				}
				return {
					outcome: { outcome: "selected", optionId: chosen.optionId },
				};
			},
			readTextFile: (params: ReadTextFileRequest): ReadTextFileResponse => {
				const raw = readFileSync(params.path, "utf8");
				const content = sliceTextFile(raw, params.line, params.limit);
				return { content };
			},
			writeTextFile: (params: WriteTextFileRequest): void => {
				mkdirSync(dirname(params.path), { recursive: true });
				writeFileSync(params.path, params.content, "utf8");
			},
		};
	}

	// ---------- Internal helpers ----------

	private emitInitMessage(): void {
		if (this.hasInitMessage) return;
		this.hasInitMessage = true;
		const sessionId = this.sessionInfo?.sessionId || crypto.randomUUID();
		const initMessage: AgentSystemInitMessage = {
			type: "system",
			subtype: "init",
			sessionId,
			model: this.config.model || CODEX_DEFAULT_MODEL,
			tools: this.config.allowedTools || [],
			permissionMode: "default",
			apiKeySource:
				this.config.codexApiKey ||
				process.env.CODEX_API_KEY ||
				process.env.OPENAI_API_KEY
					? "user"
					: "project",
		};
		this.pushMessage(initMessage);
	}

	private finalizeSuccess(_stopReason: string, usage?: Usage | null): void {
		const result: AgentResultMessage = {
			type: "result",
			subtype: "success",
			sessionId: this.sessionInfo?.sessionId || "pending",
			result: this.mapper.getLastAssistantText() || "Codex session completed",
			isError: false,
			durationMs: Math.max(Date.now() - this.startTimestampMs, 0),
			usage: createResultUsage(usage),
		};
		this.finalize(result);
	}

	private finalizeError(message: string, usage?: Usage | null): void {
		const result: AgentResultMessage = {
			type: "result",
			subtype: "error",
			sessionId: this.sessionInfo?.sessionId || "pending",
			errors: [message],
			isError: true,
			durationMs: Math.max(Date.now() - this.startTimestampMs, 0),
			usage: createResultUsage(usage),
		};
		this.finalize(result, new Error(message));
	}

	private finalize(result: AgentResultMessage, error?: Error): void {
		if (this.sessionInfo) this.sessionInfo.isRunning = false;
		this.emitInitMessage();
		this.pushMessage(result);
		this.emit("complete", [...this.messages]);
		if (error) this.emit("error", error);
		this.closeLog();
	}

	private teardownProcess(): void {
		const child = this.child;
		if (child && !child.killed) {
			try {
				child.kill();
			} catch {}
		}
		this.child = null;
		this.connection = null;
	}

	private pushMessage(message: AgentMessage): void {
		this.messages.push(message);
		this.log(JSON.stringify(message));
		this.emit("message", message);
	}

	private setupLogging(sessionId: string): void {
		try {
			const logsDir = resolve(this.config.cyrusHome, "logs");
			mkdirSync(logsDir, { recursive: true });
			const stream = createWriteStream(
				resolve(logsDir, `codex-${sessionId}.jsonl`),
				{ flags: "a" },
			);
			stream.on("error", () => {});
			this.logStream = stream;
		} catch {
			this.logStream = null;
		}
	}

	private log(line: string): void {
		if (!this.logStream) return;
		try {
			this.logStream.write(`${line}\n`);
		} catch {}
	}

	private closeLog(): void {
		if (this.logStream) {
			try {
				this.logStream.end();
			} catch {}
			this.logStream = null;
		}
	}
}

/** Apply ACP `readTextFile` line/limit windowing to a file's contents. */
export function sliceTextFile(
	raw: string,
	line?: number | null,
	limit?: number | null,
): string {
	if (line == null && limit == null) return raw;
	const lines = raw.split("\n");
	const start = line != null && line > 0 ? line - 1 : 0;
	const end = limit != null && limit >= 0 ? start + limit : lines.length;
	return lines.slice(start, end).join("\n");
}
