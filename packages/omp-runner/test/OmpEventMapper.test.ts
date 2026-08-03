/**
 * Replay tests for the OMP ACP event mapper: representative `session/update`
 * frames from an OMP ACP session project into the neutral AgentMessage stream.
 */

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentMessage } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	flattenToolContent,
	OmpEventMapper,
	textFromContentBlock,
	toolNameFromKind,
} from "../src/OmpEventMapper.js";

function mapperWith(): { mapper: OmpEventMapper; messages: AgentMessage[] } {
	const messages: AgentMessage[] = [];
	const mapper = new OmpEventMapper({
		getSessionId: () => "omp-sess-1",
		emit: (message) => messages.push(message),
	});
	return { mapper, messages };
}

describe("OmpEventMapper", () => {
	it("coalesces text chunks into one assistant text message", () => {
		const { mapper, messages } = mapperWith();
		mapper.handleUpdate({
			sessionUpdate: "agent_message_chunk",
			messageId: "m1",
			content: { type: "text", text: "Hello " },
		});
		mapper.handleUpdate({
			sessionUpdate: "agent_message_chunk",
			messageId: "m1",
			content: { type: "text", text: "world" },
		});
		mapper.flush();

		expect(messages).toEqual([
			{
				type: "assistant",
				sessionId: "omp-sess-1",
				parentToolUseId: null,
				content: [{ type: "text", text: "Hello world" }],
			},
		]);
	});

	it("projects thinking chunks as a thinking block", () => {
		const { mapper, messages } = mapperWith();
		mapper.handleUpdate({
			sessionUpdate: "agent_thought_chunk",
			messageId: "t1",
			content: { type: "text", text: "Let me think" },
		});
		mapper.flush();

		expect(messages).toEqual([
			{
				type: "assistant",
				sessionId: "omp-sess-1",
				parentToolUseId: null,
				content: [{ type: "thinking", thinking: "Let me think" }],
			},
		]);
	});

	it("projects a tool_call + completed tool_call_update as tool_use + tool_result", () => {
		const { mapper, messages } = mapperWith();
		mapper.handleUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "tc-1",
			kind: "execute",
			title: "Run command",
			rawInput: { command: "ls -la" },
			status: "pending",
		});
		mapper.handleUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-1",
			kind: "execute",
			status: "completed",
			content: [
				{ type: "content", content: { type: "text", text: "total 8" } },
			],
		});

		expect(messages).toEqual([
			{
				type: "assistant",
				sessionId: "omp-sess-1",
				parentToolUseId: null,
				content: [
					{
						type: "tool_use",
						id: "tc-1",
						name: "Bash",
						input: { command: "ls -la" },
					},
				],
			},
			{
				type: "user",
				sessionId: "omp-sess-1",
				parentToolUseId: "tc-1",
				content: [
					{
						type: "tool_result",
						toolUseId: "tc-1",
						isError: false,
						content: "total 8",
					},
				],
			},
		]);
	});

	it("does not double-post a result for a terminal tool_call followed by its update", () => {
		const { mapper, messages } = mapperWith();
		mapper.handleUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "tc-2",
			kind: "read",
			title: "Read",
			rawInput: { path: "/tmp/a.txt" },
			status: "completed",
			content: [
				{ type: "content", content: { type: "text", text: "file body" } },
			],
		});
		mapper.handleUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-2",
			status: "completed",
			content: [
				{ type: "content", content: { type: "text", text: "file body" } },
			],
		});

		const toolResults = messages.filter((m) => m.type === "user");
		expect(toolResults).toHaveLength(1);
	});

	it("synthesizes a tool_use when only a tool_call_update arrives", () => {
		const { mapper, messages } = mapperWith();
		mapper.handleUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-3",
			kind: "mcp",
			title: "mcp__linear__issue",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "ok" } }],
		});

		expect(messages[0]).toMatchObject({
			type: "assistant",
			content: [
				{
					type: "tool_use",
					id: "tc-3",
					name: "mcp__linear__issue",
				},
			],
		});
		expect(messages[1]).toMatchObject({
			type: "user",
			content: [{ type: "tool_result", toolUseId: "tc-3", content: "ok" }],
		});
	});

	it("projects a plan as a TodoWrite tool_use", () => {
		const { mapper, messages } = mapperWith();
		mapper.handleUpdate({
			sessionUpdate: "plan",
			planId: "plan-1",
			title: "Fix the bug",
			entries: [
				{ content: "Reproduce", status: "completed", priority: 0 },
				{ content: "Patch", status: "pending", priority: 1 },
			],
		} as unknown as SessionUpdate);

		expect(messages[0]).toMatchObject({
			type: "assistant",
			content: [
				{
					type: "tool_use",
					name: "TodoWrite",
					input: {
						todos: [
							{ content: "Reproduce", status: "completed" },
							{ content: "Patch", status: "pending" },
						],
					},
				},
			],
		});
	});

	it("normalizes OMP tool kinds and retains unknown tool names", () => {
		expect(toolNameFromKind("read")).toBe("Read");
		expect(toolNameFromKind("edit")).toBe("Edit");
		expect(toolNameFromKind("execute")).toBe("Bash");
		expect(toolNameFromKind("search")).toBe("Grep");
		expect(toolNameFromKind("think", "Think")).toBe("Think");
		// MCP tools keep their real names.
		expect(toolNameFromKind("mcp", "mcp__linear__issue")).toBe(
			"mcp__linear__issue",
		);
		// Unknown kinds fall back to the title, never a generic label.
		expect(toolNameFromKind("teleport", "SomeWeirdTool")).toBe("SomeWeirdTool");
	});

	it("flattens tool content and extracts text blocks", () => {
		expect(textFromContentBlock({ type: "text", text: "hi" })).toBe("hi");
		expect(
			flattenToolContent([
				{ type: "content", content: { type: "text", text: "a" } },
				{ type: "terminal", terminalId: "t1" },
			]),
		).toBe("a\n[terminal t1]");
	});
});
