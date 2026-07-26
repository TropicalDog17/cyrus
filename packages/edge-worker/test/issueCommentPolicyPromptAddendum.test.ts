import { describe, expect, it } from "vitest";
import {
	appendIssueCommentPolicyAddendum,
	ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM,
} from "../src/prompts/issueCommentPolicyPromptAddendum.js";

describe("issue-comment policy prompt addendum", () => {
	it("points the agent at the session thread as its reporting channel", () => {
		expect(ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM).toContain(
			"<issue_comment_policy>",
		);
		expect(ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM).toMatch(
			/agent session thread/i,
		);
		expect(ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM).toMatch(/top-level comment/i);
	});

	it("names the comment tool it must not use for narration", () => {
		// The Linear MCP server is registered as `linear`, so the tool the model
		// actually sees is `mcp__linear__save_comment` — naming a tool that does
		// not exist would make the instruction unactionable.
		expect(ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM).toMatch(
			/mcp__linear__save_comment/,
		);
		expect(ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM).not.toMatch(
			/mcp__linear-server__/,
		);
	});

	it("preserves the explicit-request exception rather than banning comments", () => {
		// The whole point: suppress unprompted narration, not the capability. A
		// blanket ban would break briefs that legitimately ask for a comment.
		expect(ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM).toMatch(/Exception/);
		expect(ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM).toMatch(
			/when you are actually asked to/i,
		);
		expect(ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM).toMatch(
			/post exactly what was requested/i,
		);
	});

	it("still allows replying inside an existing thread", () => {
		expect(ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM).toMatch(
			/Replying inside an existing thread/i,
		);
	});

	it("appends the addendum to an existing system prompt with a blank-line separator", () => {
		const result = appendIssueCommentPolicyAddendum("You are Cyrus.");
		expect(result.startsWith("You are Cyrus.\n\n")).toBe(true);
		expect(result.endsWith(ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM)).toBe(true);
	});

	it("returns the addendum verbatim when no base prompt is provided", () => {
		expect(appendIssueCommentPolicyAddendum(undefined)).toBe(
			ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM,
		);
		expect(appendIssueCommentPolicyAddendum(null)).toBe(
			ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM,
		);
		expect(appendIssueCommentPolicyAddendum("")).toBe(
			ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM,
		);
	});

	it("trims trailing whitespace from the existing prompt before joining", () => {
		const result = appendIssueCommentPolicyAddendum("Existing.\n\n   \n");
		expect(result).toBe(`Existing.\n\n${ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM}`);
	});
});
