import { homedir } from "node:os";
import { compute, nodeDirLister, toClaudeToolPatterns } from "cyrus-core";

/**
 * Build disallowed Read patterns for everything in the user's home directory
 * that is not on the path to the cwd or any of the additional allowed paths.
 *
 * Thin compatibility wrapper around cyrus-core's {@link compute} +
 * {@link toClaudeToolPatterns}. The concrete home-directory sibling-exclusion
 * walk now lives in `cyrus-core/access-policy/AccessPolicy.ts` so the cold path
 * (ClaudeRunner.start), the warm path (EdgeWorker.warmupSessions), and the OS
 * sandbox layer all derive their access from the same deterministic policy.
 *
 * Returns ONLY the home-directory `Read(...)` denials (no config-level tool
 * denials and no allow patterns), preserving this function's historical
 * contract for any remaining importers.
 *
 * Claude Code requires an extra leading `/` for absolute paths in tool
 * patterns. See: https://docs.anthropic.com/en/docs/claude-code/settings#read-edit
 */
export function buildHomeDirectoryDisallowedTools(
	cwd: string,
	additionalAllowedPaths: string[] = [],
): string[] {
	const { disallowedTools } = toClaudeToolPatterns(
		compute({
			homeDir: homedir(),
			dirLister: nodeDirLister,
			cwd,
			allowReadDirectories: additionalAllowedPaths,
		}),
	);
	return disallowedTools;
}
