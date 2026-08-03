import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { cwd } from "node:process";
import {
	type Client,
	ClientSideConnection,
	type InitializeResponse,
	PROTOCOL_VERSION,
	type PromptResponse,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
	type ToolCallUpdate,
	type Usage,
} from "@agentclientprotocol/sdk";
import type {
	AgentMessage,
	AgentResultMessage,
	AgentSystemInitMessage,
	AgentUsage,
	IAgentRunner,
} from "cyrus-core";
import { spawnOmpAcp } from "./acpProcess.js";
import { OmpEventMapper, toolNameFromKind } from "./OmpEventMapper.js";
import type {
	OmpRunnerConfig,
	OmpRunnerEvents,
	OmpSessionInfo,
} from "./types.js";

/** OMP's ACP agentInfo.name, validated before the profile becomes available. */
const OMP_AGENT_NAME = "oh-my-pi";

function normalizeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "OMP execution failed";
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

export declare interface OmpRunner {
	on<K extends keyof OmpRunnerEvents>(
		event: K,
		listener: OmpRunnerEvents[K],
	): this;
	emit<K extends keyof OmpRunnerEvents>(
		event: K,
		...args: Parameters<OmpRunnerEvents[K]>
	): boolean;
}

/**
 * Drives an Oh My Pi session over the Agent Client Protocol (ACP).
 *
 * The runner spawns `omp acp --print` as a child process with the session's
 * launch-scoped authorization inputs (ADR 0016): cwd, additional roots,
 * built-in tools, approval mode, overlay config, system prompt, and a
 * session-private state directory. It speaks ACP as the client, validates the
 * agent identity and required capabilities before use, and projects the
 * agent's `session/update` notifications into the neutral {@link AgentMessage}
 * stream.
 *
 * ACP is turn-based: a successful prompt result ends the Prompt turn, not the
 * assignment (ADR 0017). Streaming input is not supported; stop uses ACP
 * cancel. Permission requests are decided by the rendered Cyrus tool policy —
 * allowed operations select allow-once, everything else reject-always, and no
 * path lets user approval widen the OS sandbox.
 */
export class OmpRunner extends EventEmitter implements IAgentRunner {
	readonly supportsStreamingInput = false;

	/** Provider dispatch tag (see IAgentRunner.provider). */
	readonly provider = "omp" as const;

	private config: OmpRunnerConfig;
	private sessionInfo: OmpSessionInfo | null = null;
	private messages: AgentMessage[] = [];
	private mapper: OmpEventMapper;
	private acpSessionId: string | null = null;
	private child: Awaited<ReturnType<typeof spawnOmpAcp>>["child"] | null = null;
	private connection: ClientSideConnection | null = null;
	private hasInitMessage = false;
	/** True only after OMP itself assigned the session id (new/resume). */
	private hasRealSessionId = false;
	private wasStopped = false;
	private startTimestampMs = 0;

	constructor(config: OmpRunnerConfig) {
		super();
		this.config = config;
		this.mapper = new OmpEventMapper({
			getSessionId: () => this.sessionInfo?.sessionId || "pending",
			emit: (message) => this.pushMessage(message),
		});

		if (config.onMessage) this.on("message", config.onMessage);
		if (config.onError) this.on("error", config.onError);
		if (config.onComplete) this.on("complete", config.onComplete);
	}

	async start(prompt: string): Promise<OmpSessionInfo> {
		if (this.isRunning()) {
			throw new Error("OMP session already running");
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

		const workspace = resolve(this.config.workingDirectory || cwd());

		try {
			const { child, stream } = await spawnOmpAcp(
				this.config,
				workspace,
				this.config.appendSystemPrompt || "",
				(chunk) => this.log(`[stderr] ${chunk.trimEnd()}`),
			);
			this.child = child;

			const client = this.createClient();
			const connection = new ClientSideConnection(() => client, stream);
			this.connection = connection;

			child.on("error", (error) => this.log(`[spawn-error] ${error.message}`));

			// Bounded startup: fail profile startup with an actionable error when
			// the handshake does not complete in time.
			const startupTimer = setTimeout(() => {
				this.teardownProcess();
			}, this.config.ompStartupTimeoutMs ?? 30_000);
			try {
				const init = await connection.initialize({
					protocolVersion: PROTOCOL_VERSION,
					clientCapabilities: {
						fs: { readTextFile: true, writeTextFile: true },
					},
				});
				this.validateCapabilities(init);
			} finally {
				clearTimeout(startupTimer);
			}

			const mcpServers = this.config.ompMcpServers ?? [];
			let sessionId: string;
			if (this.config.resumeSessionId) {
				// Resume the persisted OMP UUID — the runner session identity the
				// session was created with. The resume response carries no session
				// id (the agent resumes the requested one), so the requested id
				// stays authoritative.
				await connection.resumeSession({
					sessionId: this.config.resumeSessionId,
					cwd: workspace,
					mcpServers,
				});
				sessionId = this.config.resumeSessionId;
			} else {
				const created = await connection.newSession({
					cwd: workspace,
					mcpServers,
				});
				sessionId = created.sessionId;
			}
			this.acpSessionId = sessionId;
			if (this.sessionInfo) this.sessionInfo.sessionId = sessionId;
			this.hasRealSessionId = true;
			this.emitInitMessage();

			const response: PromptResponse = await this.withPromptTimeout(
				connection.prompt({
					sessionId,
					prompt: [{ type: "text", text: prompt }],
				}),
			);

			this.mapper.flush();
			if (response.stopReason === "cancelled" || this.wasStopped) {
				this.finalizeError("OMP session cancelled", response.usage);
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

	async startStreaming(_initialPrompt?: string): Promise<OmpSessionInfo> {
		throw new Error("OmpRunner does not support streaming input");
	}

	addStreamMessage(_content: string): void {
		throw new Error("OmpRunner does not support streaming input messages");
	}

	completeStream(): void {
		// No-op: OmpRunner does not support streaming input.
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
				return this.decidePermission(params);
			},
		};
	}

	/**
	 * Decide a permission request against the rendered Cyrus tool policy.
	 *
	 * Allowed operations select `allow_once` (one-shot, never silent
	 * allow-always); denied or unknown operations select `reject_always`. A
	 * missing policy rejects everything (fail closed). There is deliberately no
	 * "ask the human" path: user approval can never widen the OS sandbox.
	 */
	private decidePermission(
		params: RequestPermissionRequest,
	): RequestPermissionResponse {
		const policy = this.config.ompPermissionPolicy;
		const operation = permissionOperationName(params.toolCall);
		const allowed = policy?.allowsTool(operation, toolDetail(params.toolCall));

		const options = params.options ?? [];
		if (allowed) {
			const allowOnce =
				options.find((option) => option.kind === "allow_once") ??
				options.find((option) => option.kind === "allow_always") ??
				options[0];
			if (!allowOnce) {
				return { outcome: { outcome: "cancelled" } };
			}
			return {
				outcome: { outcome: "selected", optionId: allowOnce.optionId },
			};
		}

		const rejectAlways =
			options.find((option) => option.kind === "reject_always") ??
			options.find((option) => option.kind === "reject_once") ??
			options[0];
		if (!rejectAlways) {
			return { outcome: { outcome: "cancelled" } };
		}
		return {
			outcome: { outcome: "selected", optionId: rejectAlways.optionId },
		};
	}

	// ---------- Capability validation ----------

	private validateCapabilities(init: InitializeResponse): void {
		const agentInfo = init.agentInfo;
		if (!agentInfo || agentInfo.name !== OMP_AGENT_NAME) {
			throw new Error(
				`OMP ACP handshake failed: expected agent name "${OMP_AGENT_NAME}", got "${agentInfo?.name ?? "unknown"}". Is the pinned omp binary on PATH?`,
			);
		}
		const caps = init.agentCapabilities;
		if (!caps?.loadSession || !caps?.sessionCapabilities?.resume) {
			throw new Error(
				"OMP ACP handshake failed: the agent does not advertise loadSession / session.resume, which Cyrus requires for deterministic resume.",
			);
		}
		const mcp = caps.mcpCapabilities;
		if (!mcp?.http && !mcp?.sse) {
			throw new Error(
				"OMP ACP handshake failed: the agent does not advertise MCP http/sse transport support, which the exact Session MCP catalog requires.",
			);
		}
	}

	// ---------- Internal helpers ----------

	private withPromptTimeout<T>(promise: Promise<T>): Promise<T> {
		const timeoutMs = this.config.ompPromptTimeoutMs ?? 20 * 60_000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(
					new Error(
						`OMP prompt timed out after ${Math.round(timeoutMs / 1000)}s`,
					),
				);
			}, timeoutMs);
		});
		return Promise.race([promise, timeout]).finally(() =>
			clearTimeout(timer),
		) as Promise<T>;
	}

	private emitInitMessage(): void {
		// Only ever emit system/init with the REAL OMP-assigned session id. On
		// error paths that never reached session/new (spawn failure, capability
		// validation, process exit), no init is emitted: a fabricated UUID would
		// be persisted as runnerSessionId and the next turn would try to resume
		// an id OMP never issued, wedging the session permanently.
		if (this.hasInitMessage || !this.hasRealSessionId) return;
		this.hasInitMessage = true;
		const sessionId = this.sessionInfo?.sessionId;
		if (!sessionId) return;
		const initMessage: AgentSystemInitMessage = {
			type: "system",
			subtype: "init",
			sessionId,
			model: this.config.model || "omp",
			tools: this.config.allowedTools || [],
			permissionMode: "always-ask",
			apiKeySource: "local",
		};
		this.pushMessage(initMessage);
	}

	private finalizeSuccess(
		_stopReason: PromptResponse["stopReason"],
		usage?: Usage | null,
	): void {
		// stopReason is diagnostic only; the neutral result carries text.
		const result: AgentResultMessage = {
			type: "result",
			subtype: "success",
			sessionId: this.sessionInfo?.sessionId || "pending",
			result: this.mapper.getLastAssistantText() || "OMP session completed",
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
	}

	private pushMessage(message: AgentMessage): void {
		this.messages.push(message);
		this.emit("message", message);
	}

	private teardownProcess(): void {
		const child = this.child;
		this.child = null;
		this.connection = null;
		if (child && !child.killed) {
			child.kill("SIGTERM");
		}
		// The generated overlay config (mode 0600, outside the worktree) is
		// session-scoped and never needed after the process exits. Best-effort
		// removal; the session state dir itself is retained for resume.
		if (this.config.ompOverlayConfigPath) {
			const overlay = this.config.ompOverlayConfigPath;
			void unlink(overlay).catch(() => {});
		}
	}

	private log(message: string): void {
		this.config.logger?.debug?.(message);
	}
}

/**
 * The policy-facing operation name for a permission request's tool call.
 *
 * Speaks the OMP permission vocabulary directly (kind names like `execute`,
 * `read`, `edit`, `search`, `fetch`) — the SAME vocabulary
 * `renderOmpToolPolicy` emits into the allow/deny sets. `other`/mcp calls fall
 * back to the real tool title (e.g. `mcp__linear__issue`). This is policy
 * matching only; timeline display still uses {@link toolNameFromKind}.
 */
export function permissionOperationName(toolCall: ToolCallUpdate): string {
	switch (toolCall.kind) {
		case "read":
			return "read";
		case "edit":
		case "delete":
			return "edit";
		case "move":
		case "execute":
			return "execute";
		case "search":
			return "search";
		case "fetch":
			return "fetch";
		case "think":
			return "think";
		default:
			return toolCall.title ?? "other";
	}
}

/** A short human detail (e.g. the Bash command) for policy diagnostics. */
export function toolDetail(toolCall: ToolCallUpdate): string {
	const input = toolCall.rawInput;
	if (input && typeof input === "object") {
		const command = (input as Record<string, unknown>).command;
		if (typeof command === "string") {
			return command.slice(0, 200);
		}
	}
	return toolCall.title ?? "";
}
