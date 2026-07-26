import { describe, expect, it } from "vitest";
import {
	appendMcpPreloadAddendum,
	MCP_PRELOAD_PROMPT_ADDENDUM,
} from "../src/prompts/mcpPreloadPromptAddendum.js";

describe("mcp-preload prompt addendum", () => {
	it("names the two preloaded MCP surfaces", () => {
		expect(MCP_PRELOAD_PROMPT_ADDENDUM).toContain("<mcp_preload>");
		expect(MCP_PRELOAD_PROMPT_ADDENDUM).toContain("mcp__linear__*");
		expect(MCP_PRELOAD_PROMPT_ADDENDUM).toContain("mcp__cyrus-tools__*");
	});

	it("tells the model not to ToolSearch for the preloaded surfaces", () => {
		// The whole point (DEV-210): stop the wasted turn-1 ToolSearch for
		// already-loaded tools, and the cache-invalidating mid-session schema pull.
		expect(MCP_PRELOAD_PROMPT_ADDENDUM).toMatch(/preloaded/i);
		expect(MCP_PRELOAD_PROMPT_ADDENDUM).toMatch(/Do NOT use `ToolSearch`/);
		expect(MCP_PRELOAD_PROMPT_ADDENDUM).toMatch(
			/invalidates the whole prompt cache/,
		);
	});

	it("still points ToolSearch at the genuinely deferred servers", () => {
		expect(MCP_PRELOAD_PROMPT_ADDENDUM).toMatch(/Reserve `ToolSearch` for the/);
		expect(MCP_PRELOAD_PROMPT_ADDENDUM).toMatch(
			/documentation, Slack, Atlassian/,
		);
	});

	it("appends the addendum to an existing system prompt with a blank-line separator", () => {
		const result = appendMcpPreloadAddendum("You are Cyrus.");
		expect(result.startsWith("You are Cyrus.\n\n")).toBe(true);
		expect(result.endsWith(MCP_PRELOAD_PROMPT_ADDENDUM)).toBe(true);
	});

	it("returns the addendum verbatim when no base prompt is provided", () => {
		expect(appendMcpPreloadAddendum(undefined)).toBe(
			MCP_PRELOAD_PROMPT_ADDENDUM,
		);
		expect(appendMcpPreloadAddendum(null)).toBe(MCP_PRELOAD_PROMPT_ADDENDUM);
		expect(appendMcpPreloadAddendum("")).toBe(MCP_PRELOAD_PROMPT_ADDENDUM);
	});

	it("trims trailing whitespace from the existing prompt before joining", () => {
		const result = appendMcpPreloadAddendum("Existing.\n\n   \n");
		expect(result).toBe(`Existing.\n\n${MCP_PRELOAD_PROMPT_ADDENDUM}`);
	});
});
