/**
 * Prompt-version provenance (ported from `pipeline/prompts.py`).
 *
 * Every prompt file (prompts/*.md) carries a version tag. `learn.ts` reads the current
 * tags into each run record (scope_prompt_version / judge_prompt_version) at record time
 * so the version is derived from the live prompt file rather than hand-typed. A missing tag
 * is a broken prompt file, not a default: we throw rather than silently writing "unknown".
 *
 * Two accepted forms (frontmatter wins if both present):
 *     ---
 *     version: scope-v1
 *     ---
 * or an inline HTML comment anywhere in the file:
 *     <!-- version: scope-v1 -->
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promptsDir } from "./paths.js";

// The canonical current prompt files. Bump these (and add the new prompts/*.md) when a
// prompt is revised, so run records attribute to the version that actually ran.
export const SCOPE_PROMPT_FILE = "scope-v1.md";
export const JUDGE_PROMPT_FILE = "judge-v1.md";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/;
const VERSION_LINE_RE = /^version:\s*(.+?)\s*$/m;
const COMMENT_VERSION_RE = /<!--\s*version:\s*(.+?)\s*-->/;

/** A prompt file has no parseable version tag. */
export class MissingPromptVersion extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MissingPromptVersion";
	}
}

export function getPromptVersion(path: string): string {
	const text = readFileSync(path, "utf-8");

	const fm = FRONTMATTER_RE.exec(text);
	if (fm) {
		const v = VERSION_LINE_RE.exec(fm[1]!);
		if (v) return v[1]!.trim().replace(/^['"]+|['"]+$/g, "");
	}

	const c = COMMENT_VERSION_RE.exec(text);
	if (c) return c[1]!.trim();

	throw new MissingPromptVersion(
		`${path}: no '<!-- version: X -->' comment or frontmatter 'version:' line found`,
	);
}

/**
 * The live scope/judge prompt versions, read from the canonical prompt files — for
 * stamping onto a run record so provenance can't drift from a hand-typed value.
 */
export function currentVersions(): {
	scope_prompt_version: string;
	judge_prompt_version: string;
} {
	return {
		scope_prompt_version: getPromptVersion(
			join(promptsDir(), SCOPE_PROMPT_FILE),
		),
		judge_prompt_version: getPromptVersion(
			join(promptsDir(), JUDGE_PROMPT_FILE),
		),
	};
}
