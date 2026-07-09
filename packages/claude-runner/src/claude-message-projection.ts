import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
	AgentAssistantContentBlock,
	AgentMessage,
	AgentUsage,
	AgentUserContentBlock,
} from "cyrus-core";

/**
 * Flatten an Anthropic tool_result block's `content` into the newline-joined
 * string the edge worker consumes.
 *
 * The block content is either a plain string or an array of nested blocks
 * (`{ type: "text", text }` or ToolSearch's `{ type: "tool_reference",
 * tool_name }`). The `tool_reference` tool_name MUST be preserved — the
 * ToolSearch "Loaded tools" activity render depends on the newline-joined
 * tool names. Previously this lived inline in
 * `AgentSessionManager.extractContent`; it now runs here so the neutral
 * `AgentToolResultBlock.content` is already the correct string.
 */
export function flattenToolResultContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((contentBlock: unknown) => {
				if (!contentBlock || typeof contentBlock !== "object") return "";
				const block = contentBlock as {
					type?: string;
					text?: string;
					tool_name?: string;
				};
				if (block.type === "text" && typeof block.text === "string") {
					return block.text;
				}
				// ToolSearch emits tool_reference blocks; preserve the tool name
				// so the formatter can render "Loaded tools: `X`, `Y`".
				if (block.type === "tool_reference" && block.tool_name) {
					return block.tool_name;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

/**
 * Map an Anthropic (NonNullableUsage-shaped) usage object to the neutral
 * {@link AgentUsage}. Nullable cache buckets coalesce to 0.
 */
function toAgentUsage(usage: unknown, totalCostUsd: number): AgentUsage {
	const u = (usage ?? {}) as {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number | null;
		cache_creation_input_tokens?: number | null;
	};
	return {
		inputTokens: u.input_tokens ?? 0,
		outputTokens: u.output_tokens ?? 0,
		cacheReadTokens: u.cache_read_input_tokens ?? 0,
		cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
		costUsd: totalCostUsd,
	};
}

/**
 * Project a Claude SDKMessage into a neutral cyrus-core {@link AgentMessage},
 * or `null` for informational SDK message types that have no neutral
 * equivalent (stream_event / tool_progress / auth_status / tool_use_summary /
 * prompt_suggestion and the other transport-level frames). Callers drop the
 * null results instead of emitting them.
 */
export function toAgentMessage(sdk: SDKMessage): AgentMessage | null {
	switch (sdk.type) {
		case "system": {
			if (sdk.subtype === "init") {
				return {
					type: "system",
					subtype: "init",
					sessionId: sdk.session_id,
					model: sdk.model,
					tools: sdk.tools,
					permissionMode: sdk.permissionMode,
					apiKeySource: sdk.apiKeySource,
				};
			}
			if (sdk.subtype === "status") {
				return {
					type: "system",
					subtype: "status",
					sessionId: sdk.session_id,
					status: sdk.status,
				};
			}
			return null;
		}

		case "assistant": {
			const rawContent = sdk.message?.content;
			const content: AgentAssistantContentBlock[] = [];
			if (Array.isArray(rawContent)) {
				for (const block of rawContent) {
					if (!block || typeof block !== "object") continue;
					const b = block as {
						type?: string;
						text?: string;
						thinking?: string;
						id?: string;
						name?: string;
						input?: unknown;
					};
					if (b.type === "text") {
						content.push({ type: "text", text: b.text ?? "" });
					} else if (b.type === "thinking") {
						content.push({ type: "thinking", thinking: b.thinking ?? "" });
					} else if (b.type === "tool_use") {
						content.push({
							type: "tool_use",
							id: b.id ?? "",
							name: b.name ?? "",
							input: b.input,
						});
					}
				}
			}
			return {
				type: "assistant",
				sessionId: sdk.session_id ?? "",
				parentToolUseId: sdk.parent_tool_use_id ?? null,
				content,
				...(sdk.error ? { error: sdk.error } : {}),
			};
		}

		case "user": {
			const rawContent = sdk.message?.content;
			const content: AgentUserContentBlock[] = [];
			if (typeof rawContent === "string") {
				content.push({ type: "text", text: rawContent });
			} else if (Array.isArray(rawContent)) {
				for (const block of rawContent) {
					if (!block || typeof block !== "object") continue;
					const b = block as {
						type?: string;
						text?: string;
						tool_use_id?: string;
						is_error?: boolean;
						content?: unknown;
					};
					if (b.type === "text") {
						content.push({ type: "text", text: b.text ?? "" });
					} else if (b.type === "tool_result") {
						content.push({
							type: "tool_result",
							toolUseId: b.tool_use_id ?? "",
							isError: b.is_error === true,
							content: flattenToolResultContent(b.content),
						});
					}
				}
			}
			return {
				type: "user",
				sessionId: sdk.session_id ?? "",
				parentToolUseId: sdk.parent_tool_use_id ?? null,
				content,
			};
		}

		case "result": {
			if (sdk.subtype === "success") {
				return {
					type: "result",
					subtype: "success",
					sessionId: sdk.session_id,
					result: sdk.result,
					isError: false,
					durationMs: sdk.duration_ms,
					usage: toAgentUsage(sdk.usage, sdk.total_cost_usd),
				};
			}
			// All non-success result subtypes collapse to the neutral "error".
			return {
				type: "result",
				subtype: "error",
				sessionId: sdk.session_id,
				errors: Array.isArray(sdk.errors) ? sdk.errors : [],
				isError: true,
				durationMs: sdk.duration_ms,
				usage: toAgentUsage(sdk.usage, sdk.total_cost_usd),
			};
		}

		case "rate_limit_event": {
			const info = sdk.rate_limit_info;
			return {
				type: "rate_limit",
				sessionId: sdk.session_id,
				info: {
					status: info.status,
					resetsAt: info.resetsAt,
					rateLimitType: info.rateLimitType,
					utilization: info.utilization,
				},
			};
		}

		default:
			// Informational / transport-level SDK messages with no neutral
			// equivalent (stream_event, tool_progress, auth_status,
			// tool_use_summary, prompt_suggestion, compact boundary, etc.).
			return null;
	}
}
