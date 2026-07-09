import type { McpServerConfig } from "cyrus-claude-runner";

/**
 * Default endpoint for Atlassian's official Remote MCP Server.
 *
 * This is the streamable-HTTP endpoint. Atlassian also exposes an SSE endpoint
 * at `https://mcp.atlassian.com/v1/sse`; supplying that URL via
 * `ATLASSIAN_MCP_URL` switches the transport to `sse` automatically.
 *
 * @see https://www.atlassian.com/platform/remote-mcp-server
 */
export const DEFAULT_ATLASSIAN_MCP_URL = "https://mcp.atlassian.com/v1/mcp";

/**
 * Build the Atlassian MCP server config from the environment, or `null` when
 * the integration is not configured.
 *
 * This lets Cyrus sessions query Jira/Confluence content — for example, a Jira
 * ticket referenced by a Linear issue — for context via the Atlassian MCP
 * server. It mirrors the way the Slack MCP server is injected: whether a
 * session can actually call these tools is gated upstream by the per-platform
 * allowed-tools array (`mcp__atlassian`), so it is safe to spin the server up
 * whenever credentials/config exist.
 *
 * Configuration (environment variables):
 * - `ATLASSIAN_MCP_TOKEN`: Bearer token used to authenticate with the MCP
 *   server. For the official remote server this is an OAuth access token; for a
 *   self-hosted/community Atlassian MCP server it may be an API token. Sent as
 *   `Authorization: Bearer <token>`.
 * - `ATLASSIAN_MCP_URL`: Override the endpoint (e.g. a self-hosted server or the
 *   official SSE endpoint). Defaults to {@link DEFAULT_ATLASSIAN_MCP_URL}. A URL
 *   whose path ends in `/sse` is treated as the `sse` transport.
 *
 * The server is injected when a token or a custom URL is present. When neither
 * is set we return `null` so we don't spin up a server that can't authenticate.
 *
 * @param env - Environment to read configuration from (defaults to `process.env`)
 * @returns An MCP server config, or `null` when Atlassian is not configured
 */
export function buildAtlassianMcpServerConfig(
	env: NodeJS.ProcessEnv = process.env,
): McpServerConfig | null {
	const token = env.ATLASSIAN_MCP_TOKEN?.trim();
	const customUrl = env.ATLASSIAN_MCP_URL?.trim();

	// Not configured — don't inject a server that can't authenticate.
	if (!token && !customUrl) {
		return null;
	}

	const url = customUrl || DEFAULT_ATLASSIAN_MCP_URL;
	const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

	// Atlassian's official remote server offers both a streamable-HTTP endpoint
	// (`/v1/mcp`) and an SSE endpoint (`/v1/sse`). Infer the transport from the
	// URL so both work out of the box.
	if (isSseUrl(url)) {
		return {
			type: "sse",
			url,
			...(headers ? { headers } : {}),
		};
	}

	return {
		type: "http",
		url,
		...(headers ? { headers } : {}),
	};
}

/**
 * Whether an MCP endpoint URL should use the SSE transport.
 *
 * Matches URLs whose path ends in `/sse` (ignoring any query string or hash),
 * which is the convention used by Atlassian's SSE endpoint.
 */
function isSseUrl(url: string): boolean {
	const withoutQueryOrHash = url.split(/[?#]/, 1)[0] ?? url;
	let end = withoutQueryOrHash.length;
	while (end > 0 && withoutQueryOrHash[end - 1] === "/") {
		end -= 1;
	}
	return withoutQueryOrHash.slice(0, end).endsWith("/sse");
}
