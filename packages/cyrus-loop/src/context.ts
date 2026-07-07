/**
 * Context — assemble the bundle injected into a run (ported from `pipeline/context.py`,
 * DESIGN.md stage 3).
 *
 * The bundle is AGENTS.md (already in the worktree via git) + the repo's failures.md +
 * (for personal repos only) the personal global failures file. The manifest is logged verbatim
 * into runs.jsonl `context_manifest`, with mutable members pinned by content hash so you can
 * tell WHICH version of failures.md a run actually saw.
 *
 * Anti-goal: personal and work failure libraries never mix. A work repo loads ONLY its own
 * failures file — never the personal `_global.md`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadYaml } from "./config.js";
import { failuresDir, templatesDir } from "./paths.js";

export const GLOBAL_NAME = "_global.md";

interface ContextConfig {
	work_repos?: string[];
	[key: string]: unknown;
}

export function repoFailuresPath(repo: string): string {
	return join(failuresDir(), `${repo}.md`);
}

/** First 8 hex chars of the file's sha256 — the content pin recorded in the manifest. */
function contentHash(path: string): string {
	return createHash("sha256")
		.update(readFileSync(path))
		.digest("hex")
		.slice(0, 8);
}

/** Create the repo's failures.md from the template if it doesn't exist yet. */
export function ensureFailuresFile(repo: string): string {
	const p = repoFailuresPath(repo);
	if (!existsSync(p)) {
		const template = readFileSync(join(templatesDir(), "failures.md"), "utf-8");
		writeFileSync(p, template.replaceAll("<repo>", repo), "utf-8");
	}
	return p;
}

export interface Bundle {
	repo: string;
	manifest: string[];
	files: string[];
	text: string; // concatenated failures content that gets injected
}

export function buildBundle(repo: string, cfg?: ContextConfig | null): Bundle {
	const c = cfg ?? (loadYaml("route.yaml") as ContextConfig);
	const workRepos = new Set(c.work_repos ?? []);

	const manifest = ["AGENTS.md"]; // present in the worktree via git; noted for provenance
	const files: string[] = [];
	const chunks: string[] = [];

	const repoFile = ensureFailuresFile(repo);
	manifest.push(`failures/${repo}.md@${contentHash(repoFile)}`);
	files.push(repoFile);
	chunks.push(readFileSync(repoFile, "utf-8"));

	// Personal global rides along only for personal repos (never mix with work).
	if (!workRepos.has(repo)) {
		const globalFile = join(failuresDir(), GLOBAL_NAME);
		if (existsSync(globalFile)) {
			manifest.push(`failures/${GLOBAL_NAME}@${contentHash(globalFile)}`);
			files.push(globalFile);
			chunks.push(readFileSync(globalFile, "utf-8"));
		}
	}

	return { repo, manifest, files, text: chunks.join("\n\n") };
}
