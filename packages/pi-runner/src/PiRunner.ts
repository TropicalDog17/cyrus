import type { ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { resolve } from "node:path";
import type {
	AgentMessage,
	AgentResultMessage,
	AgentSystemInitMessage,
	IAgentRunner,
} from "cyrus-core";
import { PiEventMapper } from "./PiEventMapper.js";
import { spawnPi } from "./piProcess.js";
import type {
	PiRpcEvent,
	PiRpcResponse,
	PiRunnerConfig,
	PiRunnerEvents,
	PiSessionInfo,
} from "./types.js";

interface PendingCommand {
	resolve: (response: PiRpcResponse) => void;
	reject: (error: Error) => void;
}

function normalizeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "Pi execution failed";
}

function stateSessionId(data: unknown): string | null {
	if (!data || typeof data !== "object") return null;
	const sessionId = (data as { sessionId?: unknown }).sessionId;
	return typeof sessionId === "string" && sessionId.length > 0
		? sessionId
		: null;
}

function stateModel(data: unknown): string | null {
	if (!data || typeof data !== "object") return null;
	const model = (data as { model?: unknown }).model;
	if (!model || typeof model !== "object") return null;
	const provider =
		typeof (model as { provider?: unknown }).provider === "string"
			? (model as { provider: string }).provider
			: null;
	const id =
		typeof (model as { id?: unknown }).id === "string"
			? (model as { id: string }).id
			: null;
	if (provider && id) return `${provider}/${id}`;
	return id;
}

export declare interface PiRunner {
	on<K extends keyof PiRunnerEvents>(
		event: K,
		listener: PiRunnerEvents[K],
	): this;
	emit<K extends keyof PiRunnerEvents>(
		event: K,
		...args: Parameters<PiRunnerEvents[K]>
	): boolean;
}

/**
 * Drives Pi through its official JSONL RPC mode.
 *
 * Pi accepts steering prompts while a turn is active, so this runner advertises
 * streaming input and maps Cyrus follow-up comments to `streamingBehavior:
 * "steer"`. Completion is keyed to `agent_settled`, not `agent_end`, because Pi
 * may still auto-retry, compact, or process queued continuations after a
 * low-level run ends.
 */
export class PiRunner extends EventEmitter implements IAgentRunner {
	readonly supportsStreamingInput = true;
	readonly provider = "pi" as const;

	private readonly config: PiRunnerConfig;
	private sessionInfo: PiSessionInfo | null = null;
	private messages: AgentMessage[] = [];
	private child: ChildProcessWithoutNullStreams | null = null;
	private mapper: PiEventMapper;
	private pendingCommands = new Map<string, PendingCommand>();
	private stdoutBuffer = "";
	private commandCounter = 0;
	private turnCount = 0;
	private startTimestampMs = 0;
	private finalized = false;
	private wasStopped = false;
	private turnLimitExceeded = false;
	private logStream: WriteStream | null = null;
	private completionPromise: Promise<PiSessionInfo> | null = null;
	private resolveCompletion: ((info: PiSessionInfo) => void) | null = null;

	constructor(config: PiRunnerConfig) {
		super();
		this.config = config;
		this.mapper = this.createMapper();

		if (config.onMessage) this.on("message", config.onMessage);
		if (config.onError) this.on("error", config.onError);
		if (config.onComplete) this.on("complete", config.onComplete);
	}

	async start(prompt: string): Promise<PiSessionInfo> {
		return this.startProcess(prompt);
	}

	async startStreaming(initialPrompt?: string): Promise<PiSessionInfo> {
		return this.startProcess(initialPrompt ?? "");
	}

	addStreamMessage(content: string): void {
		if (!this.isRunning() || !this.child) {
			throw new Error("Cannot steer a Pi session that is not running");
		}
		void this.sendCommand({
			type: "prompt",
			message: content,
			streamingBehavior: "steer",
		}).catch((error) => {
			this.config.logger?.warn(
				`Pi rejected streaming prompt: ${normalizeError(error)}`,
			);
		});
	}

	completeStream(): void {
		// Pi settles and exits under runner control after all queued work completes.
	}

	isStreaming(): boolean {
		return this.isRunning();
	}

	isWarm(): boolean {
		return false;
	}

	stop(): void {
		if (this.finalized) return;
		this.wasStopped = true;
		if (this.child?.stdin.writable) {
			void this.sendCommand({ type: "abort" }).catch(() => {});
		}
		this.finishError("Pi session cancelled");
	}

	isRunning(): boolean {
		return this.sessionInfo?.isRunning ?? false;
	}

	getMessages(): AgentMessage[] {
		return [...this.messages];
	}

	private async startProcess(prompt: string): Promise<PiSessionInfo> {
		if (this.isRunning()) throw new Error("Pi session already running");

		const provisionalId = this.config.resumeSessionId || crypto.randomUUID();
		this.sessionInfo = {
			sessionId: provisionalId,
			startedAt: new Date(),
			isRunning: true,
		};
		this.messages = [];
		this.mapper = this.createMapper();
		this.pendingCommands.clear();
		this.stdoutBuffer = "";
		this.turnCount = 0;
		this.startTimestampMs = Date.now();
		this.finalized = false;
		this.wasStopped = false;
		this.turnLimitExceeded = false;
		this.setupLogging(provisionalId);
		this.completionPromise = new Promise((resolveCompletion) => {
			this.resolveCompletion = resolveCompletion;
		});

		if (process.env.CYRUS_PI_MOCK === "1") {
			this.emitInitMessage(this.config.model || "pi/default");
			this.mapper.handleEvent({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Pi mock session completed" }],
					stopReason: "stop",
				},
			});
			this.finishSuccess();
			return this.sessionInfo;
		}

		try {
			const child = spawnPi(this.config);
			this.child = child;
			this.attachProcess(child);

			const state = await this.sendCommand({ type: "get_state" });
			const piSessionId = stateSessionId(state.data);
			if (piSessionId && this.sessionInfo) {
				this.sessionInfo.sessionId = piSessionId;
			}
			this.emitInitMessage(
				stateModel(state.data) || this.config.model || "pi/default",
			);

			await this.sendCommand({ type: "prompt", message: prompt });
			return await this.completionPromise;
		} catch (error) {
			this.finishError(normalizeError(error));
			return this.sessionInfo;
		}
	}

	private attachProcess(child: ChildProcessWithoutNullStreams): void {
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.log(`[stderr] ${chunk.trimEnd()}`);
		});

		child.on("error", (error) => {
			if (!this.finalized) this.finishError(error.message);
		});
		child.on("close", (code, signal) => {
			if (!this.finalized) {
				const suffix = signal ? ` (signal ${signal})` : ` (exit ${code})`;
				this.finishError(`Pi process exited before agent_settled${suffix}`);
			}
		});
	}

	private handleStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		for (;;) {
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline === -1) return;
			let line = this.stdoutBuffer.slice(0, newline);
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.trim()) this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		this.log(line);
		let payload: unknown;
		try {
			payload = JSON.parse(line);
		} catch {
			this.config.logger?.warn("Ignoring malformed Pi RPC JSONL record");
			return;
		}
		if (!payload || typeof payload !== "object") return;

		const record = payload as Record<string, unknown>;
		if (record.type === "response") {
			this.handleResponse(record as unknown as PiRpcResponse);
			return;
		}

		const event = record as PiRpcEvent;
		this.mapper.handleEvent(event);
		if (
			event.type === "turn_start" &&
			this.config.maxTurns !== undefined &&
			this.turnCount >= this.config.maxTurns
		) {
			this.turnLimitExceeded = true;
			void this.sendCommand({ type: "abort" }).catch(() => {});
		}
		if (event.type === "turn_end") {
			this.turnCount += 1;
		}
		if (event.type === "agent_settled") {
			if (this.turnLimitExceeded) {
				this.finishError(
					`Pi session exceeded maxTurns (${this.config.maxTurns})`,
				);
			} else if (this.wasStopped) {
				this.finishError("Pi session cancelled");
			} else if (this.mapper.getErrorMessage()) {
				this.finishError(this.mapper.getErrorMessage() as string);
			} else {
				this.finishSuccess();
			}
		}
	}

	private handleResponse(response: PiRpcResponse): void {
		if (!response.id) return;
		const pending = this.pendingCommands.get(response.id);
		if (!pending) return;
		this.pendingCommands.delete(response.id);
		if (response.success) {
			pending.resolve(response);
		} else {
			pending.reject(
				new Error(response.error || `Pi ${response.command} command failed`),
			);
		}
	}

	private sendCommand(
		command: Record<string, unknown>,
	): Promise<PiRpcResponse> {
		const child = this.child;
		if (!child?.stdin.writable) {
			return Promise.reject(new Error("Pi RPC stdin is not writable"));
		}
		this.commandCounter += 1;
		const id = `cyrus-${this.commandCounter}`;
		return new Promise((resolveCommand, rejectCommand) => {
			this.pendingCommands.set(id, {
				resolve: resolveCommand,
				reject: rejectCommand,
			});
			child.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
				if (!error) return;
				this.pendingCommands.delete(id);
				rejectCommand(error);
			});
		});
	}

	private createMapper(): PiEventMapper {
		return new PiEventMapper({
			getSessionId: () => this.sessionInfo?.sessionId || "pending",
			emit: (message) => this.pushMessage(message),
		});
	}

	private emitInitMessage(model: string): void {
		const init: AgentSystemInitMessage = {
			type: "system",
			subtype: "init",
			sessionId: this.sessionInfo?.sessionId || "pending",
			model,
			tools: this.config.allowedTools || [],
			permissionMode: "default",
			apiKeySource: "project",
		};
		this.pushMessage(init);
	}

	private finishSuccess(): void {
		const result: AgentResultMessage = {
			type: "result",
			subtype: "success",
			sessionId: this.sessionInfo?.sessionId || "pending",
			result: this.mapper.getLastAssistantText() || "Pi session completed",
			isError: false,
			durationMs: Math.max(Date.now() - this.startTimestampMs, 0),
			usage: this.mapper.getUsage(),
		};
		this.finalize(result);
	}

	private finishError(message: string): void {
		if (this.finalized) return;
		const result: AgentResultMessage = {
			type: "result",
			subtype: "error",
			sessionId: this.sessionInfo?.sessionId || "pending",
			errors: [message],
			isError: true,
			durationMs: Math.max(Date.now() - this.startTimestampMs, 0),
			usage: this.mapper.getUsage(),
		};
		this.finalize(result, new Error(message));
	}

	private finalize(result: AgentResultMessage, error?: Error): void {
		if (this.finalized) return;
		this.finalized = true;
		if (this.sessionInfo) this.sessionInfo.isRunning = false;
		this.pushMessage(result);
		this.emit("complete", [...this.messages]);
		if (error) this.emit("error", error);

		for (const pending of this.pendingCommands.values()) {
			pending.reject(error || new Error("Pi session completed"));
		}
		this.pendingCommands.clear();

		const child = this.child;
		this.child = null;
		if (child && !child.killed) child.kill();
		this.closeLog();
		if (this.sessionInfo) this.resolveCompletion?.(this.sessionInfo);
		this.resolveCompletion = null;
	}

	private pushMessage(message: AgentMessage): void {
		this.messages.push(message);
		this.emit("message", message);
	}

	private setupLogging(sessionId: string): void {
		try {
			const logsDir = resolve(this.config.cyrusHome, "logs");
			mkdirSync(logsDir, { recursive: true });
			this.logStream = createWriteStream(
				resolve(logsDir, `pi-${sessionId}.jsonl`),
				{ flags: "a" },
			);
			this.logStream.on("error", () => {});
		} catch {
			this.logStream = null;
		}
	}

	private log(line: string): void {
		try {
			this.logStream?.write(`${line}\n`);
		} catch {}
	}

	private closeLog(): void {
		try {
			this.logStream?.end();
		} catch {}
		this.logStream = null;
	}
}
