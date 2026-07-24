import type { AgentMessage } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { PiEventMapper } from "../src/PiEventMapper.js";
import type { PiRpcEvent } from "../src/types.js";

/**
 * Replay coverage using the raw event shapes documented by Pi's RPC protocol.
 * Tool lifecycle pairs are asserted in full because dropping either side makes
 * actions/file edits disappear from the Linear timeline.
 */
function replay(events: PiRpcEvent[]) {
	const emitted: AgentMessage[] = [];
	const mapper = new PiEventMapper({
		getSessionId: () => "pi-session-1",
		emit: (message) => emitted.push(message),
	});
	for (const event of events) mapper.handleEvent(event);
	return { emitted, mapper };
}

describe("PiEventMapper", () => {
	it("projects complete thinking and text blocks from message_end", () => {
		const { emitted, mapper } = replay([
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Inspect first." },
						{ type: "text", text: "Done." },
					],
					stopReason: "stop",
				},
			},
		]);

		expect(emitted).toEqual([
			{
				type: "assistant",
				sessionId: "pi-session-1",
				parentToolUseId: null,
				content: [{ type: "thinking", thinking: "Inspect first." }],
			},
			{
				type: "assistant",
				sessionId: "pi-session-1",
				parentToolUseId: null,
				content: [{ type: "text", text: "Done." }],
			},
		]);
		expect(mapper.getLastAssistantText()).toBe("Done.");
	});

	it("projects tool start/end into a complete neutral lifecycle", () => {
		const { emitted } = replay([
			{
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "edit",
				args: { path: "src/index.ts", oldText: "a", newText: "b" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "edit",
				result: {
					content: [{ type: "text", text: "Updated src/index.ts" }],
					details: { patch: "@@ -1 +1 @@" },
				},
				isError: false,
			},
		]);

		expect(emitted).toEqual([
			{
				type: "assistant",
				sessionId: "pi-session-1",
				parentToolUseId: null,
				content: [
					{
						type: "tool_use",
						id: "call-1",
						name: "Edit",
						input: {
							path: "src/index.ts",
							oldText: "a",
							newText: "b",
						},
					},
				],
			},
			{
				type: "user",
				sessionId: "pi-session-1",
				parentToolUseId: "call-1",
				content: [
					{
						type: "tool_result",
						toolUseId: "call-1",
						isError: false,
						content: "Updated src/index.ts",
					},
				],
			},
		]);
	});

	it("accumulates turn usage and preserves an assistant error", () => {
		const { mapper } = replay([
			{
				type: "turn_end",
				message: {
					role: "assistant",
					usage: {
						input: 10,
						output: 3,
						cacheRead: 4,
						cacheWrite: 2,
						cost: { total: 0.02 },
					},
					stopReason: "toolUse",
				},
			},
			{
				type: "turn_end",
				message: {
					role: "assistant",
					usage: {
						input: 5,
						output: 2,
						cacheRead: 1,
						cacheWrite: 0,
						cost: { total: 0.01 },
					},
					stopReason: "error",
					errorMessage: "provider failed",
				},
			},
		]);

		expect(mapper.getUsage()).toEqual({
			inputTokens: 15,
			outputTokens: 5,
			cacheReadTokens: 5,
			cacheWriteTokens: 2,
			costUsd: 0.03,
		});
		expect(mapper.getStopReason()).toBe("error");
		expect(mapper.getErrorMessage()).toBe("provider failed");
	});
});
