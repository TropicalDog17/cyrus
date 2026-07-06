/**
 * Linear conventions (pure, testable) for the devtrop workspace (ported from the pure parts
 * of `pipeline/linear.py`).
 *
 * The GraphQL/network fetch parts of the original module (fetch_labels / available_labels) are
 * handled elsewhere in Cyrus; this file holds only the CONVENTIONS as pure logic + a tool map:
 *   * label names and the corrected rework-linkage convention;
 *   * spec-gate comment classification (approve / edit / reject);
 *
 * Design deltas from DESIGN.md, forced by how Linear actually works (see docs/LINEAR.md):
 *   * Rework linkage is NOT `rework-of:<ISSUE-ID>` — a colon in a Linear label name creates a
 *     label GROUP, and per-issue labels proliferate. Instead: one flat `rework-of` boolean
 *     label + Linear's native `relatedTo` relation to the original.
 *   * PRD and Orchestrator labels already exist, team-scoped to Devtrop — reuse, never recreate.
 */

export const WORKSPACE_ID = "d3b93687-ac81-4fe5-847a-808b1ffea5e4"; // devtrop
export const TEAM_ID = "11aad276-eec3-4cca-93c2-4efb16b15991"; // Devtrop

// Labels the pipeline relies on. PRD/Orchestrator are Cyrus's existing role-routing labels
// (reuse). Only `chore` and `rework-of` need creating (team-scoped).
export const LABEL_CHORE = "chore";
export const LABEL_SCOPER = "PRD"; // Cyrus: route to the scoper role
export const LABEL_ORCHESTRATOR = "Orchestrator"; // Cyrus: route to the orchestrator role
export const LABEL_REWORK = "rework-of"; // flat boolean marker; the target is carried by relatedTo

export const LABELS_TO_CREATE = [LABEL_CHORE, LABEL_REWORK] as const; // PRD/Orchestrator already exist
export const LABELS_REUSED = [LABEL_SCOPER, LABEL_ORCHESTRATOR] as const;

// pipeline action -> exact Linear MCP tool (for whoever drives the API).
export const MCP_TOOLS: Record<string, string> = {
	poll_queue: "mcp__linear-server__list_issues",
	read_issue: "mcp__linear-server__get_issue", // includeRelations=true for relatedTo
	check_label_exists: "mcp__linear-server__list_issue_labels", // ALWAYS pass team
	create_label: "mcp__linear-server__create_issue_label", // pass teamId
	apply_label_or_relation: "mcp__linear-server__save_issue", // labels / relatedTo / estimate
	post_spec_comment: "mcp__linear-server__save_comment", // issueId, body
	edit_spec_comment: "mcp__linear-server__save_comment", // id, body
	reply_in_thread: "mcp__linear-server__save_comment", // parentId, body
	detect_gate_reply: "mcp__linear-server__list_comments", // diff vs last-seen
};

// re.IGNORECASE -> `i`. Anchored at the start; the leading token decides the classification.
const APPROVE_RE = /^\s*(approve[d]?|lgtm|ship it|👍|✅)\b/i;
const REJECT_RE = /^\s*(reject[ed]?|no|nack|❌)\b/i;
const EDIT_RE = /^\s*(edit|edited|revise|amend)\b[:\s]/i;

/**
 * Classify a spec-gate reply as approve | edit | reject | none.
 *
 * `edit` is checked before the others because an edited spec often restates content; the
 * leading token is what decides.
 */
export function classifyComment(body: string): string {
	if (EDIT_RE.test(body)) return "edit";
	if (APPROVE_RE.test(body)) return "approve";
	if (REJECT_RE.test(body)) return "reject";
	return "none";
}

/** Map a classified reply to a runs.jsonl spec_gate value (approved|edited|rejected). */
export function specGateFromComment(body: string): string | null {
	const map: Record<string, string> = {
		approve: "approved",
		edit: "edited",
		reject: "rejected",
	};
	return map[classifyComment(body)] ?? null;
}

/**
 * Cyrus/agent session-marker comments have author == null — filter them out when scanning a
 * thread for a human approve/edit/reject reply.
 */
export function isSystemComment(comment: { author?: unknown }): boolean {
	return comment.author == null;
}

export interface ReworkSaveIssueArgs {
	id: string;
	labels: string[];
	relatedTo: string[];
}

/**
 * Args for save_issue to link a rework issue back to its origin: the flat `rework-of` label +
 * a native relatedTo relation (NOT a colon label).
 */
export function reworkSaveIssueArgs(
	newIssueId: string,
	originalIssueId: string,
	extraLabels: string[] | null = null,
): ReworkSaveIssueArgs {
	return {
		id: newIssueId,
		labels: [LABEL_REWORK, ...(extraLabels ?? [])],
		relatedTo: [originalIssueId],
	};
}
