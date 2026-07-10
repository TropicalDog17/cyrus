import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
	flattenToolResultContent,
	toAgentMessage,
} from "../src/claude-message-projection";

describe("toAgentMessage", () => {
	it("projects system/init into a neutral AgentSystemInitMessage", () => {
		const sdk = {
			type: "system",
			subtype: "init",
			session_id: "sess-1",
			model: "claude-opus",
			tools: ["Read", "Bash"],
			permissionMode: "default",
			apiKeySource: "user",
		} as unknown as SDKMessage;

		expect(toAgentMessage(sdk)).toEqual({
			type: "system",
			subtype: "init",
			sessionId: "sess-1",
			model: "claude-opus",
			tools: ["Read", "Bash"],
			permissionMode: "default",
			apiKeySource: "user",
		});
	});

	it("projects system/status into a neutral AgentStatusMessage", () => {
		const sdk = {
			type: "system",
			subtype: "status",
			status: "compacting",
			session_id: "sess-1",
		} as unknown as SDKMessage;

		expect(toAgentMessage(sdk)).toEqual({
			type: "system",
			subtype: "status",
			sessionId: "sess-1",
			status: "compacting",
		});
	});

	it("projects system/compact_boundary into a neutral AgentCompactBoundaryMessage", () => {
		const sdk = {
			type: "system",
			subtype: "compact_boundary",
			session_id: "sess-1",
			uuid: "cb-1",
			compact_metadata: {
				trigger: "auto",
				pre_tokens: 210418,
				post_tokens: 45210,
				duration_ms: 8123,
			},
		} as unknown as SDKMessage;

		expect(toAgentMessage(sdk)).toEqual({
			type: "system",
			subtype: "compact_boundary",
			sessionId: "sess-1",
			trigger: "auto",
			preTokens: 210418,
			postTokens: 45210,
			durationMs: 8123,
		});
	});

	it("omits post_tokens / duration_ms when the SDK does not report them", () => {
		const sdk = {
			type: "system",
			subtype: "compact_boundary",
			session_id: "sess-1",
			compact_metadata: { trigger: "manual", pre_tokens: 406100 },
		} as unknown as SDKMessage;

		expect(toAgentMessage(sdk)).toEqual({
			type: "system",
			subtype: "compact_boundary",
			sessionId: "sess-1",
			trigger: "manual",
			preTokens: 406100,
		});
	});

	it("still drops unknown system subtypes", () => {
		const sdk = {
			type: "system",
			subtype: "tool_use_summary",
			session_id: "sess-1",
		} as unknown as SDKMessage;

		expect(toAgentMessage(sdk)).toBeNull();
	});

	it("projects assistant text / thinking / tool_use blocks (thinking preserved)", () => {
		const sdk = {
			type: "assistant",
			session_id: "sess-1",
			parent_tool_use_id: "parent-1",
			message: {
				content: [
					{ type: "text", text: "Working on it" },
					{ type: "thinking", thinking: "let me reason" },
					{ type: "tool_use", id: "tu-1", name: "Read", input: { file: "a" } },
				],
			},
		} as unknown as SDKMessage;

		expect(toAgentMessage(sdk)).toEqual({
			type: "assistant",
			sessionId: "sess-1",
			parentToolUseId: "parent-1",
			content: [
				{ type: "text", text: "Working on it" },
				{ type: "thinking", thinking: "let me reason" },
				{ type: "tool_use", id: "tu-1", name: "Read", input: { file: "a" } },
			],
		});
	});

	it("carries the assistant error tag when present", () => {
		const sdk = {
			type: "assistant",
			session_id: "sess-1",
			parent_tool_use_id: null,
			error: "rate_limit",
			message: { content: [{ type: "text", text: "" }] },
		} as unknown as SDKMessage;

		const neutral = toAgentMessage(sdk);
		expect(neutral).toMatchObject({ type: "assistant", error: "rate_limit" });
	});

	it("projects a user tool_result with string content", () => {
		const sdk = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tu-1",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tu-1",
						is_error: false,
						content: "hello world",
					},
				],
			},
		} as unknown as SDKMessage;

		expect(toAgentMessage(sdk)).toEqual({
			type: "user",
			sessionId: "sess-1",
			parentToolUseId: "tu-1",
			content: [
				{
					type: "tool_result",
					toolUseId: "tu-1",
					isError: false,
					content: "hello world",
				},
			],
		});
	});

	it("flattens a tool_result content-array with text + tool_reference (ToolSearch)", () => {
		const sdk = {
			type: "user",
			session_id: "sess-1",
			parent_tool_use_id: "tu-1",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: "tu-1",
						is_error: true,
						content: [
							{ type: "text", text: "Loaded:" },
							{ type: "tool_reference", tool_name: "mcp__x__a" },
							{ type: "tool_reference", tool_name: "mcp__x__b" },
						],
					},
				],
			},
		} as unknown as SDKMessage;

		expect(toAgentMessage(sdk)).toEqual({
			type: "user",
			sessionId: "sess-1",
			parentToolUseId: "tu-1",
			content: [
				{
					type: "tool_result",
					toolUseId: "tu-1",
					isError: true,
					content: "Loaded:\nmcp__x__a\nmcp__x__b",
				},
			],
		});
	});

	it("projects result success with mapped neutral usage", () => {
		const sdk = {
			type: "result",
			subtype: "success",
			session_id: "sess-1",
			result: "all done",
			duration_ms: 1234,
			total_cost_usd: 0.42,
			usage: {
				input_tokens: 100,
				output_tokens: 50,
				cache_read_input_tokens: 20,
				cache_creation_input_tokens: 10,
			},
		} as unknown as SDKMessage;

		expect(toAgentMessage(sdk)).toEqual({
			type: "result",
			subtype: "success",
			sessionId: "sess-1",
			result: "all done",
			isError: false,
			durationMs: 1234,
			usage: {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 20,
				cacheWriteTokens: 10,
				costUsd: 0.42,
			},
		});
	});

	it("collapses any non-success result subtype into a neutral error", () => {
		const sdk = {
			type: "result",
			subtype: "error_during_execution",
			session_id: "sess-1",
			errors: ["boom"],
			duration_ms: 5,
			total_cost_usd: 0,
			usage: { input_tokens: 1, output_tokens: 1 },
		} as unknown as SDKMessage;

		expect(toAgentMessage(sdk)).toEqual({
			type: "result",
			subtype: "error",
			sessionId: "sess-1",
			errors: ["boom"],
			isError: true,
			durationMs: 5,
			usage: {
				inputTokens: 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0,
			},
		});
	});

	it("projects rate_limit_event into a neutral AgentRateLimitMessage", () => {
		const sdk = {
			type: "rate_limit_event",
			session_id: "sess-1",
			rate_limit_info: {
				status: "rejected",
				resetsAt: 1700000000,
				rateLimitType: "five_hour",
				utilization: 1.2,
			},
		} as unknown as SDKMessage;

		expect(toAgentMessage(sdk)).toEqual({
			type: "rate_limit",
			sessionId: "sess-1",
			info: {
				status: "rejected",
				resetsAt: 1700000000,
				rateLimitType: "five_hour",
				utilization: 1.2,
			},
		});
	});

	it.each([
		"stream_event",
		"tool_progress",
		"auth_status",
		"tool_use_summary",
		"prompt_suggestion",
		"start",
	])("returns null for informational SDK message type %s", (type) => {
		expect(
			toAgentMessage({ type, session_id: "sess-1" } as unknown as SDKMessage),
		).toBeNull();
	});
});

describe("flattenToolResultContent", () => {
	it("returns a string as-is", () => {
		expect(flattenToolResultContent("plain")).toBe("plain");
	});

	it("newline-joins text and tool_reference blocks, preserving tool names", () => {
		expect(
			flattenToolResultContent([
				{ type: "text", text: "a" },
				{ type: "tool_reference", tool_name: "b" },
				{ type: "image", data: "ignored" },
			]),
		).toBe("a\nb");
	});

	it("returns empty string for unexpected shapes", () => {
		expect(flattenToolResultContent(undefined)).toBe("");
		expect(flattenToolResultContent(42)).toBe("");
	});
});
