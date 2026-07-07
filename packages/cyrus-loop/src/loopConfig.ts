/**
 * Reader for `~/.cyrus/loop.json` — the loop's OWN config file (decision 3 in
 * docs/CYRUS_LOOP_PLAN.md). Kept deliberately separate from Cyrus's `config.json` so wiring the
 * loop never touches ConfigManager's two hardcoded merge/globalKeys whitelists.
 *
 * The loop reads this independently; when running inside Cyrus the process may also construct a
 * LoopConfig directly and pass it to `new CyrusLoop({ config })` — this file is the standalone /
 * default reader and what the tests exercise.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/** Merge strategy handed to `gh pr merge --<method>` on an approved verdict. */
export const LoopMergeMethodSchema = z.enum(["squash", "merge", "rebase"]);
export type LoopMergeMethod = z.infer<typeof LoopMergeMethodSchema>;

export const LoopJudgeConfigSchema = z.strictObject({
	/** Run the citation-locked judge when a PR is captured (verdict stays hidden regardless). */
	enabled: z.boolean().optional(),
	/** Anthropic model id for the raw-SDK judge backend (decision 4). */
	model: z.string().optional(),
	maxTokens: z.number().int().positive().optional(),
});
export type LoopJudgeConfig = z.infer<typeof LoopJudgeConfigSchema>;

export const LoopConfigSchema = z.strictObject({
	/** Master switch. When false the loop ignores every event. */
	enabled: z.boolean().optional(),
	/**
	 * Repo allowlist (by Cyrus repo `name` or `id`). Absent/empty ⇒ the loop is active for every
	 * repo. A PR whose repo is not on the list is ignored.
	 */
	repos: z.array(z.string()).optional(),
	judge: LoopJudgeConfigSchema.optional(),
	mergeMethod: LoopMergeMethodSchema.optional(),
	/**
	 * When true, an `approved` human verdict automatically runs Integrate (`gh pr merge`). The
	 * blind gate already requires a human verdict, so this only governs whether the *merge* is
	 * hands-free once approved. Default true.
	 */
	autoMerge: z.boolean().optional(),
	/** Pass `--delete-branch` to `gh pr merge`. Default false. */
	deleteBranch: z.boolean().optional(),
});
export type LoopConfig = z.infer<typeof LoopConfigSchema>;

/** Fully-resolved config with every optional filled in — what CyrusLoop actually reads. */
export interface ResolvedLoopConfig {
	enabled: boolean;
	repos: string[];
	judge: { enabled: boolean; model: string; maxTokens: number };
	mergeMethod: LoopMergeMethod;
	autoMerge: boolean;
	deleteBranch: boolean;
}

export const LOOP_DEFAULTS: ResolvedLoopConfig = {
	enabled: true,
	repos: [],
	judge: { enabled: true, model: "claude-opus-4-8", maxTokens: 2048 },
	mergeMethod: "squash",
	autoMerge: true,
	deleteBranch: false,
};

export function resolveLoopConfig(raw: LoopConfig = {}): ResolvedLoopConfig {
	return {
		enabled: raw.enabled ?? LOOP_DEFAULTS.enabled,
		repos: raw.repos ?? LOOP_DEFAULTS.repos,
		judge: {
			enabled: raw.judge?.enabled ?? LOOP_DEFAULTS.judge.enabled,
			model: raw.judge?.model ?? LOOP_DEFAULTS.judge.model,
			maxTokens: raw.judge?.maxTokens ?? LOOP_DEFAULTS.judge.maxTokens,
		},
		mergeMethod: raw.mergeMethod ?? LOOP_DEFAULTS.mergeMethod,
		autoMerge: raw.autoMerge ?? LOOP_DEFAULTS.autoMerge,
		deleteBranch: raw.deleteBranch ?? LOOP_DEFAULTS.deleteBranch,
	};
}

const _cache = new Map<string, ResolvedLoopConfig>();

/** `CYRUS_LOOP_CONFIG` override, else `~/.cyrus/loop.json` (mirrors cyrusAdapter.cyrusConfigPath). */
export function loopConfigPath(): string {
	return (
		process.env.CYRUS_LOOP_CONFIG ?? join(homedir(), ".cyrus", "loop.json")
	);
}

function loadLoopConfigAt(path: string): ResolvedLoopConfig {
	const hit = _cache.get(path);
	if (hit) return hit;
	let resolved: ResolvedLoopConfig;
	if (existsSync(path)) {
		const parsed = LoopConfigSchema.parse(
			JSON.parse(readFileSync(path, "utf-8")),
		);
		resolved = resolveLoopConfig(parsed);
	} else {
		resolved = resolveLoopConfig();
	}
	_cache.set(path, resolved);
	return resolved;
}

/** Cache keyed on the resolved path, so repointing `CYRUS_LOOP_CONFIG` invalidates automatically. */
export function loadLoopConfig(): ResolvedLoopConfig {
	return loadLoopConfigAt(loopConfigPath());
}

export function clearLoopConfigCache(): void {
	_cache.clear();
}

/** Is the loop active for this repo (by Cyrus repo name or id)? Empty allowlist ⇒ all repos. */
export function loopActiveForRepo(
	cfg: ResolvedLoopConfig,
	repoNameOrId: string,
): boolean {
	if (!cfg.enabled) return false;
	if (cfg.repos.length === 0) return true;
	return cfg.repos.includes(repoNameOrId);
}
