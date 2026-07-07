/**
 * Filesystem layout for the loop (ported from `pipeline/paths.py`).
 *
 * Bundled policy assets (prompts/, templates/, config/) ship inside the package and
 * resolve relative to it. Runtime data (runs.jsonl, ledgers, gates, failures) lives
 * outside the package — by default under `~/.cyrus/loop` so it survives package
 * reinstalls and is shared across the one Cyrus process.
 *
 * Env overrides:
 *   AGENTIC_PIPELINE_ROOT  assets root   (default: the package root)
 *   AGENTIC_PIPELINE_DATA  runtime data  (default: ~/.cyrus/loop)
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `<pkg>/src/paths.ts` (vitest) or `<pkg>/dist/paths.js` (built) → `<pkg>`. Both `src`
// and `dist` are direct children of the package root, so one `..` is correct either way.
const _MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const _DEFAULT_ROOT = resolve(_MODULE_DIR, "..");

/**
 * run_id = YYYY-MM-DD-<ISSUE>[-pr<N>]. The optional `-pr<N>` suffix disambiguates two PRs for
 * the same issue on the same day — the retry-2 path (fresh worktree → new PR) would otherwise
 * collide. The suffix is optional so hand-authored / pre-PR run_ids (YYYY-MM-DD-ISSUE) still
 * parse. `pr` starts with letters, so it can never be confused with the issue's trailing -<N>.
 */
export const RUN_ID_RE =
	/^(\d{4}-\d{2}-\d{2})-([A-Za-z][A-Za-z0-9]*-\d+)(?:-pr(\d+))?$/;

function ensureDir(d: string): string {
	if (!existsSync(d)) mkdirSync(d, { recursive: true });
	return d;
}

export function root(): string {
	return resolve(process.env.AGENTIC_PIPELINE_ROOT ?? _DEFAULT_ROOT);
}

/** Runtime data — created on demand. Never committed. */
export function dataDir(): string {
	const d =
		process.env.AGENTIC_PIPELINE_DATA ?? join(homedir(), ".cyrus", "loop");
	return ensureDir(d);
}

/** The append-only substrate. One JSON object per line. */
export function runsFile(): string {
	return join(dataDir(), "runs.jsonl");
}

export function ledgersDir(): string {
	return ensureDir(join(dataDir(), "ledgers"));
}

export function ledgerFile(runId: string): string {
	return join(ledgersDir(), `${runId}.jsonl`);
}

/** Per-run evidence artifacts (e.g. logs/E1.txt referenced from the ledger). */
export function logsDir(runId: string): string {
	return ensureDir(join(ledgersDir(), runId, "logs"));
}

export function gatesDir(): string {
	return ensureDir(join(dataDir(), "gates"));
}

export function failuresDir(): string {
	return ensureDir(join(dataDir(), "failures"));
}

export function promptsDir(): string {
	return join(root(), "prompts");
}

export function templatesDir(): string {
	return join(root(), "templates");
}

export function configDir(): string {
	return join(root(), "config");
}

export interface RunId {
	date: string; // YYYY-MM-DD
	issueId: string; // e.g. DEV-123
	pr: number | null; // PR number, or null for a pre-PR / hand-authored run_id
}

/**
 * Split a run_id into (date, issueId, pr). The single place run_ids are decomposed —
 * replaces fixed-offset slicing that the optional `-pr<N>` suffix would silently corrupt.
 * Throws on a malformed id rather than returning a wrong slice.
 */
export function parseRunId(runId: string): RunId {
	const m = RUN_ID_RE.exec(runId ?? "");
	if (!m) {
		throw new Error(
			`malformed run_id: ${JSON.stringify(runId)} (want YYYY-MM-DD-ISSUE[-prN])`,
		);
	}
	return {
		date: m[1]!,
		issueId: m[2]!,
		pr: m[3] ? Number.parseInt(m[3], 10) : null,
	};
}

/** Build a run_id, appending the `-pr<N>` disambiguator when a PR number is known. */
export function makeRunId(
	date: string,
	issueId: string,
	pr: number | null = null,
): string {
	const base = `${date}-${issueId}`;
	return pr !== null ? `${base}-pr${pr}` : base;
}
