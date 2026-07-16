import type {
	ContentBlock,
	Plan,
	SessionUpdate,
	ToolCall,
	ToolCallContent,
	ToolCallUpdate,
	ToolKind,
} from "@agentclientprotocol/sdk";
import type {
	AgentAssistantMessage,
	AgentMessage,
	AgentUserMessage,
} from "cyrus-core";

export interface CodexEventMapperOptions {
	/** Resolve the current runner session id for stamping emitted messages. */
	getSessionId: () => string;
	/** Sink for projected neutral messages (runner pushes them onto its stream). */
	emit: (message: AgentMessage) => void;
}

interface TrackedToolCall {
	name: string;
	input: unknown;
	resultEmitted: boolean;
}

/**
 * Projects ACP `session/update` notifications into the neutral
 * {@link AgentMessage} stream Cyrus consumes.
 *
 * ACP streams assistant text and reasoning as incremental chunks, and tool
 * calls as a `tool_call` (creation) followed by one or more `tool_call_update`
 * (status/output) notifications. This mapper coalesces the chunk streams into
 * whole assistant messages and correlates tool-call updates back to their
 * originating call so a `tool_use`/`tool_result` pair is emitted per tool.
 */
export class CodexEventMapper {
	private textBuffer = "";
	private textMessageId: string | null = null;
	private thoughtBuffer = "";
	private thoughtMessageId: string | null = null;
	private readonly toolCalls = new Map<string, TrackedToolCall>();
	private lastAssistantText: string | null = null;
	private planCounter = 0;

	constructor(private readonly opts: CodexEventMapperOptions) {}

	/** The most recent flushed assistant text, used to build the result message. */
	getLastAssistantText(): string | null {
		return this.lastAssistantText;
	}

	/** Route a single ACP session update to its projection handler. */
	handleUpdate(update: SessionUpdate): void {
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				this.appendText(textFromContentBlock(update.content), update.messageId);
				return;
			case "agent_thought_chunk":
				this.appendThought(
					textFromContentBlock(update.content),
					update.messageId,
				);
				return;
			case "tool_call":
				this.flush();
				this.handleToolCall(update);
				return;
			case "tool_call_update":
				this.flush();
				this.handleToolCallUpdate(update);
				return;
			case "plan":
				this.flush();
				this.handlePlan(update);
				return;
			default:
				// user_message_chunk (echoed prompt), plan_update/removed, mode/config
				// updates, usage — not projected into the timeline here.
				return;
		}
	}

	/** Emit any buffered assistant reasoning/text as discrete messages. */
	flush(): void {
		const thought = this.thoughtBuffer;
		this.thoughtBuffer = "";
		this.thoughtMessageId = null;
		if (thought.trim().length > 0) {
			this.pushAssistant([{ type: "thinking", thinking: thought }]);
		}

		const text = this.textBuffer;
		this.textBuffer = "";
		this.textMessageId = null;
		if (text.trim().length > 0) {
			this.lastAssistantText = text;
			this.pushAssistant([{ type: "text", text }]);
		}
	}

	private appendText(text: string, messageId?: string | null): void {
		if (!text) return;
		if (
			this.textMessageId !== null &&
			messageId != null &&
			messageId !== this.textMessageId &&
			this.textBuffer.length > 0
		) {
			// A new message started — flush the previous one before appending.
			const prev = this.textBuffer;
			this.textBuffer = "";
			this.lastAssistantText = prev;
			this.pushAssistant([{ type: "text", text: prev }]);
		}
		if (messageId != null) this.textMessageId = messageId;
		this.textBuffer += text;
	}

	private appendThought(text: string, messageId?: string | null): void {
		if (!text) return;
		if (
			this.thoughtMessageId !== null &&
			messageId != null &&
			messageId !== this.thoughtMessageId &&
			this.thoughtBuffer.length > 0
		) {
			const prev = this.thoughtBuffer;
			this.thoughtBuffer = "";
			this.pushAssistant([{ type: "thinking", thinking: prev }]);
		}
		if (messageId != null) this.thoughtMessageId = messageId;
		this.thoughtBuffer += text;
	}

	private handleToolCall(update: ToolCall): void {
		const name = toolNameFromKind(update.kind, update.title);
		const input = normalizeToolInput(update.rawInput, update.title);
		const tracked: TrackedToolCall = { name, input, resultEmitted: false };
		this.toolCalls.set(update.toolCallId, tracked);
		this.pushToolUse(update.toolCallId, name, input);

		// Some tool calls arrive already terminal with their output attached. Mark
		// the result as emitted so a later redundant `completed` update for the
		// same call does not double-post the tool_result.
		if (update.status === "completed" || update.status === "failed") {
			this.emitToolResult(
				update.toolCallId,
				flattenToolContent(update.content),
				update.status === "failed",
			);
			tracked.resultEmitted = true;
		}
	}

	private handleToolCallUpdate(update: ToolCallUpdate): void {
		let tracked = this.toolCalls.get(update.toolCallId);
		if (!tracked) {
			// Update arrived without a preceding creation — synthesize the tool_use.
			const name = toolNameFromKind(
				update.kind ?? undefined,
				update.title ?? undefined,
			);
			const input = normalizeToolInput(update.rawInput, update.title);
			tracked = { name, input, resultEmitted: false };
			this.toolCalls.set(update.toolCallId, tracked);
			this.pushToolUse(update.toolCallId, name, input);
		}

		if (
			(update.status === "completed" || update.status === "failed") &&
			!tracked.resultEmitted
		) {
			this.emitToolResult(
				update.toolCallId,
				flattenToolContent(update.content),
				update.status === "failed",
			);
			tracked.resultEmitted = true;
		}
	}

	private handlePlan(plan: Plan): void {
		const todos = plan.entries.map((entry) => ({
			content: entry.content,
			status: entry.status,
			activeForm: entry.content,
		}));
		// Project the plan as a TodoWrite tool_use so it renders as a checklist in
		// the Linear timeline, mirroring how the Claude runner surfaces plans.
		this.planCounter += 1;
		this.pushToolUse(`codex-plan-${this.planCounter}`, "TodoWrite", { todos });
	}

	private emitToolResult(
		toolCallId: string,
		result: string,
		isError: boolean,
	): void {
		const message: AgentUserMessage = {
			type: "user",
			sessionId: this.opts.getSessionId(),
			parentToolUseId: toolCallId,
			content: [
				{
					type: "tool_result",
					toolUseId: toolCallId,
					isError,
					content: result || (isError ? "Tool failed" : "Tool completed"),
				},
			],
		};
		this.opts.emit(message);
	}

	private pushToolUse(id: string, name: string, input: unknown): void {
		this.pushAssistant([{ type: "tool_use", id, name, input }]);
	}

	private pushAssistant(content: AgentAssistantMessage["content"]): void {
		const message: AgentAssistantMessage = {
			type: "assistant",
			sessionId: this.opts.getSessionId(),
			parentToolUseId: null,
			content,
		};
		this.opts.emit(message);
	}
}

/** Extract displayable text from an ACP content block. */
export function textFromContentBlock(block: ContentBlock): string {
	if (!block || typeof block !== "object") return "";
	if (block.type === "text") return block.text ?? "";
	if (block.type === "resource_link") return block.uri ?? block.name ?? "";
	if (block.type === "resource") {
		const resource = block.resource as { text?: string } | undefined;
		return typeof resource?.text === "string" ? resource.text : "";
	}
	return "";
}

/**
 * Map an ACP tool kind to a Cyrus/Claude-style tool name so the timeline picks
 * appropriate rendering. Falls back to the tool's human-readable title, then a
 * generic label.
 */
export function toolNameFromKind(
	kind?: ToolKind,
	title?: string | null,
): string {
	switch (kind) {
		case "read":
			return "Read";
		case "edit":
			return "Edit";
		case "delete":
			return "Edit";
		case "move":
			return "Bash";
		case "search":
			return "Grep";
		case "execute":
			return "Bash";
		case "fetch":
			return "WebFetch";
		case "think":
			return "Task";
		default:
			return title?.trim() || "Tool";
	}
}

/** Coerce ACP `rawInput` into an object; fall back to the title as a label. */
export function normalizeToolInput(
	rawInput: unknown,
	title?: string | null,
): unknown {
	if (rawInput && typeof rawInput === "object") return rawInput;
	if (title?.trim()) return { title };
	return {};
}

/** Flatten an ACP tool-call content array into a single result string. */
export function flattenToolContent(content?: ToolCallContent[] | null): string {
	if (!content || content.length === 0) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		if (item.type === "content") {
			parts.push(textFromContentBlock(item.content));
		} else if (item.type === "diff") {
			const header =
				item.oldText != null ? `Edited ${item.path}` : `Created ${item.path}`;
			parts.push(`${header}\n${item.newText}`);
		} else if (item.type === "terminal") {
			parts.push(`[terminal ${item.terminalId}]`);
		}
	}
	return parts.filter((part) => part.length > 0).join("\n");
}
