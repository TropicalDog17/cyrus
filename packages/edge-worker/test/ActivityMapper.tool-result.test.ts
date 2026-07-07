import { describe, expect, test } from "vitest";
import { ActivityMapper } from "../src/activity/ActivityMapper.js";
import type { MapContext } from "../src/activity/MapContext.js";
import { userToolResult } from "./agent-message-builders.js";

const mapper = new ActivityMapper();

function ctx(overrides: Partial<MapContext> = {}): MapContext {
	return {
		provider: "claude",
		toolCall: () => undefined,
		taskSubjectById: () => undefined,
		...overrides,
	};
}

describe("ActivityMapper tool_result mapping", () => {
	test("resolves the originating tool via MapContext.toolCall", () => {
		const activities = mapper.map(
			userToolResult("tu", "hello", false),
			ctx({
				toolCall: () => ({ name: "Bash", input: { command: "echo hi" } }),
			}),
		);
		expect(activities).toHaveLength(1);
		const a = activities[0];
		expect(a?.type).toBe("action");
		if (a?.type === "action") {
			expect(a.action).toBe("Bash");
			expect(a.parameter).toBe("echo hi");
			expect(a.result).toContain("```\nhello\n```");
		}
	});

	test("unknown tool falls back to 'Tool'", () => {
		const [a] = mapper.map(userToolResult("tu", "done"), ctx());
		expect(a?.type === "action" && a.action).toBe("Tool");
	});

	test("marks the result an error", () => {
		const [a] = mapper.map(
			userToolResult("tu", "boom", true),
			ctx({ toolCall: () => ({ name: "Bash", input: { command: "x" } }) }),
		);
		expect(a?.type === "action" && a.action).toBe("Bash (Error)");
		expect(a?.type === "action" && a.result).toBe("```\nboom\n```");
	});

	test("active Task completion -> thought", () => {
		const [a] = mapper.map(
			userToolResult("task1", "sub-agent finished"),
			ctx({ activeTaskUseId: "task1" }),
		);
		expect(a?.type).toBe("thought");
		if (a?.type === "thought") {
			expect(a.body).toBe(
				"✅ Task Completed\n\n\n\nsub-agent finished\n\n---\n\n",
			);
		}
	});

	test("TaskUpdate enriched with cached subject", () => {
		const [a] = mapper.map(
			userToolResult("tu", "Task updated"),
			ctx({
				toolCall: () => ({
					name: "TaskUpdate",
					input: { taskId: "5", status: "completed" },
				}),
				taskSubjectById: (id) => (id === "5" ? "Fix login bug" : undefined),
			}),
		);
		expect(a?.type).toBe("thought");
		expect(a?.type === "thought" && a.body).toBe("✅ Task #5 — Fix login bug");
	});

	test("TaskGet enriched from result Subject: line", () => {
		const [a] = mapper.map(
			userToolResult("tu", "ID: 3\nSubject: Do the thing\nStatus: open"),
			ctx({
				toolCall: () => ({ name: "TaskGet", input: { taskId: "3" } }),
			}),
		);
		expect(a?.type === "thought" && a.body).toBe("📋 Task #3 — Do the thing");
	});

	test.each([
		"TodoWrite",
		"TaskCreate",
		"TaskList",
		"AskUserQuestion",
	])("%s result is skipped (no activity)", (name) => {
		const activities = mapper.map(
			userToolResult("tu", "whatever"),
			ctx({ toolCall: () => ({ name, input: {} }) }),
		);
		expect(activities).toEqual([]);
	});

	test("user message without a tool_result -> no activity", () => {
		const activities = mapper.map(
			{
				type: "user",
				sessionId: "s",
				parentToolUseId: null,
				content: [{ type: "text", text: "just text" }],
			},
			ctx(),
		);
		expect(activities).toEqual([]);
	});
});
