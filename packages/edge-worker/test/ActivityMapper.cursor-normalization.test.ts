import { describe, expect, test } from "vitest";
import { ActivityMapper } from "../src/activity/ActivityMapper.js";
import type { MapContext } from "../src/activity/MapContext.js";
import { assistantToolUse } from "./agent-message-builders.js";

/**
 * Cursor tool-name normalization moved from CursorRunner.projectToolCall into
 * the mapper's render table. Driving map() with provider:"cursor" and
 * cursor-native tool_use must yield the canonical action name + the same
 * rendered parameter as the Claude render. Replaces
 * cursor-runner/test/formatter.test.ts.
 */
const mapper = new ActivityMapper();

function cursorAction(name: string, input: unknown, workingDirectory?: string) {
	const ctx: MapContext = {
		provider: "cursor",
		toolCall: () => undefined,
		taskSubjectById: () => undefined,
		workingDirectory,
	};
	const [activity] = mapper.map(assistantToolUse("tu", name, input), ctx);
	return activity;
}

describe("ActivityMapper cursor normalization", () => {
	test("shell -> Bash with command parameter", () => {
		const a = cursorAction("shell", { command: "ls -la" });
		expect(a?.type).toBe("action");
		if (a?.type === "action") {
			expect(a.action).toBe("Bash");
			expect(a.parameter).toBe("ls -la");
		}
	});

	test("read -> Read with workingDirectory-relative path", () => {
		const a = cursorAction("read", { path: "/wd/src/app.ts" }, "/wd");
		if (a?.type === "action") {
			expect(a.action).toBe("Read");
			expect(a.parameter).toBe("src/app.ts");
		} else {
			throw new Error("expected action");
		}
	});

	test("read keeps absolute path when outside workingDirectory", () => {
		const a = cursorAction("read", { path: "/other/app.ts" }, "/wd");
		if (a?.type === "action") {
			expect(a.parameter).toBe("/other/app.ts");
		} else {
			throw new Error("expected action");
		}
	});

	test("grep -> Grep with pattern parameter", () => {
		const a = cursorAction("grep", { pattern: "TODO", path: "/src" });
		if (a?.type === "action") {
			expect(a.action).toBe("Grep");
			expect(a.parameter).toBe("Pattern: `TODO` in /src");
		} else {
			throw new Error("expected action");
		}
	});

	test("glob -> Glob with globPattern + targetDirectory", () => {
		const a = cursorAction("glob", {
			globPattern: "**/*.ts",
			targetDirectory: "/src",
		});
		if (a?.type === "action") {
			expect(a.action).toBe("Glob");
			expect(a.parameter).toBe("Pattern: `**/*.ts` in /src");
		} else {
			throw new Error("expected action");
		}
	});

	test("edit -> Edit / write -> Write with file path", () => {
		const edit = cursorAction("edit", { path: "/src/a.ts" });
		const write = cursorAction("write", { path: "/src/b.ts" });
		expect(edit?.type === "action" && edit.action).toBe("Edit");
		expect(edit?.type === "action" && edit.parameter).toBe("/src/a.ts");
		expect(write?.type === "action" && write.action).toBe("Write");
		expect(write?.type === "action" && write.parameter).toBe("/src/b.ts");
	});

	test("mcp -> mcp__server__tool reconstruction", () => {
		const a = cursorAction("mcp", {
			providerIdentifier: "linear",
			toolName: "list_issues",
			args: { teamId: "abc" },
		});
		expect(a?.type === "action" && a.action).toBe("mcp__linear__list_issues");
	});

	test("update_todos -> TodoWrite thought", () => {
		const a = cursorAction("update_todos", {
			todos: [{ id: "1", content: "Do it", status: "completed" }],
		});
		expect(a?.type).toBe("thought");
	});

	test("web_fetch -> WebFetch with url", () => {
		const a = cursorAction("web_fetch", { url: "https://example.com" });
		if (a?.type === "action") {
			expect(a.action).toBe("WebFetch");
			expect(a.parameter).toBe("https://example.com");
		} else {
			throw new Error("expected action");
		}
	});

	test("already-canonical cursor name passes through (idempotent)", () => {
		const a = cursorAction("Bash", {
			command: "echo hi",
			description: "echo hi",
		});
		expect(a?.type === "action" && a.action).toBe("Bash");
		expect(a?.type === "action" && a.parameter).toBe("echo hi");
	});
});
