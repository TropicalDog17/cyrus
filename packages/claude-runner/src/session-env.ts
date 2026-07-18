/**
 * Shared session environment and MCP config utilities.
 *
 * These helpers DRY up logic that was previously duplicated between
 * ClaudeRunner (query options) and EdgeWorker (warmup / startup).
 */

/**
 * Auth-related env vars forwarded from the parent process.
 * The SDK subprocess needs these for API calls.
 */
const AUTH_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_AUTH_TOKEN",
] as const;

/**
 * Cyrus-specific env vars injected into every Claude Code subprocess.
 * Both `ClaudeRunner.start()` and `EdgeWorker.warmupRecentSessions()`
 * must use the same set — keep this as the single source of truth.
 *
 * Note: CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is intentionally not included
 * while the Linux bubblewrap sandbox side effects it triggers are being
 * investigated. See CYPACK-1108.
 *
 * - MCP_CONNECTION_NONBLOCKING lets MCP servers connect in the background so
 *   both cold-start and pre-warm sessions return faster.
 */
export const CYRUS_SESSION_ENV = {
	CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
	CLAUDE_CODE_ENABLE_TASKS: "true",
	CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
	CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
	MCP_CONNECTION_NONBLOCKING: "true",
} as const;

/**
 * Build the base `env` object for a Claude SDK session.
 *
 * Overlays the full parent `process.env` so HOME (and other inherited vars) are
 * available to tools that depend on them — GPG-signed commits, `gh` CLI auth,
 * etc. claude-agent-sdk v0.2.113 reverted to no longer overlaying process.env
 * itself, so we must do it here. Then applies the shared Cyrus session flags
 * on top. Callers can spread additional vars on top (e.g., repository .env
 * for live runs).
 */
export function buildBaseSessionEnv(
	extra?: Record<string, string>,
): Record<string, string> {
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
	};

	// Forward PATH
	if (process.env.PATH) {
		env.PATH = process.env.PATH;
	}

	// Forward auth credentials from the parent process — the SDK needs these
	// for API calls. See: https://code.claude.com/docs/en/env-vars
	for (const key of AUTH_ENV_KEYS) {
		if (process.env[key]) {
			env[key] = process.env[key];
		}
	}

	return {
		...env,
		...CYRUS_SESSION_ENV,
		// LLMOps is handled by a SessionEnd hook in ClaudeRunner (see
		// langfuse-exporter.ts), not by env-var-driven OTLP — Claude Code's
		// OTLP output is logs/metrics only, which Langfuse can't ingest.
		...extra,
	};
}

/**
 * Build the env vars that cap how much a single tool result can contribute to
 * the transcript. The bundled Claude CLI honors `BASH_MAX_OUTPUT_LENGTH` (Bash
 * result characters) and `MAX_MCP_OUTPUT_TOKENS` (MCP result tokens); without a
 * cap an oversized result lands in the transcript verbatim and is re-written to
 * the prompt cache on every subsequent turn.
 *
 * Only configured caps are emitted, so an unset value preserves the CLI's own
 * default. Kept here (not inline in ClaudeRunner) so the cold-start and
 * warm-pool paths emit an identical set of keys from one source of truth.
 */
export function buildToolOutputCapEnv(caps: {
	bashMaxOutputLength?: number;
	mcpMaxOutputTokens?: number;
}): Record<string, string> {
	const env: Record<string, string> = {};
	if (caps.bashMaxOutputLength !== undefined) {
		env.BASH_MAX_OUTPUT_LENGTH = String(caps.bashMaxOutputLength);
	}
	if (caps.mcpMaxOutputTokens !== undefined) {
		env.MAX_MCP_OUTPUT_TOKENS = String(caps.mcpMaxOutputTokens);
	}
	return env;
}

/**
 * Normalize MCP server configs loaded from JSON files.
 *
 * Config files (.mcp.json, mcp-*.json) often omit the `type` field,
 * but the SDK requires an explicit discriminator for non-stdio transports.
 * If a config has a `url` but no `type`, set `type = "http"`.
 *
 * Mutates the input records in place.
 */
export function normalizeMcpHttpTransport(
	servers: Record<string, Record<string, unknown>>,
): void {
	for (const cfg of Object.values(servers)) {
		if (!cfg.type && typeof cfg.url === "string") {
			cfg.type = "http";
		}
	}
}
