/**
 * Learn loop — the point of the whole pipeline (ported from `pipeline/learn.py`).
 *
 * At the diff gate every finding is tagged `recurring` or `one-off`. On a `recurring` tag the
 * human either creates a new failure rule or picks a matching existing one (manual-pick — rules
 * are NEVER auto-merged). If the matched rule was ALREADY in this run's context_manifest, no
 * duplicate is appended; instead the finding is logged `rule_ineffective: R<n>` (context isn't
 * landing). If the rule exists but was NOT loaded, `matched_rule_not_loaded` flags broken
 * context plumbing.
 *
 * learn.ts also derives judge_eval, flags chore-audit samples, backfills rework linkage, and
 * writes the full run record via runLog.appendRun (the sole writer).
 */

import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import * as budgets from "./budgets.js";
import * as capture from "./capture.js";
import { loadYaml } from "./config.js";
import * as context from "./context.js";
import * as cyrusAdapter from "./cyrusAdapter.js";
import { reveal } from "./gate.js";
import * as integrate from "./integrate.js";
import { deriveJudgeEval } from "./judge.js";
import * as ledger from "./ledger.js";
import { dataDir, parseRunId } from "./paths.js";
import { currentVersions } from "./promptVersion.js";
import { appendRun, readRuns, updateRun } from "./runLog.js";
import type { RunRecord } from "./schemas.js";

type MutableRecord = Record<string, any>;

const _RULE_RE = /^-\s*(R\d+)\b/;

export function minutesBetween(
	startIso: string | null | undefined,
	endIso: string | null | undefined,
): number | null {
	if (!startIso || !endIso) return null;
	const start = Date.parse(startIso);
	const end = Date.parse(endIso);
	if (Number.isNaN(start) || Number.isNaN(end)) return null;
	return Math.round(((end - start) / 60000) * 10) / 10;
}

export interface Rule {
	id: string;
	text: string;
}

export function existingRules(repo: string): Rule[] {
	const p = context.repoFailuresPath(repo);
	if (!existsSync(p)) return [];
	const rules: Rule[] = [];
	for (const line of readFileSync(p, "utf-8").split("\n")) {
		const m = _RULE_RE.exec(line.trim());
		if (m) rules.push({ id: m[1]!, text: line.trim() });
	}
	return rules;
}

function ruleExists(repo: string, ruleId: string): boolean {
	return existingRules(repo).some((r) => r.id === ruleId);
}

export function nextRuleId(repo: string): string {
	const nums = existingRules(repo).map((r) =>
		Number.parseInt(r.id.slice(1), 10),
	);
	return `R${nums.length > 0 ? Math.max(...nums) + 1 : 1}`;
}

/**
 * Append a one-line rule to the repo's failures.md; return its id. The id computation and the
 * append happen under one lock so two concurrent learns can't both read the same max id and mint
 * duplicate rule ids (which would corrupt the manual-pick discipline).
 */
export function appendRule(
	repo: string,
	issueId: string,
	text: string,
	date: string,
): string {
	const path = context.ensureFailuresFile(repo);
	const release = lockfile.lockSync(path, { realpath: false, stale: 10_000 });
	try {
		const existing = readFileSync(path, "utf-8");
		const nums: number[] = [];
		for (const ln of existing.split("\n")) {
			const m = _RULE_RE.exec(ln.trim());
			if (m) nums.push(Number.parseInt(m[1]!.slice(1), 10));
		}
		const rid = `R${nums.length > 0 ? Math.max(...nums) + 1 : 1}`;
		const line = `- ${rid} (${date}, ${issueId}): ${text}\n`;
		const fd = openSync(path, "a", 0o644);
		try {
			writeSync(fd, line);
		} finally {
			closeSync(fd);
		}
		return rid;
	} finally {
		release();
	}
}

function repoFailuresInManifest(repo: string, manifest: string[]): boolean {
	return manifest.some((m) => m.startsWith(`failures/${repo}.md@`));
}

export interface LearnAction {
	finding: string;
	rule_ineffective?: string;
	matched_rule_not_loaded?: string;
	created_rule?: string;
}

/**
 * Process recurring findings. `picks` maps finding-index → rule id ("new" to create). Mutates
 * findings in place (sets rule_ineffective / matched_rule_not_loaded) and appends new rules.
 */
export function applyLearn(
	record: MutableRecord,
	picks: Record<number, string> = {},
): [MutableRecord, LearnAction[]] {
	const repo = record.repo;
	const manifest: string[] = record.context_manifest ?? [];
	const loaded = repoFailuresInManifest(repo, manifest);
	const date = parseRunId(record.run_id).date; // tolerates the -pr<N> suffix
	const findings: MutableRecord[] = record.diff_gate?.findings ?? [];
	const actions: LearnAction[] = [];

	for (let i = 0; i < findings.length; i++) {
		const f = findings[i]!;
		if (f.tag !== "recurring") continue;
		const pick = picks[i] ?? "new";
		if (pick !== "new") {
			if (!ruleExists(repo, pick)) {
				throw new Error(
					`picked rule ${pick} does not exist in ${repo} failures.md`,
				);
			}
			if (loaded) {
				// The rule was in context yet the mistake recurred → context isn't landing.
				f.rule_ineffective = pick;
				actions.push({ finding: String(i), rule_ineffective: pick });
			} else {
				// The rule exists but wasn't loaded — broken context bundle, not a bad rule.
				f.matched_rule_not_loaded = pick;
				actions.push({ finding: String(i), matched_rule_not_loaded: pick });
			}
		} else {
			const rid = appendRule(repo, record.issue_id, f.text, date);
			actions.push({ finding: String(i), created_rule: rid });
		}
	}
	return [record, actions];
}

export function deriveAndSetJudgeEval(record: MutableRecord): MutableRecord {
	const jv = record.verify?.judge_verdict ?? null;
	const hv = record.diff_gate?.verdict ?? null;
	record.judge_eval = deriveJudgeEval(jv, hv);
	return record;
}

/** True if the NEXT auto-approved chore for this repo lands on the sampling interval. */
export function choreAuditDue(
	repo: string,
	opts: { runs?: RunRecord[] } = {},
): boolean {
	const audit =
		(loadYaml("route.yaml").audit as { sample_every?: number }) ?? {};
	const every = audit.sample_every ?? 5;
	const runs = opts.runs ?? readRuns({ skipInvalid: true });
	const prior = runs.filter(
		(r) => (r as any).repo === repo && (r as any).spec_gate === "auto",
	).length;
	return (prior + 1) % every === 0;
}

/**
 * A rework/bug issue labeled rework-of <original>; mark the original run reworked. Picks the most
 * recent MERGED run for the original issue (recency by run_id, which embeds the date).
 */
export function backfillRework(
	reworkIssueId: string,
	originalIssueId: string,
): RunRecord {
	const runs = readRuns();
	const candidates = runs.filter(
		(r) =>
			(r as any).issue_id === originalIssueId &&
			(r as any).outcome === "merged",
	);
	if (candidates.length === 0) {
		throw new Error(
			`no merged run found for original issue ${originalIssueId}`,
		);
	}
	const target = candidates.reduce((a, b) =>
		(a as any).run_id >= (b as any).run_id ? a : b,
	);
	return updateRun((target as any).run_id, {
		outcome: "rework",
		rework_issue: reworkIssueId,
	} as Partial<RunRecord>);
}

/** Rules with >= 2 rule_ineffective hits — flag for rewrite at consolidation. */
export function ruleRewriteCandidates(
	runs?: RunRecord[],
): Record<string, number> {
	const list = runs ?? readRuns({ skipInvalid: true });
	const counts: Record<string, number> = {};
	for (const r of list) {
		for (const f of (r as any).diff_gate?.findings ?? []) {
			const rid = f.rule_ineffective;
			if (rid) counts[rid] = (counts[rid] ?? 0) + 1;
		}
	}
	return Object.fromEntries(Object.entries(counts).filter(([, n]) => n >= 2));
}

/**
 * Refuse to append a record whose verify/diff_gate verdicts contradict the durable, blind-gate-
 * protected files for `run_id`. gate.reveal already refuses before the human verdict exists.
 */
export function crosscheckGate(record: MutableRecord, runId: string): void {
	const revealed = reveal(runId); // throws if the human verdict isn't recorded yet
	// reveal succeeded, so a durable human verdict exists. A record that omits/nulls these fields
	// is exactly the mis-transcription this guard catches — treat a missing value as a mismatch.
	const wantJudge = revealed.judge
		? (revealed.judge.verdict ?? "skip")
		: "skip";
	const wantHuman = revealed.human.verdict;
	const gotJudge = record.verify?.judge_verdict ?? "skip";
	const gotHuman = record.diff_gate?.verdict;
	const mismatches: string[] = [];
	if (gotJudge !== wantJudge) {
		mismatches.push(
			`verify.judge_verdict=${JSON.stringify(gotJudge)} but gate recorded ${JSON.stringify(wantJudge)}`,
		);
	}
	if (gotHuman !== wantHuman) {
		mismatches.push(
			`diff_gate.verdict=${JSON.stringify(gotHuman)} but gate recorded ${JSON.stringify(wantHuman)}`,
		);
	}
	if (mismatches.length > 0) {
		throw new Error(
			`record contradicts the durable blind-gate files (label integrity): ${mismatches.join("; ")}`,
		);
	}
}

/**
 * Build a run-record skeleton from on-disk artifacts (ledger + gate reveal + context + saved
 * diff) so it needn't be hand-typed. Telemetry the pipeline can't see (tokens/minutes/models) is
 * left as explicit null.
 */
export function assembleRecord(
	runId: string,
	repo: string,
	opts: {
		specText?: string | null;
		tier?: string | null;
		specGate?: string;
		outcome?: string;
	} = {},
): MutableRecord {
	const specText = opts.specText ?? null;
	const specGate = opts.specGate ?? "approved";
	let outcome = opts.outcome ?? "merged";

	const issueId = parseRunId(runId).issueId;
	const revealed = reveal(runId); // refuses until the human verdict is recorded (blind gate)
	const led = ledger.ledgerSummary(runId);
	const judgeV = revealed.judge ? (revealed.judge.verdict ?? "skip") : "skip";

	// Source `outcome` from the durable merge/abandon facts so it reflects observed state.
	const mergeFact = integrate.readMergeFact(runId);
	if (mergeFact?.merged) {
		outcome = "merged";
	} else if (capture.readAbandonFact(runId)) {
		outcome = "abandoned";
	}

	const prMeta = capture.readPrMeta(runId);
	const waitingMinutes = minutesBetween(
		prMeta?.created_at,
		revealed.human.recorded_at,
	);

	return {
		run_id: runId,
		issue_id: issueId,
		repo,
		tier: opts.tier ?? cyrusAdapter.tierFor(repo),
		spec_proposed: specText ?? "",
		spec_approved: specText,
		spec_gate: specGate,
		amendments: [],
		context_manifest: context.buildBundle(repo).manifest,
		executor_model: null,
		judge_model: null,
		tokens_total: null,
		diff_stats: ledger.diffStatsFromFile(
			join(dataDir(), "diffs", `${runId}.diff`),
		),
		ledger_sha: led.ledger_sha,
		verify: {
			mechanical: led.mechanical,
			judge_verdict: judgeV,
			judge_evidence_ids: revealed.judge_evidence_ids,
		},
		diff_gate: {
			verdict: revealed.human.verdict,
			findings: revealed.human.findings ?? [],
			recorded_at: revealed.human.recorded_at,
		},
		outcome,
		rework_issue: null,
		retries: 0,
		agent_minutes: null,
		waiting_minutes: waitingMinutes,
	};
}

export interface RecordResult {
	appended: string;
	actions: LearnAction[];
	chore_audit_due: boolean;
	over_budget: budgets.Exceedance[];
}

/**
 * Process a finished run's findings and append it — the `learn record` operation. Optionally
 * cross-checks against the durable blind-gate files (label integrity). Stamps prompt-version
 * provenance from the LIVE prompt files, derives judge_eval, applies the learn routing, appends
 * the run, and reports advisory budget exceedances.
 */
export function record(
	rec: MutableRecord,
	opts: { picks?: Record<number, string>; runId?: string } = {},
): RecordResult {
	if (opts.runId) crosscheckGate(rec, opts.runId);
	// Stamp provenance from the LIVE prompt files so versions can't drift from a hand-typed value.
	Object.assign(rec, currentVersions());
	deriveAndSetJudgeEval(rec);
	const due = rec.spec_gate === "auto" ? choreAuditDue(rec.repo) : false;
	const [record2, actions] = applyLearn(rec, opts.picks ?? {});
	appendRun(record2 as RunRecord);
	const overBudget = budgets.checkRecord(record2).exceeded;
	return {
		appended: record2.run_id,
		actions,
		chore_audit_due: due,
		over_budget: overBudget,
	};
}
