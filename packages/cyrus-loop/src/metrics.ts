/**
 * Metrics — everything computable from runs.jsonl, nothing invented (ported from
 * `pipeline/metrics.py`).
 *
 * Guardrails baked in:
 *   * Judge quality's PRIMARY number is missed_fail_rate (recall on human-rejected diffs), not
 *     raw agreement — a judge that always says "pass" scores high on agreement while catching
 *     zero real failures.
 *   * waiting_minutes (human-gate latency) is kept SEPARATE from agent_minutes.
 *
 * `spec_edit_distance` uses a faithful re-implementation of CPython `difflib.SequenceMatcher`
 * (Ratcliff-Obershelp matching blocks) rather than the npm `difflib` dep, so the ratio matches
 * Python's values exactly and pulls in no dependency.
 */

import { ruleRewriteCandidates } from "./learn.js";
import type { RunRecord } from "./schemas.js";

// --- CPython difflib.SequenceMatcher.ratio() (word-level; no isjunk) ----------------------

function matchingBlocksSize(a: string[], b: string[]): number {
	const b2j = new Map<string, number[]>();
	for (let i = 0; i < b.length; i++) {
		const x = b[i]!;
		const arr = b2j.get(x);
		if (arr) arr.push(i);
		else b2j.set(x, [i]);
	}
	// autojunk: for len(b) >= 200, drop over-popular elements (matches CPython).
	const n = b.length;
	if (n >= 200) {
		const ntest = Math.floor(n / 100) + 1;
		for (const [elt, idxs] of [...b2j.entries()]) {
			if (idxs.length > ntest) b2j.delete(elt);
		}
	}

	function findLongestMatch(
		alo: number,
		ahi: number,
		blo: number,
		bhi: number,
	): [number, number, number] {
		let besti = alo;
		let bestj = blo;
		let bestsize = 0;
		let j2len = new Map<number, number>();
		for (let i = alo; i < ahi; i++) {
			const newj2len = new Map<number, number>();
			for (const j of b2j.get(a[i]!) ?? []) {
				if (j < blo) continue;
				if (j >= bhi) break;
				const k = (j2len.get(j - 1) ?? 0) + 1;
				newj2len.set(j, k);
				if (k > bestsize) {
					besti = i - k + 1;
					bestj = j - k + 1;
					bestsize = k;
				}
			}
			j2len = newj2len;
		}
		return [besti, bestj, bestsize];
	}

	let total = 0;
	const queue: Array<[number, number, number, number]> = [
		[0, a.length, 0, b.length],
	];
	while (queue.length > 0) {
		const [alo, ahi, blo, bhi] = queue.pop()!;
		const [i, j, k] = findLongestMatch(alo, ahi, blo, bhi);
		if (k > 0) {
			total += k;
			if (alo < i && blo < j) queue.push([alo, i, blo, j]);
			if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
		}
	}
	return total;
}

function sequenceRatio(a: string[], b: string[]): number {
	const t = a.length + b.length;
	if (t === 0) return 1.0;
	return (2.0 * matchingBlocksSize(a, b)) / t;
}

function round(n: number, digits: number): number {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}

/** Word-level 1 - similarity; 0.0 == approved unchanged, 1.0 == fully rewritten. */
export function specEditDistance(proposed: string, approved: string): number {
	const pw = proposed.split(/\s+/).filter(Boolean);
	const aw = approved.split(/\s+/).filter(Boolean);
	return round(1 - sequenceRatio(pw, aw), 3);
}

// --- ratio/percentile helpers ------------------------------------------------------------

function pct(values: number[], p: number): number | null {
	if (values.length === 0) return null;
	const s = [...values].sort((x, y) => x - y);
	const k = (s.length - 1) * p;
	const lo = Math.floor(k);
	const hi = Math.min(Math.floor(k) + 1, s.length - 1);
	return round(s[lo]! + (s[hi]! - s[lo]!) * (k - lo), 1);
}

function ratio(num: number, denom: number): number | null {
	return denom ? round(num / denom, 3) : null;
}

// --- confusion-matrix cells (must keep exact names/denominators) --------------------------

const CELLS = [
	"true_pass",
	"true_fail",
	"missed_fail",
	"false_alarm",
	"cv_on_pass",
	"cv_on_fail",
] as const;

function findings(r: RunRecord): Array<Record<string, unknown>> {
	return ((r as any).diff_gate?.findings ?? []) as Array<
		Record<string, unknown>
	>;
}

export function compute(runs: RunRecord[]): Record<string, any> {
	const n = runs.length;

	// --- Scope quality ---
	const gateCounts: Record<string, number> = {};
	for (const r of runs) {
		const g = (r as any).spec_gate;
		gateCounts[g] = (gateCounts[g] ?? 0) + 1;
	}
	const edits = runs
		.filter((r) => (r as any).spec_proposed && (r as any).spec_approved)
		.map((r) =>
			specEditDistance((r as any).spec_proposed, (r as any).spec_approved),
		);

	// --- Judge quality (confusion matrix) ---
	const jc: Record<string, number> = {};
	for (const c of CELLS) {
		jc[c] = runs.filter((r) => (r as any).judge_eval === c).length;
	}
	const graded = Object.values(jc).reduce((a, b) => a + b, 0);

	// --- Compounding ---
	const recurringRuns = runs.filter((r) =>
		findings(r).some((f) => f.tag === "recurring"),
	).length;
	const ineffectiveRuns = runs.filter((r) =>
		findings(r).some((f) => f.rule_ineffective),
	).length;
	const matchedNotLoadedRuns = runs.filter((r) =>
		findings(r).some((f) => f.matched_rule_not_loaded),
	).length;

	// --- Throughput ---
	const agentMinutes = runs
		.map((r) => (r as any).agent_minutes)
		.filter((v) => v !== null && v !== undefined) as number[];
	const waitingMinutes = runs
		.map((r) => (r as any).waiting_minutes)
		.filter((v) => v !== null && v !== undefined) as number[];
	const retries = runs.map((r) => (r as any).retries ?? 0) as number[];

	// --- Guard: rework rate after merge ---
	const merged = runs.filter((r) => (r as any).outcome === "merged").length;
	const rework = runs.filter((r) => (r as any).outcome === "rework").length;

	// --- Chore safety ---
	const clean = runs.filter((r) => (r as any).chore_audit === "clean").length;
	const should = runs.filter(
		(r) => (r as any).chore_audit === "should_have_gated",
	).length;

	return {
		runs: n,
		scope: {
			spec_gate_counts: gateCounts,
			spec_gate_rates: Object.fromEntries(
				Object.entries(gateCounts).map(([k, v]) => [k, ratio(v, n)]),
			),
			spec_edit_distance_mean:
				edits.length > 0
					? round(edits.reduce((a, b) => a + b, 0) / edits.length, 3)
					: null,
		},
		judge: {
			confusion_matrix: jc,
			graded_runs: graded,
			missed_fail_rate_PRIMARY: ratio(
				jc.missed_fail!,
				jc.missed_fail! + jc.true_fail!,
			),
			false_alarm_rate: ratio(jc.false_alarm!, jc.false_alarm! + jc.true_pass!),
			cannot_verify_rate: ratio(jc.cv_on_pass! + jc.cv_on_fail!, graded),
			raw_agreement_VANITY: ratio(jc.true_pass! + jc.true_fail!, graded),
		},
		compounding: {
			recurring_finding_rate: ratio(recurringRuns, n),
			rule_ineffective_rate: ratio(ineffectiveRuns, n),
			matched_rule_not_loaded_rate: ratio(matchedNotLoadedRuns, n),
			rewrite_candidates: ruleRewriteCandidates(runs),
		},
		throughput: {
			agent_minutes_p50: pct(agentMinutes, 0.5),
			agent_minutes_p90: pct(agentMinutes, 0.9),
			retries_mean: n ? round(retries.reduce((a, b) => a + b, 0) / n, 3) : null,
			waiting_minutes_p50_SEPARATE: pct(waitingMinutes, 0.5),
		},
		guard: { rework_rate_after_merge: ratio(rework, merged + rework) },
		chore_safety: {
			audited: clean + should,
			should_have_gated_rate: ratio(should, clean + should),
		},
	};
}
