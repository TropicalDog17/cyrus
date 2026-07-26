/**
 * Single source of truth for the "MCP surface is preloaded" guidance appended
 * to every customer-facing Claude system prompt.
 *
 * Why this exists: the Linear MCP server and the local `cyrus-tools` server are
 * both eager-loaded (`alwaysLoad`, see `McpConfigService.buildMcpConfig`), so
 * their tools are already in the model's context from turn 1. Two failure modes
 * follow if the model does not know this:
 *
 *  1. It runs `ToolSearch("select:mcp__linear__…")` to "discover" tools that are
 *     already loaded. That search returns "No matching deferred tools found" and
 *     burns a whole round-trip for nothing — observed verbatim in the DEV-210
 *     source trace.
 *  2. Worse, a `ToolSearch` that *does* match and inject a new schema mutates the
 *     head of the request's tools array, which invalidates the ENTIRE cached
 *     prompt prefix and forces a full rewrite at the 1h creation rate (2x base
 *     input). Steering the model away from searching for already-loaded surfaces
 *     removes that whole class of cache-invalidation waste.
 *
 * So this addendum states plainly: the `mcp__linear__*` and `mcp__cyrus-tools__*`
 * tools are preloaded and directly callable; do not use `ToolSearch` to find
 * them. `ToolSearch` remains the right path for the genuinely deferred servers
 * (cyrus-docs, slack, atlassian) — this only carves out the two eager ones.
 *
 * Deliberately terse. Every token here is paid on every turn of every session.
 *
 * Updating this constant is the only place we need to change to evolve the
 * MCP-preload guidance across all Claude surfaces. See DEV-210 / DEV-140.
 */
export const MCP_PRELOAD_PROMPT_ADDENDUM = `
<mcp_preload>
The Linear MCP tools (\`mcp__linear__*\`) and the Cyrus tools
(\`mcp__cyrus-tools__*\`) are preloaded — they are already in your context and
callable directly. Do NOT use \`ToolSearch\` to find them; searching for an
already-loaded tool wastes a turn, and pulling a new schema into context
mid-session invalidates the whole prompt cache. Reserve \`ToolSearch\` for the
genuinely deferred servers (documentation, Slack, Atlassian).
</mcp_preload>
`.trim();

/**
 * Append the MCP-preload addendum to a system prompt fragment, normalizing
 * spacing so the boundary doesn't collide with prior content.
 */
export function appendMcpPreloadAddendum(
	existing: string | undefined | null,
): string {
	const base = (existing ?? "").trimEnd();
	if (base.length === 0) return MCP_PRELOAD_PROMPT_ADDENDUM;
	return `${base}\n\n${MCP_PRELOAD_PROMPT_ADDENDUM}`;
}
