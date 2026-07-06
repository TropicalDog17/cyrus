/**
 * Read-only adapter over an already-running Cyrus fleet (ported from `pipeline/cyrus_adapter.py`).
 *
 * The executor is opaque: we wrap Cyrus, never fork it. This reads ~/.cyrus/config.json (plain
 * JSON — never mutated) plus our own tier side-file, and exposes exactly what the loop needs:
 * repo → tier, repo → allowedTools boundary, and the worktree path for a run.
 *
 * Note: when the loop runs INSIDE Cyrus it will inject the RepositoryConfig directly; these
 * config-file readers are the standalone/CLI fallback (and what the ported tests exercise).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadYaml } from "./config.js";
import { configDir } from "./paths.js";

export interface CyrusRepo {
	id?: string;
	name?: string;
	repositoryPath?: string;
	workspaceBaseDir?: string;
	baseBranch?: string;
	allowedTools?: unknown;
	labelPrompts?: Record<string, { allowedTools?: unknown; labels?: unknown }>;
	[k: string]: unknown;
}

export interface CyrusConfig {
	repositories?: CyrusRepo[];
	linearWorkspaces?: Record<string, { linearToken?: string }>;
	[k: string]: unknown;
}

const _cache = new Map<string, CyrusConfig>();

export function cyrusConfigPath(): string {
	return process.env.CYRUS_CONFIG ?? join(homedir(), ".cyrus", "config.json");
}

function loadCyrusConfigAt(path: string): CyrusConfig {
	const hit = _cache.get(path);
	if (hit) return hit;
	const cfg: CyrusConfig = existsSync(path)
		? (JSON.parse(readFileSync(path, "utf-8")) as CyrusConfig)
		: { repositories: [], linearWorkspaces: {} };
	_cache.set(path, cfg);
	return cfg;
}

/** Cache keyed on the resolved CYRUS_CONFIG path, so repointing invalidates automatically. */
export function loadCyrusConfig(): CyrusConfig {
	return loadCyrusConfigAt(cyrusConfigPath());
}

export function clearCyrusConfigCache(): void {
	_cache.clear();
}

export function repositories(): CyrusRepo[] {
	return loadCyrusConfig().repositories ?? [];
}

export function findRepo(nameOrId: string): CyrusRepo | null {
	for (const r of repositories()) {
		if (r.name === nameOrId || r.id === nameOrId) return r;
	}
	return null;
}

interface TierSideFile {
	by_id?: Record<string, { name?: string; tier: string; class?: string }>;
}

function tierSideFile(): TierSideFile {
	const p = join(configDir(), "repo_tiers.json");
	return existsSync(p)
		? (JSON.parse(readFileSync(p, "utf-8")) as TierSideFile)
		: {};
}

/** Repo's default/ceiling tier. work_repos (route.yaml) force `full`. */
export function tierFor(nameOrId: string): string {
	const repo = findRepo(nameOrId);
	const workRepos = new Set(
		(loadYaml("route.yaml").work_repos as string[] | undefined) ?? [],
	);
	if (repo?.name && workRepos.has(repo.name)) return "full";
	const byId = tierSideFile().by_id ?? {};
	if (repo?.id && byId[repo.id]) return byId[repo.id]!.tier;
	for (const entry of Object.values(byId)) {
		if (entry.name === nameOrId) return entry.tier;
	}
	return "feature"; // conservative default
}

export interface AllowedToolsResolution {
	source: string;
	allowedTools: unknown;
	inherits_cyrus_defaults: boolean;
	note?: string;
}

/** Report the allowedTools boundary in Cyrus's own resolution ORDER. */
export function resolveAllowedTools(
	nameOrId: string,
	role?: string | null,
): AllowedToolsResolution {
	const repo = findRepo(nameOrId);
	if (repo === null) {
		return {
			source: "unknown_repo",
			allowedTools: null,
			inherits_cyrus_defaults: true,
		};
	}
	const labelPrompts = repo.labelPrompts ?? {};
	if (role && labelPrompts[role] && "allowedTools" in labelPrompts[role]!) {
		return {
			source: `labelPrompts.${role}.allowedTools`,
			allowedTools: labelPrompts[role]!.allowedTools,
			inherits_cyrus_defaults: false,
		};
	}
	if ("allowedTools" in repo) {
		return {
			source: "repository.allowedTools",
			allowedTools: repo.allowedTools,
			inherits_cyrus_defaults: false,
		};
	}
	return {
		source: "cyrus_defaults",
		allowedTools: null,
		inherits_cyrus_defaults: true,
		note: "Boundary resolved by Cyrus (promptDefaults / linearAllowedTools / LINEAR_DEFAULT_ALLOWED_TOOLS). Not re-derived here.",
	};
}

/** Where Cyrus puts the worktree: join(workspaceBaseDir, issue.identifier). */
export function worktreePath(nameOrId: string, issueId: string): string | null {
	const repo = findRepo(nameOrId);
	if (repo === null || !repo.workspaceBaseDir) return null;
	return join(repo.workspaceBaseDir, issueId);
}
