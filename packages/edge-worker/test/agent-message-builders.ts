/**
 * Neutral AgentMessage builders for AgentSessionManager tests.
 *
 * Phase B replaced the SDK-shaped `AgentMessage = SDKMessage` alias with a
 * genuinely neutral discriminated union. These helpers build the neutral shape
 * so tests exercise the same messages the runners now emit (via their
 * projection layers) rather than raw Claude SDK objects.
 */
import type {
	AgentAssistantContentBlock,
	AgentAssistantMessage,
	AgentCompactBoundaryMessage,
	AgentRateLimitInfo,
	AgentRateLimitMessage,
	AgentResultMessage,
	AgentStatusMessage,
	AgentSystemInitMessage,
	AgentUsage,
	AgentUserContentBlock,
	AgentUserMessage,
} from "cyrus-core";

export const zeroUsage: AgentUsage = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costUsd: 0,
};

export function systemInitMessage(
	overrides: Partial<AgentSystemInitMessage> = {},
): AgentSystemInitMessage {
	return {
		type: "system",
		subtype: "init",
		sessionId: "claude-session",
		model: "claude-opus-4-6",
		tools: ["Bash"],
		permissionMode: "allowed_tools",
		apiKeySource: "claude_desktop",
		...overrides,
	};
}

export function statusMessage(
	status: AgentStatusMessage["status"],
	sessionId = "claude-session",
): AgentStatusMessage {
	return { type: "system", subtype: "status", sessionId, status };
}

export function compactBoundaryMessage(
	overrides: Partial<AgentCompactBoundaryMessage> = {},
): AgentCompactBoundaryMessage {
	return {
		type: "system",
		subtype: "compact_boundary",
		sessionId: "claude-session",
		trigger: "auto",
		preTokens: 210418,
		postTokens: 45210,
		...overrides,
	};
}

export function assistantMessage(
	content: AgentAssistantContentBlock[],
	overrides: Partial<AgentAssistantMessage> = {},
): AgentAssistantMessage {
	return {
		type: "assistant",
		sessionId: "claude-session",
		parentToolUseId: null,
		content,
		...overrides,
	};
}

export function assistantText(
	text: string,
	overrides: Partial<AgentAssistantMessage> = {},
): AgentAssistantMessage {
	return assistantMessage([{ type: "text", text }], overrides);
}

export function assistantThinking(
	thinking: string,
	overrides: Partial<AgentAssistantMessage> = {},
): AgentAssistantMessage {
	return assistantMessage([{ type: "thinking", thinking }], overrides);
}

export function assistantToolUse(
	id: string,
	name: string,
	input: unknown,
	overrides: Partial<AgentAssistantMessage> = {},
): AgentAssistantMessage {
	return assistantMessage([{ type: "tool_use", id, name, input }], overrides);
}

export function userMessage(
	content: AgentUserContentBlock[],
	overrides: Partial<AgentUserMessage> = {},
): AgentUserMessage {
	return {
		type: "user",
		sessionId: "claude-session",
		parentToolUseId: null,
		content,
		...overrides,
	};
}

export function userText(
	text: string,
	overrides: Partial<AgentUserMessage> = {},
): AgentUserMessage {
	return userMessage([{ type: "text", text }], overrides);
}

export function userToolResult(
	toolUseId: string,
	content: string,
	isError = false,
	overrides: Partial<AgentUserMessage> = {},
): AgentUserMessage {
	return userMessage([{ type: "tool_result", toolUseId, isError, content }], {
		parentToolUseId: toolUseId,
		...overrides,
	});
}

export function resultSuccess(
	result: string,
	overrides: Partial<AgentResultMessage> = {},
): AgentResultMessage {
	return {
		type: "result",
		subtype: "success",
		sessionId: "claude-session",
		result,
		isError: false,
		durationMs: 0,
		usage: zeroUsage,
		...overrides,
	} as AgentResultMessage;
}

export function resultError(
	errors: string[],
	overrides: Partial<AgentResultMessage> = {},
): AgentResultMessage {
	return {
		type: "result",
		subtype: "error",
		sessionId: "claude-session",
		errors,
		isError: true,
		durationMs: 0,
		usage: zeroUsage,
		...overrides,
	} as AgentResultMessage;
}

export function rateLimitMessage(
	info: AgentRateLimitInfo,
	sessionId = "claude-session",
): AgentRateLimitMessage {
	return { type: "rate_limit", sessionId, info };
}
