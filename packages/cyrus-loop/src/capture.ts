/**
 * Evidence capture for a Cyrus PR (adapted from `pipeline/pr_watch.py`).
 *
 * The Python original polled `gh pr list` on a cron. In the fork the trigger is the EdgeWorker
 * `prOpened` event, so the `gh pr list` poll (`watch`, `discover_*`) is DROPPED. What remains is
 * the capture logic — pure PR→run_id mapping, the `shouldCapture` idempotency/supersede rules,
 * and `captureEvidence` (diff + ledger + PR metadata) — driven by an event payload (`pr`).
 *
 * External commands (git/gh) and the worktree/ledger lookups are injected so this is unit-
 * testable without a real repo (mirrors the Python tests' monkeypatching).
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as cyrusAdapter from "./cyrusAdapter.js";
import * as gate from "./gate.js";
import * as ledger from "./ledger.js";
import { dataDir, gatesDir, makeRunId } from "./paths.js";

// The literal marker Cyrus appends to every PR body it touches (PrMarkerHook.CYRUS_PR_MARKER).
export const CYRUS_PR_MARKER = "<!-- generated-by-cyrus -->";

// Linear's gitBranchName is `handle/IDENT-slug`; the fallback is `IDENT-slug`. Match the
// identifier at the START of the last path segment so a username that itself contains a
// `-<digits>` run (e.g. `john-5smith/...`) can't be mistaken for the issue id.
const _IDENT_RE = /^([A-Za-z]+-\d+)/;

export class PRWatchError extends Error {}

export interface PullRequest {
	number?: number;
	headRefName?: string;
	headRefOid?: string;
	baseRefName?: string;
	createdAt?: string;
	url?: string;
	body?: string;
	[k: string]: unknown;
}

export type CmdRun = (
	args: string[],
	opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => { status: number; stdout: string; stderr: string };

const defaultRun: CmdRun = (args, opts) => {
	const r = spawnSync(args[0]!, args.slice(1), {
		cwd: opts?.cwd,
		env: opts?.env,
		encoding: "utf-8",
	});
	return {
		status: r.status ?? 1,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
	};
};

export function nowIso(): string {
	return new Date().toISOString();
}

// --- pure mapping helpers ----------------------------------------------------------------

/** True iff the PR body carries Cyrus's marker (positively confirms Cyrus authorship). */
export function isCyrusPr(pr: PullRequest): boolean {
	return (pr.body ?? "").includes(CYRUS_PR_MARKER);
}

/** Recover the Linear identifier (upper-cased, e.g. `DEV-123`) from a PR head branch. */
export function issueIdFromBranch(branch: string): string | null {
	const tail = (branch ?? "").split("/").pop() ?? "";
	const m = _IDENT_RE.exec(tail);
	return m ? m[1]!.toUpperCase() : null;
}

/**
 * (run_id, issue_id) for a PR, or null if it can't be derived. run_id anchors on the PR's
 * createdAt date (stable across polls) and folds in the PR number (`-pr<N>`) so retry-2's second
 * PR for the same issue on the same day gets its own run_id.
 */
export function runIdForPr(pr: PullRequest): [string, string] | null {
	const issueId = issueIdFromBranch(pr.headRefName ?? "");
	const created = pr.createdAt ?? "";
	const number = pr.number;
	if (
		!issueId ||
		created.length < 10 ||
		number === undefined ||
		number === null
	) {
		return null;
	}
	return [makeRunId(created.slice(0, 10), issueId, number), issueId];
}

// --- paths -------------------------------------------------------------------------------

function diffPath(runId: string): string {
	const d = join(dataDir(), "diffs");
	mkdirSync(d, { recursive: true });
	return join(d, `${runId}.diff`);
}

export function prMetaPath(runId: string): string {
	return join(gatesDir(), `${runId}.pr.json`);
}

export interface PrMeta {
	run_id: string;
	issue_id?: string;
	repo?: string;
	repo_dir?: string;
	number: number;
	url?: string;
	branch?: string;
	base?: string | null;
	head_sha?: string | null;
	created_at?: string;
	captured_at?: string;
}

export function readPrMeta(runId: string): PrMeta | null {
	const p = prMetaPath(runId);
	return existsSync(p)
		? (JSON.parse(readFileSync(p, "utf-8")) as PrMeta)
		: null;
}

export function abandonFactPath(runId: string): string {
	return join(gatesDir(), `${runId}.abandoned.json`);
}

export function readAbandonFact(runId: string): Record<string, unknown> | null {
	const p = abandonFactPath(runId);
	return existsSync(p)
		? (JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>)
		: null;
}

// --- should_capture ----------------------------------------------------------------------

export interface CaptureDecision {
	capture: boolean;
	reason: string;
}

/**
 * Decide whether to (re)capture evidence for this PR head. Idempotent + supersede-aware:
 *   * human verdict bound to THIS head SHA (or to no SHA) → locked, never re-capture.
 *   * human verdict bound to a DIFFERENT (older) SHA → superseded; re-capture so the gate
 *     reopens (else this lock and Integrate's SHA-drift guard deadlock each other).
 *   * a completed capture (diff + .pr.json meta, written LAST) at this exact SHA → skip.
 *   * otherwise capture (new PR, or the agent pushed more commits before the gate ran).
 */
export function shouldCapture(
	runId: string,
	headSha: string | null,
): CaptureDecision {
	const human = gate.readHumanVerdict(runId);
	if (human !== null) {
		const approvedSha = human.head_sha;
		if (!approvedSha || approvedSha === headSha) {
			return {
				capture: false,
				reason: "human verdict already recorded — locked",
			};
		}
		return {
			capture: true,
			reason: `verdict superseded: approved ${approvedSha.slice(0, 9)} != head ${String(headSha).slice(0, 9)}`,
		};
	}
	const diff = diffPath(runId);
	const meta = readPrMeta(runId);
	// `.pr.json` is written LAST, so its presence at this head SHA proves the capture completed.
	if (existsSync(diff) && meta && meta.head_sha === headSha) {
		return { capture: false, reason: "already captured at this head SHA" };
	}
	if (meta && meta.head_sha !== headSha) {
		return {
			capture: true,
			reason: `head advanced ${String(meta.head_sha).slice(0, 9)}->${String(headSha).slice(0, 9)}`,
		};
	}
	return { capture: true, reason: "new" };
}

// --- diff helpers ------------------------------------------------------------------------

function writeWorktreeDiff(
	worktree: string,
	base: string | null,
	runId: string,
	run: CmdRun,
	resolveBaseRef: (repoDir: string, base: string | null) => string | null,
): boolean {
	const ref = resolveBaseRef(worktree, base);
	if (base && ref === null) return false; // declared base unresolvable — don't gate on empty diff
	const diffRef = ref ? `${ref}...HEAD` : "HEAD";
	const proc = run(["git", "-C", worktree, "diff", diffRef], { cwd: worktree });
	if (proc.status !== 0) return false;
	writeFileSync(diffPath(runId), proc.stdout, "utf-8");
	return true;
}

function ephemeralWorktree(
	repoDir: string,
	pr: PullRequest,
	run: CmdRun,
): string | null {
	const number = pr.number;
	const parent = mkdtempSync(join(tmpdir(), "pr-watch-"));
	const wt = join(parent, "wt"); // `git worktree add` creates this; it must not pre-exist
	const fetch = run([
		"git",
		"-C",
		repoDir,
		"fetch",
		"--quiet",
		"origin",
		`pull/${number}/head`,
	]);
	if (fetch.status !== 0) {
		rmSync(parent, { recursive: true, force: true });
		return null;
	}
	const add = run([
		"git",
		"-C",
		repoDir,
		"worktree",
		"add",
		"--detach",
		wt,
		"FETCH_HEAD",
	]);
	if (add.status !== 0) {
		rmSync(parent, { recursive: true, force: true });
		return null;
	}
	return wt;
}

function removeEphemeralWorktree(
	repoDir: string,
	wt: string,
	run: CmdRun,
): void {
	run(["git", "-C", repoDir, "worktree", "remove", "--force", wt]);
	rmSync(dirname(wt), { recursive: true, force: true });
}

function writeGhPrDiff(
	repoDir: string,
	number: number,
	runId: string,
	run: CmdRun,
): boolean {
	const proc = run(["gh", "pr", "diff", String(number)], { cwd: repoDir });
	if (proc.status !== 0) return false;
	writeFileSync(diffPath(runId), proc.stdout, "utf-8");
	return true;
}

export interface CaptureDeps {
	run?: CmdRun;
	worktreePath?: (repo: string, issueId: string) => string | null;
	runLedger?: (
		runId: string,
		repo: string,
		repoDir: string,
		base: string | null,
		specText: string,
	) => unknown | Promise<unknown>;
	resolveBaseRef?: (repoDir: string, base: string | null) => string | null;
}

export interface CaptureResult {
	run_id?: string;
	issue_id?: string;
	captured: boolean;
	reason?: string;
	ran_ledger?: boolean;
	superseded?: gate.SupersedeResult | null;
	pr?: number;
}

/**
 * Capture the diff + run the mechanical ledger for one open Cyrus PR, then persist PR metadata
 * (`<run_id>.pr.json`) that Integrate reads. Idempotent via shouldCapture.
 */
export async function captureEvidence(
	repoName: string,
	repoDir: string,
	pr: PullRequest,
	deps: CaptureDeps = {},
): Promise<CaptureResult> {
	const run = deps.run ?? defaultRun;
	const worktreePathFn = deps.worktreePath ?? cyrusAdapter.worktreePath;
	const runLedgerFn = deps.runLedger ?? ledger.runLedger;
	const resolveBaseRefFn = deps.resolveBaseRef ?? ledger.resolveBaseRef;

	const derived = runIdForPr(pr);
	if (derived === null) {
		return { pr: pr.number, captured: false, reason: "no issue id in branch" };
	}
	const [runId, issueId] = derived;
	const headSha = pr.headRefOid ?? null;
	const decision = shouldCapture(runId, headSha);
	if (!decision.capture) {
		return { run_id: runId, captured: false, reason: decision.reason };
	}

	// The only True-with-verdict case is supersede (head advanced past the approved SHA). Archive
	// that stale verdict now so the gate reopens and Integrate won't act on a vanished commit.
	let superseded: gate.SupersedeResult | null = null;
	const prior = gate.readHumanVerdict(runId);
	if (prior !== null) {
		superseded = gate.supersedeVerdict(runId, prior.head_sha ?? null, headSha);
	}

	const base = pr.baseRefName ?? null;
	let worktree = worktreePathFn(repoName, issueId);
	let ephemeral: string | null = null;
	if (worktree === null || !existsSync(worktree)) {
		// No live Cyrus worktree — build an ephemeral one from the PR head so the ledger runs.
		ephemeral = ephemeralWorktree(repoDir, pr, run);
		worktree = ephemeral;
	}

	let ranLedger = false;
	try {
		if (worktree !== null) {
			if (!writeWorktreeDiff(worktree, base, runId, run, resolveBaseRefFn)) {
				// Base unresolvable — fall back to GitHub's own diff, but still run the ledger.
				if (!writeGhPrDiff(repoDir, pr.number!, runId, run)) {
					throw new PRWatchError(
						`could not capture a diff for ${runId}: worktree base ${JSON.stringify(base)} did not resolve and \`gh pr diff ${pr.number}\` failed`,
					);
				}
			}
			await runLedgerFn(runId, repoName, worktree, base, "");
			ranLedger = true;
		} else if (!writeGhPrDiff(repoDir, pr.number!, runId, run)) {
			throw new PRWatchError(
				`no worktree, ephemeral checkout failed, and \`gh pr diff ${pr.number}\` failed for ${runId}`,
			);
		}
	} finally {
		if (ephemeral !== null) removeEphemeralWorktree(repoDir, ephemeral, run);
	}

	const meta: PrMeta = {
		run_id: runId,
		issue_id: issueId,
		repo: repoName,
		repo_dir: repoDir,
		number: pr.number!,
		url: pr.url,
		branch: pr.headRefName,
		base,
		head_sha: headSha,
		created_at: pr.createdAt, // PR-open time — the true start of gate latency
		captured_at: nowIso(),
	};
	writeFileSync(prMetaPath(runId), JSON.stringify(meta, null, 2), "utf-8");
	return {
		run_id: runId,
		issue_id: issueId,
		captured: true,
		reason: decision.reason,
		ran_ledger: ranLedger,
		superseded,
		pr: pr.number,
	};
}
