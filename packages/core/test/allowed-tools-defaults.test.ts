import { describe, expect, it } from "vitest";
import {
	LINEAR_MCP_PRUNED_TOOLS,
	READONLY_DEFAULT_ALLOWED_TOOLS,
	withLinearMcpPruned,
} from "../src/allowed-tools-defaults";

/**
 * Regression coverage for DEV-125.
 *
 * The read-only preset exists so Cyrus can answer "look at the code in repo X"
 * questions: it grants Read access to repository sources and `git -C * pull`
 * to refresh a repo "before grepping it". But Cyrus has no native Grep/Glob
 * tool — all code search flows through Bash — so a read-only session that runs
 * `grep` was denied ("Permission to use Bash with command grep ... has been
 * denied"), making the preset's stated purpose impossible.
 */
describe("READONLY_DEFAULT_ALLOWED_TOOLS", () => {
	it("permits grep so read-only sessions can search repository sources", () => {
		const allowsGrep = READONLY_DEFAULT_ALLOWED_TOOLS.some((tool) =>
			/^Bash\(grep[\s(:]/.test(tool),
		);
		expect(allowsGrep).toBe(true);
	});

	it("stays read-only — no bare Bash, Edit, Write, or NotebookEdit", () => {
		const tools = READONLY_DEFAULT_ALLOWED_TOOLS as readonly string[];
		expect(tools).not.toContain("Bash");
		expect(tools).not.toContain("Edit");
		expect(tools).not.toContain("Edit(**)");
		expect(tools).not.toContain("Write");
		expect(tools).not.toContain("Write(**)");
		expect(tools).not.toContain("NotebookEdit");
	});
});

/**
 * Regression coverage for DEV-140.
 *
 * The official Linear MCP registers ~47 tools; loading all of them bloats every
 * turn's context. We eager-load the Linear server but prune its verbose,
 * rarely-used tools out of context via `disallowedTools`. These assertions pin
 * the KEEP/DISALLOW partition so an accidental edit to the prune list (dropping
 * an essential tool or leaving a rare one loaded) fails loudly.
 */
describe("LINEAR_MCP_PRUNED_TOOLS", () => {
	const tools = LINEAR_MCP_PRUNED_TOOLS as readonly string[];

	// Tools that must stay LOADED (never appear in the prune list) — the
	// essential Linear surface Cyrus uses every session.
	const KEEP = [
		"mcp__linear__get_issue",
		"mcp__linear__save_issue",
		"mcp__linear__list_comments",
		"mcp__linear__save_comment",
		"mcp__linear__get_team",
		"mcp__linear__list_projects",
	];

	it("prunes exactly the 41 verbose or unused Linear tools", () => {
		expect(tools).toHaveLength(41);
	});

	it("only ever prunes `mcp__linear__` tools", () => {
		for (const tool of tools) {
			expect(tool.startsWith("mcp__linear__")).toBe(true);
		}
	});

	it("prunes representative rarely-used tools", () => {
		expect(tools).toContain("mcp__linear__save_milestone");
		expect(tools).toContain("mcp__linear__get_diff");
		expect(tools).toContain("mcp__linear__create_attachment");
		expect(tools).toContain("mcp__linear__search_documentation");
		expect(tools).toContain("mcp__linear__save_status_update");
		expect(tools).toContain("mcp__linear__save_release");
		expect(tools).toContain("mcp__linear__list_issues");
		expect(tools).toContain("mcp__linear__list_issue_statuses");
	});

	it("never prunes an essential Linear tool", () => {
		for (const keep of KEEP) {
			expect(tools).not.toContain(keep);
		}
	});

	it("has no duplicate entries", () => {
		expect(new Set(tools).size).toBe(tools.length);
	});
});

describe("withLinearMcpPruned", () => {
	it("appends the prune list to resolved disallowed tools", () => {
		const result = withLinearMcpPruned(["Bash(rm:*)"]);
		expect(result[0]).toBe("Bash(rm:*)");
		expect(result).toContain("mcp__linear__get_diff");
		expect(result).toHaveLength(1 + LINEAR_MCP_PRUNED_TOOLS.length);
	});

	it("de-duplicates when a pruned tool is already disallowed", () => {
		const result = withLinearMcpPruned(["mcp__linear__get_diff", "Bash(rm:*)"]);
		expect(result).toHaveLength(LINEAR_MCP_PRUNED_TOOLS.length + 1);
		expect(result.filter((t) => t === "mcp__linear__get_diff")).toHaveLength(1);
	});

	it("returns the prune list verbatim for an empty input", () => {
		expect(withLinearMcpPruned([])).toEqual([...LINEAR_MCP_PRUNED_TOOLS]);
	});
});
