/**
 * Single source of truth for the issue-comment policy appended to every
 * customer-facing agent system prompt.
 *
 * Why this exists: an agent session already has a reporting channel — every
 * response streams to the tracker as an agent activity inside the session
 * thread (`LinearActivitySink.post` → `createAgentActivity`). But the model also
 * holds `mcp__linear__save_comment`, which stays loaded on purpose (it is in the
 * KEEP set in `cyrus-core`'s `allowed-tools-defaults`, not the pruned list) so it
 * can answer questions asked in a comment thread. Nothing told the model *when*
 * to use it, so it routinely narrated its own work into fresh top-level comments
 * — plans, scoping notes, "Done — PR #271" — duplicating what the session thread
 * already showed.
 *
 * That is worst on the @mention path, where the label-based system prompt is
 * skipped entirely (`PromptAssembler.buildNewSessionPrompt`, prompt type
 * `mention`), so no role prompt constrains where output goes. Measured on a real
 * workspace: 10 of 40 consecutive agent comments were top-level, and the sampled
 * ones were all mention-triggered. The orchestrator prompts already carry a
 * bespoke version of this rule ("DO NOT POST LINEAR COMMENTS TO CURRENT ISSUE");
 * this generalizes it to every path instead of one role.
 *
 * The exception clause is the point of the policy, not a caveat on it: an
 * explicit request to leave a comment must still work. This suppresses unprompted
 * narration, not the tool.
 *
 * Deliberately terse — every token here is paid on every turn of every session.
 */
export const ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM = `
<issue_comment_policy>
Your responses are already posted to the work item's agent session thread. That
thread is your reporting channel, so do not duplicate it as a tracker comment.

- Do not open a top-level comment to narrate your own work — plans, progress,
  findings, or a closing summary belong in your response, not in a new comment.
- Do not call \`mcp__linear__save_comment\` for that narration.
- Exception: post one when you are actually asked to. If the description, a
  comment, or your role prompt tells you to post/leave/reply with a comment, do
  it — post exactly what was requested and nothing extra.
- Replying inside an existing thread where someone asked you something is always
  fine; that is answering, not narrating.
</issue_comment_policy>
`.trim();

/**
 * Append the issue-comment policy to a system prompt fragment, normalizing
 * spacing so the boundary doesn't collide with prior content.
 */
export function appendIssueCommentPolicyAddendum(
	existing: string | undefined | null,
): string {
	const base = (existing ?? "").trimEnd();
	if (base.length === 0) return ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM;
	return `${base}\n\n${ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM}`;
}
