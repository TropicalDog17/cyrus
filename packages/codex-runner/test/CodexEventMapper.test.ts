import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentMessage } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { CodexEventMapper } from "../src/CodexEventMapper.js";

/**
 * Replay-style coverage for the ACP `session/update` → neutral `AgentMessage`
 * projection. Each test drives the mapper with a sequence of updates and asserts
 * the exact neutral messages it emits.
 */
function drive(updates: SessionUpdate[], finalFlush = true) {
	const emitted: AgentMessage[] = [];
	const mapper = new CodexEventMapper({
		getSessionId: () => "session-1",
		emit: (message) => emitted.push(message),
	});
	for (const update of updates) {
		mapper.handleUpdate(update);
	}
	if (finalFlush) mapper.flush();
	return { emitted, mapper };
}

describe("CodexEventMapper", () => {
	it("coalesces agent_message_chunk fragments into one assistant text message", () => {
		const { emitted, mapper } = drive([
			{
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Hello, " },
			},
			{
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "world" },
			},
		]);

		expect(emitted).toEqual([
			{
				type: "assistant",
				sessionId: "session-1",
				parentToolUseId: null,
				content: [{ type: "text", text: "Hello, world" }],
			},
		]);
		expect(mapper.getLastAssistantText()).toBe("Hello, world");
	});

	it("projects agent_thought_chunk as an assistant thinking block, before text", () => {
		const { emitted } = drive([
			{
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: "Let me think" },
			},
			{
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Done" },
			},
		]);

		expect(emitted).toEqual([
			{
				type: "assistant",
				sessionId: "session-1",
				parentToolUseId: null,
				content: [{ type: "thinking", thinking: "Let me think" }],
			},
			{
				type: "assistant",
				sessionId: "session-1",
				parentToolUseId: null,
				content: [{ type: "text", text: "Done" }],
			},
		]);
	});

	it("flushes the prior message when the messageId boundary changes", () => {
		const { emitted } = drive([
			{
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "first" },
				messageId: "m1",
			},
			{
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "second" },
				messageId: "m2",
			},
		]);

		expect(
			emitted.map((m) => (m.type === "assistant" ? m.content : null)),
		).toEqual([
			[{ type: "text", text: "first" }],
			[{ type: "text", text: "second" }],
		]);
	});

	it("emits a tool_use/tool_result pair for a tool_call + terminal update", () => {
		const { emitted } = drive([
			{
				sessionUpdate: "tool_call",
				toolCallId: "call-1",
				title: "Read file",
				kind: "read",
				status: "pending",
				rawInput: { path: "src/index.ts" },
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "call-1",
				status: "completed",
				content: [
					{ type: "content", content: { type: "text", text: "file body" } },
				],
			},
		]);

		expect(emitted).toEqual([
			{
				type: "assistant",
				sessionId: "session-1",
				parentToolUseId: null,
				content: [
					{
						type: "tool_use",
						id: "call-1",
						name: "Read",
						input: { path: "src/index.ts" },
					},
				],
			},
			{
				type: "user",
				sessionId: "session-1",
				parentToolUseId: "call-1",
				content: [
					{
						type: "tool_result",
						toolUseId: "call-1",
						isError: false,
						content: "file body",
					},
				],
			},
		]);
	});

	it("emits the tool_result inline when the tool_call arrives already completed", () => {
		const { emitted } = drive([
			{
				sessionUpdate: "tool_call",
				toolCallId: "call-2",
				title: "Run tests",
				kind: "execute",
				status: "failed",
				rawInput: { command: "pnpm test" },
				content: [{ type: "content", content: { type: "text", text: "boom" } }],
			},
		]);

		expect(emitted[0]).toMatchObject({
			type: "assistant",
			content: [{ type: "tool_use", id: "call-2", name: "Bash" }],
		});
		expect(emitted[1]).toEqual({
			type: "user",
			sessionId: "session-1",
			parentToolUseId: "call-2",
			content: [
				{
					type: "tool_result",
					toolUseId: "call-2",
					isError: true,
					content: "boom",
				},
			],
		});
	});

	it("does not emit a duplicate tool_result on a redundant completed update", () => {
		const { emitted } = drive([
			{
				sessionUpdate: "tool_call",
				toolCallId: "call-3",
				title: "Edit",
				kind: "edit",
				status: "completed",
				content: [
					{
						type: "diff",
						path: "a.ts",
						oldText: "old",
						newText: "new",
					},
				],
			},
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "call-3",
				status: "completed",
			},
		]);

		const toolResults = emitted.filter((m) => m.type === "user");
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({
			content: [{ content: "Edited a.ts\nnew" }],
		});
	});

	it("projects a plan update into a TodoWrite tool_use", () => {
		const { emitted } = drive([
			{
				sessionUpdate: "plan",
				entries: [
					{ content: "Investigate", priority: "high", status: "pending" },
					{ content: "Fix", priority: "medium", status: "in_progress" },
				],
			},
		]);

		expect(emitted).toEqual([
			{
				type: "assistant",
				sessionId: "session-1",
				parentToolUseId: null,
				content: [
					{
						type: "tool_use",
						id: "codex-plan-1",
						name: "TodoWrite",
						input: {
							todos: [
								{
									content: "Investigate",
									status: "pending",
									activeForm: "Investigate",
								},
								{
									content: "Fix",
									status: "in_progress",
									activeForm: "Fix",
								},
							],
						},
					},
				],
			},
		]);
	});
});
