/**
 * Per-platform default allowed-tool lists.
 *
 * These are the single source of truth for "what tools does Cyrus have access
 * to when a session is triggered by platform X". cyrus-hosted and any
 * self-host configuration imports these constants verbatim; the database
 * stores per-team overrides only, and falls back to these lists when a team
 * has not customized its allowed-tool set.
 *
 * Resolution is **additive only** — there is no implicit appending of
 * workspace MCP tools at runtime. Anything Cyrus needs (including
 * `mcp__linear`, `mcp__cyrus-tools`, `mcp__cyrus-docs`, and read access to
 * repository paths) is listed here explicitly. If you remove a tool from this
 * list, Cyrus loses access to it. If you add a tool here, existing teams whose
 * column equals the previous verbatim default will be migrated forward; teams
 * who have customized their list are left alone.
 *
 * The lists are intentionally maintained independently — sharing tools
 * between platforms is fine and expected, but the lists do not derive from
 * each other.
 */

/**
 * Default allowed tools for Linear-triggered agent sessions.
 *
 * Linear sessions are full engineering sessions — Cyrus opens worktrees,
 * runs builds, edits files, and opens PRs. This list mirrors the full
 * Claude Agent SDK toolset plus the workspace MCP prefixes Cyrus needs
 * to read and write Linear state.
 */
export const LINEAR_DEFAULT_ALLOWED_TOOLS = [
	// File system
	"Read",
	"Edit",
	"Write",
	"NotebookEdit",

	// Execution
	"Bash",
	"Agent",
	"Task",

	// Web
	"WebFetch",
	"WebSearch",

	// Planning + worktree management
	"EnterPlanMode",
	"ExitPlanMode",
	"EnterWorktree",
	"ExitWorktree",

	// User interaction
	"AskUserQuestion",
	"SendMessage",
	"PushNotification",

	// Task lifecycle
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",

	// Scheduling
	"CronCreate",
	"CronDelete",
	"CronList",
	"ScheduleWakeup",

	// Monitoring + discovery
	"Monitor",
	"LSP",
	"RemoteTrigger",
	"ToolSearch",
	"Skill",

	// Design sync
	"DesignSync",

	// Workflow orchestration
	"Workflow",

	// Workspace MCP servers — explicit, no implicit appending.
	"mcp__linear",
	"mcp__cyrus-tools",
	"mcp__cyrus-docs",
	// Atlassian MCP (Jira/Confluence) — read Jira ticket content for context.
	// Injected only when configured (see AtlassianMcpConfig).
	"mcp__atlassian",
] as const;

/**
 * Curated read-only allowed-tool list.
 *
 * This is the tool set resolved by the `readOnly` tool preset (used by
 * label-based prompt restrictions). It grants read-only access to repository
 * sources (so Cyrus can answer "look at the code in repo X" questions) plus
 * the standard planning/task tools, but no Edit/Write/general Bash. The only
 * Bash patterns allowed are `git -C * pull` (to refresh a repo) and the
 * non-mutating source-search commands `grep`/`rg` — Cyrus exposes no native
 * Grep/Glob tool, so code search must flow through Bash for this preset to
 * fulfil its "grep the repo" purpose (DEV-125).
 */
export const READONLY_DEFAULT_ALLOWED_TOOLS = [
	// Read access to configured repository paths
	"Read",
	"Bash(git -C * pull)",
	// Source search — read-only, no side effects. Required so read-only
	// sessions can actually grep repository sources (see DEV-125).
	"Bash(grep:*)",
	"Bash(rg:*)",

	// Web
	"WebFetch",
	"WebSearch",

	// User interaction — Slack chat sessions need to send replies back
	// to the channel and schedule follow-ups.
	"SendMessage",
	"ScheduleWakeup",

	// Planning + task lifecycle
	"Agent",
	"Task",
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",
	"EnterPlanMode",
	"ExitPlanMode",

	// Discovery
	"Monitor",
	"Skill",
	"ToolSearch",

	// Workspace MCP servers the read-only preset needs
	"mcp__linear",
	"mcp__cyrus-tools",
	"mcp__cyrus-docs",
	// Atlassian MCP (Jira/Confluence) — reading Jira ticket content for context
	// is a read-only operation, so it belongs in the read-only preset too.
	"mcp__atlassian",
] as const;

/**
 * Default allowed tools for GitHub-triggered agent sessions.
 *
 * GitHub sessions are full engineering sessions like Linear (Cyrus opens
 * PRs, edits files, runs builds), so the toolset mirrors the Linear
 * default — except `mcp__slack` is excluded since Slack is its own
 * platform with its own allowed-tool list.
 *
 * Maintained as an independent list (NOT derived from
 * `LINEAR_DEFAULT_ALLOWED_TOOLS`) so the two can diverge without one of
 * them silently inheriting the other's changes.
 */
export const GITHUB_DEFAULT_ALLOWED_TOOLS = [
	// File system
	"Read",
	"Edit",
	"Write",
	"NotebookEdit",

	// Execution
	"Bash",
	"Agent",
	"Task",

	// Web
	"WebFetch",
	"WebSearch",

	// Planning + worktree management
	"EnterPlanMode",
	"ExitPlanMode",
	"EnterWorktree",
	"ExitWorktree",

	// User interaction
	"AskUserQuestion",
	"SendMessage",
	"PushNotification",

	// Task lifecycle
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"TaskOutput",
	"TaskStop",

	// Scheduling
	"CronCreate",
	"CronDelete",
	"CronList",
	"ScheduleWakeup",

	// Monitoring + discovery
	"Monitor",
	"LSP",
	"RemoteTrigger",
	"ToolSearch",
	"Skill",

	// Design sync
	"DesignSync",

	// Workflow orchestration
	"Workflow",

	// Workspace MCP servers GitHub sessions need
	"mcp__linear",
	"mcp__cyrus-tools",
	"mcp__cyrus-docs",
	// Atlassian MCP (Jira/Confluence) — read Jira ticket content for context.
	// Injected only when configured (see AtlassianMcpConfig).
	"mcp__atlassian",
] as const;

/**
 * Linear MCP tools pruned from the model's context (DEV-140).
 *
 * The official Linear MCP (`mcp.linear.app`) registers ~47 tools. Their
 * combined descriptions push the Claude Agent SDK past its ~10%-of-context
 * threshold, which silently enables *MCP tool-search auto mode* and defers
 * EVERY Linear tool behind an on-demand `ToolSearch` — the ~1-minute turn-1
 * stall this issue is about. We stop the stall by eager-loading the Linear
 * server (`alwaysLoad`, see `McpConfigService.buildMcpConfig`), but loading all
 * 47 verbose tools bloats every turn with release / milestone / attachment /
 * diff / document / agent-skill tooling a coding-and-issue agent almost never
 * calls.
 *
 * So we prune. These tools are appended to `disallowedTools`, which *removes
 * them from the model's context entirely* — the SDK documents disallowed tools
 * as "removed from the model's context and cannot be used, even if they would
 * otherwise be allowed", and an `mcp__linear__<tool>` spec removes exactly that
 * tool from the server. What survives is the essential Linear surface Cyrus
 * uses every session (the KEEP set below): read/update issues and comments, and
 * resolve teams / users / workflow statuses / labels / projects. To load or
 * drop a tool, edit this one list.
 *
 * KEEP (stay loaded via `alwaysLoad`): get_issue, save_issue, list_comments,
 * save_comment, get_team, list_projects. `save_issue` and `list_projects` are
 * rare enough to defer, but the SDK only supports server-wide eager loading for
 * remote MCP servers; pruning them here would remove them entirely.
 */
export const LINEAR_MCP_PRUNED_TOOLS = [
	// Attachments — Cyrus uploads via cyrus-tools `linear_upload_file` instead.
	"mcp__linear__create_attachment",
	"mcp__linear__create_attachment_from_upload",
	"mcp__linear__delete_attachment",
	"mcp__linear__get_attachment",
	"mcp__linear__prepare_attachment_upload",
	"mcp__linear__extract_images",
	// Labels — reading (`list_issue_labels`) stays; creating does not.
	"mcp__linear__create_issue_label",
	"mcp__linear__list_project_labels",
	// Comments — read/write stay; destructive delete does not.
	"mcp__linear__delete_comment",
	// Project status updates (health posts) — rare, not turn-1 context.
	"mcp__linear__get_status_updates",
	"mcp__linear__save_status_update",
	"mcp__linear__delete_status_update",
	// Diffs — the agent works from the git worktree, not Linear diffs.
	"mcp__linear__get_diff",
	"mcp__linear__get_diff_threads",
	"mcp__linear__list_diffs",
	// Documents — rare; cyrus-docs covers documentation lookups.
	"mcp__linear__get_document",
	"mcp__linear__list_documents",
	"mcp__linear__save_document",
	// Linear agent skills — skill management, not issue work.
	"mcp__linear__get_agent_skill",
	"mcp__linear__list_agent_skills",
	// Cycles — sprint cycles, rarely needed for a coding session.
	"mcp__linear__list_cycles",
	// Milestones — rare planning surface.
	"mcp__linear__get_milestone",
	"mcp__linear__list_milestones",
	"mcp__linear__save_milestone",
	// Releases / release notes / pipelines — release management, rare.
	"mcp__linear__get_release",
	"mcp__linear__list_releases",
	"mcp__linear__save_release",
	"mcp__linear__get_release_note",
	"mcp__linear__list_release_notes",
	"mcp__linear__save_release_note",
	"mcp__linear__list_release_pipelines",
	// Projects — reading (`get_project`/`list_projects`) stays; writing does not.
	"mcp__linear__save_project",
	// Linear's own docs search — cyrus-docs is the documentation path.
	"mcp__linear__search_documentation",
	// Census-confirmed unused read helpers. Pruning removes them entirely.
	"mcp__linear__list_issues",
	"mcp__linear__list_teams",
	"mcp__linear__list_issue_labels",
	"mcp__linear__list_users",
	"mcp__linear__get_project",
	"mcp__linear__get_issue_status",
	"mcp__linear__get_user",
	"mcp__linear__list_issue_statuses",
] as const;

/**
 * Append the Linear MCP prune list to a resolved `disallowedTools` array,
 * de-duplicated. Pure and order-stable (resolved entries first). Applied once,
 * at the single `disallowedTools` chokepoint, so the prune covers every session
 * path (issue, warm-pool, multi-repo) regardless of per-repo config. See
 * `LINEAR_MCP_PRUNED_TOOLS`.
 */
export function withLinearMcpPruned(
	disallowedTools: readonly string[],
): string[] {
	return [...new Set([...disallowedTools, ...LINEAR_MCP_PRUNED_TOOLS])];
}

/**
 * Platform identifier used by callers that want to resolve a default list
 * dynamically. Keeps platform-string typos out of the call sites.
 */
export type AllowedToolsPlatform = "linear" | "github";

/**
 * Resolve the default allowed-tool list for a platform.
 */
export function getDefaultAllowedTools(
	platform: AllowedToolsPlatform,
): readonly string[] {
	switch (platform) {
		case "linear":
			return LINEAR_DEFAULT_ALLOWED_TOOLS;
		case "github":
			return GITHUB_DEFAULT_ALLOWED_TOOLS;
	}
}
