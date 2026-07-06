/**
 * Integrate — stage 6 (ported from `pipeline/integrate.py`): land an APPROVED diff by merging
 * its GitHub PR.
 *
 * Deterministic glue, never an LM: read the human diff-gate verdict, and only if it is
 * `approved` merge the run's PR via `gh pr merge`. Authorization is the HUMAN verdict alone,
 * never judge_eval. Two integrity guards:
 *   * The PR + approved commit come from `<run_id>.pr.json` (from capture); absent → refuse.
 *   * SHA-drift guard: if the PR head advanced since the approved diff, refuse.
 * On success it writes a durable merge fact that Learn reads to set `outcome`.
 *
 * `ghselect` is dropped (decision 91): Cyrus already resolves gh tokens, so we run `gh` with the
 * ambient account. The gh runner is injectable for testing.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CmdRun, nowIso, readPrMeta } from "./capture.js";
import { readHumanVerdict } from "./gate.js";
import { gatesDir } from "./paths.js";

const _MERGE_METHODS = ["squash", "rebase", "merge"] as const;
export type MergeMethod = (typeof _MERGE_METHODS)[number];

export class IntegrateError extends Error {}

const defaultGhRun: CmdRun = (args, opts) => {
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

export function mergeFactPath(runId: string): string {
	return join(gatesDir(), `${runId}.integrate.json`);
}

/** The durable merge fact written on a successful merge, or null. Read by Learn. */
export function readMergeFact(runId: string): Record<string, unknown> | null {
	const p = mergeFactPath(runId);
	return existsSync(p)
		? (JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>)
		: null;
}

function ghPrJson(
	run: CmdRun,
	repoDir: string,
	number: number,
	field: string,
): unknown {
	const proc = run(["gh", "pr", "view", String(number), "--json", field], {
		cwd: repoDir,
	});
	if (proc.status !== 0) {
		throw new IntegrateError(
			`gh pr view #${number} failed: ${(proc.stderr || proc.stdout).trim()}`,
		);
	}
	return (JSON.parse(proc.stdout || "{}") as Record<string, unknown>)[field];
}

export interface IntegrateStatus {
	run_id: string;
	integrated: boolean;
	refused: boolean;
	reason?: string;
	pr?: number;
	method?: string;
	merge_commit?: string | null;
	base?: string | null;
	branch_deleted?: boolean;
	outcome?: string;
}

/** Merge the run's PR iff the human approved. Returns a status dict. */
export function integrateRun(
	runId: string,
	repoDir?: string | null,
	opts: {
		method?: MergeMethod;
		deleteBranch?: boolean;
		ghRun?: CmdRun;
	} = {},
): IntegrateStatus {
	const method = opts.method ?? "squash";
	const run = opts.ghRun ?? defaultGhRun;
	if (!(_MERGE_METHODS as readonly string[]).includes(method)) {
		throw new IntegrateError(
			`method must be one of ${_MERGE_METHODS.join(",")}`,
		);
	}

	const human = readHumanVerdict(runId);
	if (human === null) {
		throw new IntegrateError(
			`no human diff-gate verdict recorded for ${runId} — record it before integrating`,
		);
	}
	if (human.verdict !== "approved") {
		// Refuse with NO side effects. Only an approved HUMAN verdict authorizes landing.
		return {
			run_id: runId,
			integrated: false,
			refused: true,
			reason: `human verdict is ${JSON.stringify(human.verdict)}, not 'approved' — not merging`,
		};
	}

	const meta = readPrMeta(runId);
	if (meta === null) {
		throw new IntegrateError(
			`no PR metadata for ${runId} (data/gates/${runId}.pr.json) — run capture first`,
		);
	}
	const number = meta.number;
	const dir = repoDir ?? meta.repo_dir;
	if (!dir) {
		throw new IntegrateError(
			`no repo dir for ${runId} — pass repoDir (pr.json had none)`,
		);
	}

	// SHA-drift guard: the human approved meta.head_sha; if the PR head moved, merging would land
	// a commit the human never reviewed. Refuse rather than merge blind.
	const approvedSha = meta.head_sha;
	const currentSha = ghPrJson(run, dir, number, "headRefOid") as string | null;
	if (approvedSha && currentSha && currentSha !== approvedSha) {
		throw new IntegrateError(
			`PR #${number} head advanced since the approved diff (${approvedSha.slice(0, 9)} -> ${currentSha.slice(0, 9)}); re-run capture and re-gate`,
		);
	}

	const mergeArgs = ["gh", "pr", "merge", String(number), `--${method}`];
	if (opts.deleteBranch) mergeArgs.push("--delete-branch");
	const proc = run(mergeArgs, { cwd: dir });
	if (proc.status !== 0) {
		throw new IntegrateError(
			`gh pr merge #${number} (--${method}) failed: ${(proc.stderr || proc.stdout).trim()}`,
		);
	}

	// Best-effort: record the squashed merge commit. Absence must not undo the merge.
	let mergeCommit: string | null = null;
	try {
		const mc = (ghPrJson(run, dir, number, "mergeCommit") ?? {}) as {
			oid?: string;
		};
		mergeCommit = mc && typeof mc === "object" ? (mc.oid ?? null) : null;
	} catch (e) {
		if (!(e instanceof IntegrateError)) throw e;
	}

	const fact = {
		run_id: runId,
		merged: true,
		pr: number,
		method,
		merge_commit: mergeCommit,
		base: meta.base ?? null,
		head_sha: approvedSha ?? null,
		at: nowIso(),
	};
	writeFileSync(mergeFactPath(runId), JSON.stringify(fact, null, 2), "utf-8");

	return {
		run_id: runId,
		integrated: true,
		refused: false,
		pr: number,
		method,
		merge_commit: mergeCommit,
		base: meta.base ?? null,
		branch_deleted: opts.deleteBranch ?? false,
		outcome: "merged",
	};
}
