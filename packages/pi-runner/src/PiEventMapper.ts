import type {
	AgentAssistantMessage,
	AgentMessage,
	AgentUsage,
	AgentUserMessage,
} from "cyrus-core";
import type { PiAssistantMessage, PiRpcEvent, PiUsage } from "./types.js";

export interface PiEventMapperOptions {
	getSessionId: () => string;
	emit: (message: AgentMessage) => void;
}

interface PiContentBlock {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
}

function contentBlocks(content: unknown): PiContentBlock[] {
	if (Array.isArray(content)) {
		return content.filter(
			(block): block is PiContentBlock =>
				Boolean(block) && typeof block === "object",
		);
	}
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	return [];
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function usageFromPi(usage?: PiUsage): AgentUsage {
	return {
		inputTokens: finite(usage?.input),
		outputTokens: finite(usage?.output),
		cacheReadTokens: finite(usage?.cacheRead),
		cacheWriteTokens: finite(usage?.cacheWrite),
		costUsd: finite(usage?.cost?.total),
	};
}

function addUsage(total: AgentUsage, next: AgentUsage): void {
	total.inputTokens += next.inputTokens;
	total.outputTokens += next.outputTokens;
	total.cacheReadTokens += next.cacheReadTokens;
	total.cacheWriteTokens += next.cacheWriteTokens;
	total.costUsd += next.costUsd;
}

function flattenResult(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const blocks = contentBlocks((result as { content?: unknown }).content);
	return blocks
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

/**
 * Projects Pi's documented JSONL RPC events into Cyrus's neutral message union.
 *
 * Text/thinking is emitted from complete `message_end` payloads. Tool activity
 * comes from `tool_execution_start`/`tool_execution_end`, preserving the
 * lifecycle that Linear's activity renderer needs.
 */
export class PiEventMapper {
	private lastAssistantText: string | null = null;
	private stopReason = "stop";
	private errorMessage: string | null = null;
	private readonly usage: AgentUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
	};

	constructor(private readonly opts: PiEventMapperOptions) {}

	getLastAssistantText(): string | null {
		return this.lastAssistantText;
	}

	getStopReason(): string {
		return this.stopReason;
	}

	getErrorMessage(): string | null {
		return this.errorMessage;
	}

	getUsage(): AgentUsage {
		return { ...this.usage };
	}

	handleEvent(event: PiRpcEvent): void {
		switch (event.type) {
			case "message_end":
				this.handleMessageEnd(event.message);
				return;
			case "turn_end":
				this.handleTurnEnd(event.message);
				return;
			case "tool_execution_start":
				this.handleToolStart(event);
				return;
			case "tool_execution_end":
				this.handleToolEnd(event);
				return;
			case "extension_error":
				if (typeof event.error === "string") this.errorMessage = event.error;
				return;
			default:
				return;
		}
	}

	private handleMessageEnd(rawMessage: unknown): void {
		if (!rawMessage || typeof rawMessage !== "object") return;
		const message = rawMessage as PiAssistantMessage;
		if (message.role !== "assistant") return;

		const thinking = contentBlocks(message.content)
			.map((block) =>
				block.type === "thinking" && typeof block.thinking === "string"
					? block.thinking
					: "",
			)
			.filter(Boolean)
			.join("");
		if (thinking.trim()) {
			this.pushAssistant([{ type: "thinking", thinking }]);
		}

		const text = contentBlocks(message.content)
			.map((block) =>
				block.type === "text" && typeof block.text === "string"
					? block.text
					: "",
			)
			.filter(Boolean)
			.join("");
		if (text.trim()) {
			this.lastAssistantText = text;
			this.pushAssistant([{ type: "text", text }]);
		}

		if (typeof message.stopReason === "string") {
			this.stopReason = message.stopReason;
		}
		if (typeof message.errorMessage === "string" && message.errorMessage) {
			this.errorMessage = message.errorMessage;
		}
	}

	private handleTurnEnd(rawMessage: unknown): void {
		if (!rawMessage || typeof rawMessage !== "object") return;
		const message = rawMessage as PiAssistantMessage;
		if (message.role !== "assistant") return;
		addUsage(this.usage, usageFromPi(message.usage));
		if (typeof message.stopReason === "string") {
			this.stopReason = message.stopReason;
		}
		if (typeof message.errorMessage === "string" && message.errorMessage) {
			this.errorMessage = message.errorMessage;
		}
	}

	private handleToolStart(event: PiRpcEvent): void {
		const id =
			typeof event.toolCallId === "string" ? event.toolCallId : "pi-tool";
		const rawName =
			typeof event.toolName === "string" ? event.toolName : "tool";
		const message: AgentAssistantMessage = {
			type: "assistant",
			sessionId: this.opts.getSessionId(),
			parentToolUseId: null,
			content: [
				{
					type: "tool_use",
					id,
					name: normalizePiToolName(rawName),
					input: event.args ?? {},
				},
			],
		};
		this.opts.emit(message);
	}

	private handleToolEnd(event: PiRpcEvent): void {
		const id =
			typeof event.toolCallId === "string" ? event.toolCallId : "pi-tool";
		const isError = event.isError === true;
		const content =
			flattenResult(event.result) ||
			(isError ? "Tool failed" : "Tool completed");
		const message: AgentUserMessage = {
			type: "user",
			sessionId: this.opts.getSessionId(),
			parentToolUseId: id,
			content: [
				{
					type: "tool_result",
					toolUseId: id,
					isError,
					content,
				},
			],
		};
		this.opts.emit(message);
	}

	private pushAssistant(content: AgentAssistantMessage["content"]): void {
		this.opts.emit({
			type: "assistant",
			sessionId: this.opts.getSessionId(),
			parentToolUseId: null,
			content,
		});
	}
}

/** Map Pi built-in names to the names understood by Cyrus activity formatters. */
export function normalizePiToolName(name: string): string {
	switch (name.toLowerCase()) {
		case "read":
			return "Read";
		case "write":
			return "Write";
		case "edit":
			return "Edit";
		case "bash":
			return "Bash";
		case "grep":
			return "Grep";
		case "find":
			return "Glob";
		case "ls":
			return "LS";
		default:
			return name;
	}
}
