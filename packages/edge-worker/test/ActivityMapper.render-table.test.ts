import { describe, expect, test } from "vitest";
import { ActivityMapper } from "../src/activity/ActivityMapper.js";
import type { MapContext } from "../src/activity/MapContext.js";
import { assistantToolUse, userToolResult } from "./agent-message-builders.js";

/**
 * Render-table fidelity: these exact strings are load-bearing (they render on
 * the Linear timeline). Ported verbatim from the former
 * AgentSessionManager.tool-formatting.test.ts, which tested the deleted
 * ClaudeMessageFormatter directly. Now they drive `ActivityMapper.map()` with
 * claude-provider neutral tool_use / tool_result messages.
 */
const mapper = new ActivityMapper();

/** MapContext whose single registered tool resolves via toolCall(). */
function ctxWith(
	toolUseId: string,
	name: string,
	input: unknown,
	extra: Partial<MapContext> = {},
): MapContext {
	return {
		provider: "claude",
		toolCall: (id) => (id === toolUseId ? { name, input } : undefined),
		taskSubjectById: () => undefined,
		...extra,
	};
}

/** Drive the tool_use render (parameter at "in progress" time). */
function paramFromToolUse(
	name: string,
	input: unknown,
	extra: Partial<import("cyrus-core").AgentAssistantMessage> = {},
): string | undefined {
	const [activity] = mapper.map(
		assistantToolUse("tu", name, input, extra),
		ctxWith("tu", name, input),
	);
	return activity && activity.type === "action"
		? activity.parameter
		: undefined;
}

/** Drive the tool_result render, returning the produced action activity. */
function actionFromResult(
	name: string,
	input: unknown,
	result: string,
	isError = false,
) {
	const [activity] = mapper.map(
		userToolResult("tu", result, isError),
		ctxWith("tu", name, input),
	);
	return activity && activity.type === "action" ? activity : undefined;
}

describe("ActivityMapper render table — tool parameters", () => {
	test("Bash with description shows command only", () => {
		expect(
			paramFromToolUse("Bash", {
				command: "ls -la /home/user",
				description: "List files in home directory",
			}),
		).toBe("ls -la /home/user");
	});

	test("Bash without description", () => {
		expect(paramFromToolUse("Bash", { command: "ls -la /home/user" })).toBe(
			"ls -la /home/user",
		);
	});

	test("Read with file path", () => {
		expect(paramFromToolUse("Read", { file_path: "/home/user/test.ts" })).toBe(
			"/home/user/test.ts",
		);
	});

	test("Read with line range", () => {
		expect(
			paramFromToolUse("Read", {
				file_path: "/home/user/test.ts",
				offset: 10,
				limit: 20,
			}),
		).toBe("/home/user/test.ts (lines 11-30)");
	});

	test("Grep with pattern", () => {
		expect(
			paramFromToolUse("Grep", {
				pattern: "TODO",
				path: "/home/user",
				glob: "*.ts",
			}),
		).toBe("Pattern: `TODO` in /home/user (*.ts)");
	});

	test("Glob with pattern", () => {
		expect(
			paramFromToolUse("Glob", { pattern: "**/*.ts", path: "/home/user" }),
		).toBe("Pattern: `**/*.ts` in /home/user");
	});

	test("WebSearch with query", () => {
		expect(
			paramFromToolUse("WebSearch", { query: "Linear API documentation" }),
		).toBe("Query: Linear API documentation");
	});

	test("MCP tool extracts meaningful field", () => {
		expect(
			paramFromToolUse("mcp__linear__get_issue", {
				id: "CYPACK-395",
				someOtherField: "value",
			}),
		).toBe("id: CYPACK-395");
	});

	test("subtask arrow prefix Bash shows command", () => {
		const [activity] = mapper.map(
			assistantToolUse(
				"tu",
				"Bash",
				{ command: "pwd", description: "Get current directory" },
				{ parentToolUseId: "task1" },
			),
			ctxWith("tu", "Bash", {}, { activeTaskUseId: "task1" }),
		);
		expect(activity?.type).toBe("action");
		if (activity?.type === "action") {
			expect(activity.action).toBe("↪ Bash");
			expect(activity.parameter).toBe("pwd");
		}
	});

	test("ToolSearch single select query", () => {
		expect(
			paramFromToolUse("ToolSearch", {
				query: "select:mcp__linear__get_issue",
				max_results: 1,
			}),
		).toBe("Loading tool schema: `mcp__linear__get_issue`");
	});

	test("ToolSearch multi select query", () => {
		expect(
			paramFromToolUse("ToolSearch", {
				query: "select:TaskCreate,TaskUpdate",
				max_results: 2,
			}),
		).toBe("Loading tool schemas: `TaskCreate`, `TaskUpdate`");
	});

	test("ToolSearch keyword search", () => {
		expect(
			paramFromToolUse("ToolSearch", {
				query: "+linear get_issue",
				max_results: 3,
			}),
		).toBe("Searching tools for: `+linear get_issue`");
	});

	test("TaskOutput blocking / non-blocking", () => {
		expect(
			paramFromToolUse("TaskOutput", { task_id: "b6e6efb", block: true }),
		).toBe("📤 Waiting for task b6e6efb");
		expect(
			paramFromToolUse("TaskOutput", { task_id: "abc123", block: false }),
		).toBe("📤 Checking task abc123");
	});
});

describe("ActivityMapper render table — Task thoughts (at tool_use)", () => {
	function thought(name: string, input: unknown): string | undefined {
		const [a] = mapper.map(
			assistantToolUse("tu", name, input),
			ctxWith("tu", name, input),
		);
		return a && a.type === "thought" ? a.body : undefined;
	}

	test("TaskCreate concise pending checklist item", () => {
		expect(
			thought("TaskCreate", {
				subject: "Implement user authentication",
				description: "Add OAuth login flow",
			}),
		).toBe("⏳ **Implement user authentication**");
	});

	test("TaskList", () => {
		expect(thought("TaskList", {})).toBe("📋 List all tasks");
	});

	test("TodoWrite renders checklist thought", () => {
		const body = thought("TodoWrite", {
			todos: [
				{ id: "1", content: "First", status: "completed", priority: "high" },
				{ id: "2", content: "Second", status: "in_progress", priority: "high" },
				{ id: "3", content: "Third", status: "pending", priority: "high" },
			],
		});
		expect(body).toBe("\n✅ First\n🔄 Second\n⏳ Third");
	});
});

describe("ActivityMapper render table — Task tool action + result", () => {
	test("Task tool_use renders action with description parameter", () => {
		const [a] = mapper.map(
			assistantToolUse("tu", "Task", { description: "Investigate the bug" }),
			ctxWith("tu", "Task", {}),
		);
		expect(a?.type).toBe("action");
		if (a?.type === "action") {
			expect(a.action).toBe("Task");
			expect(a.parameter).toBe("Investigate the bug");
		}
	});
});

describe("ActivityMapper render table — tool results", () => {
	test("Bash with output", () => {
		const a = actionFromResult(
			"Bash",
			{ command: "echo hello", description: "Test command" },
			"hello\nworld",
		);
		expect(a?.result).toContain("```\nhello\nworld\n```");
	});

	test("Bash without output", () => {
		const a = actionFromResult(
			"Bash",
			{ command: "touch file.txt", description: "Create file" },
			"",
		);
		expect(a?.result).toContain("*No output*");
	});

	test("Read TypeScript file", () => {
		const a = actionFromResult(
			"Read",
			{ file_path: "/home/user/test.ts" },
			"const x = 1;\nconsole.log(x);",
		);
		expect(a?.result).toContain(
			"```typescript\nconst x = 1;\nconsole.log(x);\n```",
		);
	});

	test("Read removes line numbers and system-reminder", () => {
		const a = actionFromResult(
			"Read",
			{ file_path: "/home/user/test.py" },
			"  25→def foo():\n  26→    return 1\n\n<system-reminder>\nThis is a reminder\n</system-reminder>",
		);
		expect(a?.result).not.toContain("25→");
		expect(a?.result).not.toContain("<system-reminder>");
		expect(a?.result).toContain("```python\ndef foo():\n    return 1\n```");
	});

	test("Read preserves first-line indentation", () => {
		const a = actionFromResult(
			"Read",
			{ file_path: "/home/user/test.py" },
			'  16→            coordinate["x"] -= 1\n  17→            elif direction == "up":\n  18→                coordinate["y"] += 1',
		);
		expect(a?.result).toContain(
			'```python\n            coordinate["x"] -= 1\n            elif direction == "up":\n                coordinate["y"] += 1\n```',
		);
	});

	test("Edit shows diff format", () => {
		const a = actionFromResult(
			"Edit",
			{
				file_path: "/home/user/test.ts",
				old_string: "const x = 1;",
				new_string: "const x = 2;",
			},
			"",
		);
		expect(a?.result).toContain("```diff");
		expect(a?.result).toContain("-const x = 1;");
		expect(a?.result).toContain("+const x = 2;");
	});

	test("Write success", () => {
		const a = actionFromResult(
			"Write",
			{ file_path: "/home/user/test.ts" },
			"",
		);
		expect(a?.result).toBe("*File written successfully*");
	});

	test("Grep with file matches", () => {
		const a = actionFromResult(
			"Grep",
			{ pattern: "TODO" },
			"file1.ts\nfile2.ts\nfile3.ts",
		);
		expect(a?.result).toContain("Found 3 matching files:");
		expect(a?.result).toContain("```\nfile1.ts\nfile2.ts\nfile3.ts\n```");
	});

	test("Glob with results", () => {
		const a = actionFromResult(
			"Glob",
			{ pattern: "*.ts" },
			"file1.ts\nfile2.ts",
		);
		expect(a?.result).toContain("Found 2 matching files:");
	});

	test("error result wraps in code fence", () => {
		const a = actionFromResult(
			"Bash",
			{ command: "invalid command" },
			"Error: command not found",
			true,
		);
		expect(a?.result).toBe("```\nError: command not found\n```");
	});

	test("subtask arrow prefix Read result (js)", () => {
		const a = actionFromResult(
			"↪ Read",
			{ file_path: "/home/user/test.js" },
			"console.log('test');",
		);
		expect(a?.result).toContain("```javascript\nconsole.log('test');\n```");
	});

	test("Bash action name with description", () => {
		const a = actionFromResult(
			"Bash",
			{ command: "ls -la", description: "List all files" },
			"ok",
		);
		expect(a?.action).toBe("Bash (List all files)");
	});

	test("Bash action name error + description", () => {
		const a = actionFromResult(
			"Bash",
			{ command: "invalid command", description: "Test command" },
			"boom",
			true,
		);
		expect(a?.action).toBe("Bash (Error) (Test command)");
	});

	test("subtask Bash action name with description", () => {
		const a = actionFromResult(
			"↪ Bash",
			{ command: "pwd", description: "Get current directory" },
			"ok",
		);
		expect(a?.action).toBe("↪ Bash (Get current directory)");
	});

	test("non-Bash action name unchanged", () => {
		const a = actionFromResult("Read", { file_path: "/test" }, "content");
		expect(a?.action).toBe("Read");
	});

	test("ToolSearch loaded tools result", () => {
		const a = actionFromResult(
			"ToolSearch",
			{ query: "select:TaskCreate,TaskUpdate" },
			"TaskCreate\nTaskUpdate",
		);
		expect(a?.result).toBe("Loaded tools: `TaskCreate`, `TaskUpdate`");
	});

	test("ToolSearch loaded single tool result", () => {
		const a = actionFromResult(
			"ToolSearch",
			{ query: "select:mcp__linear__get_issue" },
			"mcp__linear__get_issue",
		);
		expect(a?.result).toBe("Loaded tool: `mcp__linear__get_issue`");
	});

	test("ToolSearch freeform result italicized", () => {
		const a = actionFromResult(
			"ToolSearch",
			{ query: "anything" },
			"Some freeform result with spaces",
		);
		expect(a?.result).toBe("*Some freeform result with spaces*");
	});

	test("ToolSearch no results", () => {
		const a = actionFromResult("ToolSearch", { query: "nonexistent" }, "");
		expect(a?.result).toBe("*No tools found*");
	});

	test("TaskOutput short result", () => {
		const a = actionFromResult(
			"TaskOutput",
			{ task_id: "abc123" },
			"Task completed successfully",
		);
		expect(a?.result).toBe("Task completed successfully");
	});

	test("TaskOutput no output", () => {
		const a = actionFromResult("TaskOutput", { task_id: "abc123" }, "");
		expect(a?.result).toBe("*No output yet*");
	});
});
