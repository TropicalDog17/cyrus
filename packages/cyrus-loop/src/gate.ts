/**
 * Blind diff gate (ported from `pipeline/gate.py`).
 *
 * The reviewer sees the diff and the evidence ledger ONLY. The judge's verdict is revealed
 * AFTER the human verdict is recorded; both are stored independently:
 *   * The review package is BUILT from inputs that structurally never include the judge output.
 *   * `reveal` refuses until the human verdict's file exists (a temporal gate).
 *   * Recording the human verdict is idempotent-refusing (no silent overwrite) via O_EXCL.
 */

import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import {
	deriveJudgeEval,
	evidenceIdsCited,
	HUMAN_VERDICTS,
	type JudgeVerdictResult,
	ledgerIds,
	validateJudgeOutput,
} from "./judge.js";
import { dataDir, gatesDir, ledgerFile } from "./paths.js";
import type { LedgerEntry } from "./schemas.js";

// Re-export so gate and judge share ONE human-verdict vocabulary (can't silently drift).
export { HUMAN_VERDICTS } from "./judge.js";

const _TAGS = new Set(["recurring", "one-off"]);

export interface Finding {
	text: string;
	tag: string;
	rule_ineffective?: string | null;
	matched_rule_not_loaded?: string | null;
}

export interface HumanVerdictRecord {
	verdict: string;
	findings: Finding[];
	head_sha: string | null;
	recorded_at: string;
}

function humanPath(runId: string): string {
	return join(gatesDir(), `${runId}.human.json`);
}

function judgePath(runId: string): string {
	return join(gatesDir(), `${runId}.judge.json`);
}

function nowIso(): string {
	return new Date().toISOString();
}

function readLedger(runId: string): LedgerEntry[] {
	const p = ledgerFile(runId);
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf-8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as LedgerEntry);
}

export interface ReviewPackage {
	run_id: string;
	diff: string;
	ledger: LedgerEntry[];
	diffscan_warnings: LedgerEntry[];
	note: string;
}

/**
 * What the human sees at the gate: diff pointer + ledger. NEVER the judge output. Built only
 * from the diff and ledger inputs, so judge fields cannot leak by construction.
 */
export function reviewPackage(runId: string): ReviewPackage {
	const ledger = readLedger(runId);
	const warns = ledger.filter((e) => e.result === "warn");
	return {
		run_id: runId,
		diff: join(dataDir(), "diffs", `${runId}.diff`),
		ledger,
		diffscan_warnings: warns, // surfaced up top; human decides if they matter
		note: "Judge verdict intentionally withheld until your verdict is recorded.",
	};
}

/** Human verdict already recorded (label integrity) — no silent overwrite. */
export class HumanVerdictExists extends Error {}

export function recordHumanVerdict(
	runId: string,
	verdict: string,
	findings: Finding[],
	opts: { headSha?: string | null; force?: boolean } = {},
): HumanVerdictRecord {
	if (!HUMAN_VERDICTS.has(verdict)) {
		throw new Error(`verdict must be one of ${[...HUMAN_VERDICTS].sort()}`);
	}
	for (const f of findings) {
		if (!_TAGS.has(f.tag)) {
			throw new Error(
				`each finding needs tag in ${[..._TAGS].sort()}: ${JSON.stringify(f)}`,
			);
		}
	}
	// `head_sha` binds the verdict to the exact PR head it reviewed. A later push to a different
	// SHA supersedes this verdict instead of deadlocking Integrate's SHA-drift guard.
	const record: HumanVerdictRecord = {
		verdict,
		findings,
		head_sha: opts.headSha ?? null,
		recorded_at: nowIso(),
	};
	const payload = JSON.stringify(record, null, 2);
	// Atomic create-exclusive (wx = O_CREAT|O_EXCL) so a double-submit can't defeat the
	// no-silent-overwrite guarantee via a check-then-write race. force=true overwrites (w).
	const path = humanPath(runId);
	let fd: number;
	try {
		fd = openSync(path, opts.force ? "w" : "wx", 0o644);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") {
			throw new HumanVerdictExists(
				`human verdict for ${runId} already recorded (label integrity); use force to override`,
			);
		}
		throw e;
	}
	try {
		writeSync(fd, payload);
	} finally {
		closeSync(fd);
	}
	return record;
}

/**
 * Store the judge's verdict independently. Re-runs it through the citation-locked validator
 * against THIS run's ledger before writing — so no caller can persist an ungrounded/malformed
 * verdict. It is simply not REVEALED until the human has recorded theirs.
 */
export function storeJudgeVerdict(
	runId: string,
	validated: string | unknown,
): JudgeVerdictResult {
	const revalidated = validateJudgeOutput(
		validated,
		ledgerIds(readLedger(runId)),
	);
	writeFileSync(
		judgePath(runId),
		JSON.stringify(revalidated, null, 2),
		"utf-8",
	);
	return revalidated;
}

/**
 * The recorded human diff-gate verdict, or null if not yet recorded. Only the HUMAN verdict
 * authorizes a merge; the judge never does, so this deliberately does NOT touch the judge.
 */
export function readHumanVerdict(runId: string): HumanVerdictRecord | null {
	const p = humanPath(runId);
	if (!existsSync(p)) return null;
	return JSON.parse(readFileSync(p, "utf-8")) as HumanVerdictRecord;
}

export interface SupersedeResult {
	run_id: string;
	superseded_sha: string | null;
	new_sha: string | null;
	archived: Record<string, string>;
}

/**
 * A new PR head supersedes a verdict bound to an older SHA. Archive the human (and any judge)
 * verdict under a `.superseded.<sha>.json` name so readHumanVerdict returns null (the gate
 * REOPENS on the fresh diff) while the label is preserved verbatim — never discarded.
 */
export function supersedeVerdict(
	runId: string,
	approvedSha: string | null,
	newSha: string | null,
): SupersedeResult {
	const tag = (approvedSha ?? "unknown").slice(0, 12);
	const archived: Record<string, string> = {};
	for (const [path, kind] of [
		[humanPath(runId), "human"],
		[judgePath(runId), "judge"],
	] as const) {
		if (!existsSync(path)) continue;
		let dest = join(gatesDir(), `${runId}.${kind}.superseded.${tag}.json`);
		let n = 1;
		while (existsSync(dest)) {
			dest = join(gatesDir(), `${runId}.${kind}.superseded.${tag}.${n}.json`);
			n += 1;
		}
		renameSync(path, dest);
		archived[kind] = dest;
	}
	return {
		run_id: runId,
		superseded_sha: approvedSha,
		new_sha: newSha,
		archived,
	};
}

export interface RevealResult {
	run_id: string;
	human: HumanVerdictRecord;
	judge: JudgeVerdictResult | null;
	judge_eval: string | null;
	judge_evidence_ids: string[];
}

/** Blind gate REFUSES to reveal before a human verdict exists. */
export class RevealBeforeHuman extends Error {}

/** Reveal the judge verdict + derived judge_eval — ONLY after the human recorded. */
export function reveal(runId: string): RevealResult {
	const hp = humanPath(runId);
	if (!existsSync(hp)) {
		throw new RevealBeforeHuman(
			`blind gate: human verdict for ${runId} not yet recorded — judge stays hidden`,
		);
	}
	const human = JSON.parse(readFileSync(hp, "utf-8")) as HumanVerdictRecord;
	const jp = judgePath(runId);
	const judgeVerdict = existsSync(jp)
		? (JSON.parse(readFileSync(jp, "utf-8")) as JudgeVerdictResult)
		: null;
	const jv = judgeVerdict ? judgeVerdict.verdict : "skip";
	return {
		run_id: runId,
		human,
		judge: judgeVerdict,
		judge_eval: deriveJudgeEval(jv, human.verdict),
		judge_evidence_ids: judgeVerdict ? evidenceIdsCited(judgeVerdict) : [],
	};
}

/**
 * Parse a `TEXT::TAG` finding token (as the CLI accepts). No "::" → the whole token is text and
 * the tag is left as the raw remainder-less value (rejected cleanly downstream). When "::" IS
 * present, keep the real (possibly empty) text — never substitute the raw string, which would
 * smuggle the tag back into the persisted `text` field (label-integrity corruption).
 */
export function parseFindingArg(raw: string): Finding {
	const idx = raw.lastIndexOf("::");
	if (idx === -1) {
		return { text: raw, tag: "", rule_ineffective: null };
	}
	return {
		text: raw.slice(0, idx),
		tag: raw.slice(idx + 2),
		rule_ineffective: null,
	};
}
