import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { abandonFactPath, prMetaPath } from "../src/capture.js";
import { recordHumanVerdict, storeJudgeVerdict } from "../src/gate.js";
import { mergeFactPath } from "../src/integrate.js";
import {
	appendRule,
	applyLearn,
	assembleRecord,
	backfillRework,
	choreAuditDue,
	crosscheckGate,
	deriveAndSetJudgeEval,
	existingRules,
	ruleRewriteCandidates,
} from "../src/learn.js";
import { EvidenceLedger } from "../src/ledger.js";
import { currentVersions } from "../src/promptVersion.js";
import { appendRun, readRuns } from "../src/runLog.js";

// Ported from tests/test_learn.py

function run(over: Record<string, unknown> = {}): any {
	return {
		run_id: "2026-07-04-ENG-1",
		issue_id: "ENG-1",
		repo: "demo",
		tier: "feature",
		spec_proposed: "x",
		spec_gate: "approved",
		scope_prompt_version: "scope-v1",
		judge_prompt_version: "judge-v1",
		outcome: "merged",
		...over,
	};
}

async function seedGate(rid: string, humanVerdict = "approved"): Promise<void> {
	const led = new EvidenceLedger(rid);
	await led.runCommand("tests", "true", { cwd: "." });
	led.diffscan(["a.py"], ["a.py"]);
	storeJudgeVerdict(rid, {
		verdict: "pass",
		claims: [{ claim: "tests pass", evidence: "E1" }],
		concerns: [],
	});
	recordHumanVerdict(rid, humanVerdict, []);
}

let prev: string | undefined;
beforeEach(() => {
	prev = process.env.AGENTIC_PIPELINE_DATA;
	process.env.AGENTIC_PIPELINE_DATA = mkdtempSync(
		join(tmpdir(), "cyrus-loop-learn-"),
	);
});
afterEach(() => {
	if (prev === undefined) delete process.env.AGENTIC_PIPELINE_DATA;
	else process.env.AGENTIC_PIPELINE_DATA = prev;
});

describe("applyLearn", () => {
	it("creates a new rule on a recurring finding", () => {
		const rec = run({
			diff_gate: {
				verdict: "rejected",
				findings: [
					{
						text: "missed null check",
						tag: "recurring",
						rule_ineffective: null,
					},
				],
			},
		});
		const [, actions] = applyLearn(rec);
		expect(actions[0]!.created_rule).toBe("R1");
		const rules = existingRules("demo");
		expect(rules[0]!.id).toBe("R1");
		expect(rules[0]!.text).toContain("missed null check");
	});

	it("marks rule_ineffective when the rule was loaded", () => {
		appendRule("demo", "ENG-0", "always handle null", "2026-07-01");
		const rec = run({
			context_manifest: ["AGENTS.md", "failures/demo.md@abc12345"],
			diff_gate: {
				verdict: "rejected",
				findings: [
					{ text: "null again", tag: "recurring", rule_ineffective: null },
				],
			},
		});
		const [, actions] = applyLearn(rec, { 0: "R1" });
		expect(rec.diff_gate.findings[0].rule_ineffective).toBe("R1");
		expect(actions[0]!.rule_ineffective).toBe("R1");
		expect(existingRules("demo")).toHaveLength(1); // no duplicate
	});

	it("marks matched_rule_not_loaded when the rule was not in context", () => {
		appendRule("demo", "ENG-0", "some rule", "2026-07-01");
		const rec = run({
			context_manifest: ["AGENTS.md"], // failures NOT loaded this run
			diff_gate: {
				verdict: "rejected",
				findings: [{ text: "x", tag: "recurring", rule_ineffective: null }],
			},
		});
		const [, actions] = applyLearn(rec, { 0: "R1" });
		expect(rec.diff_gate.findings[0].rule_ineffective).toBeNull();
		expect(rec.diff_gate.findings[0].matched_rule_not_loaded).toBe("R1");
		expect(actions[0]!.matched_rule_not_loaded).toBe("R1");
	});

	it("ignores one-off findings", () => {
		const rec = run({
			diff_gate: {
				verdict: "approved",
				findings: [{ text: "nit", tag: "one-off", rule_ineffective: null }],
			},
		});
		const [, actions] = applyLearn(rec);
		expect(actions).toEqual([]);
		expect(existingRules("demo")).toEqual([]);
	});
});

describe("deriveAndSetJudgeEval", () => {
	it("derives missed_fail", () => {
		const rec = run({
			verify: { mechanical: "pass", judge_verdict: "pass" },
			diff_gate: { verdict: "rejected" },
		});
		deriveAndSetJudgeEval(rec);
		expect(rec.judge_eval).toBe("missed_fail");
	});
});

describe("backfillRework", () => {
	it("marks the original run reworked", () => {
		appendRun(run(), { fsync: false });
		const updated = backfillRework("ENG-50", "ENG-1");
		expect(updated.outcome).toBe("rework");
		expect((updated as any).rework_issue).toBe("ENG-50");
		expect((readRuns()[0] as any).outcome).toBe("rework");
	});

	it("throws when there is no original", () => {
		expect(() => backfillRework("ENG-50", "ENG-999")).toThrow(/no merged run/);
	});

	it("picks the latest merged run, not the last appended", () => {
		appendRun(
			run({ run_id: "2026-07-02-ENG-1", issue_id: "ENG-1", outcome: "merged" }),
			{ fsync: false },
		);
		appendRun(
			run({
				run_id: "2026-07-05-ENG-1",
				issue_id: "ENG-1",
				outcome: "abandoned",
			}),
			{ fsync: false },
		);
		const updated = backfillRework("ENG-50", "ENG-1");
		expect(updated.run_id).toBe("2026-07-02-ENG-1"); // the merged one
		expect(updated.outcome).toBe("rework");
	});
});

describe("assembleRecord", () => {
	it("builds a schema-valid record from on-disk artifacts", async () => {
		const rid = "2026-07-04-ENG-70";
		await seedGate(rid);
		const rec = assembleRecord(rid, "demo", {
			specText: "## Goal\nx\n",
			tier: "feature",
		});
		expect(rec.run_id).toBe(rid);
		expect(rec.issue_id).toBe("ENG-70");
		expect(rec.verify).toEqual({
			mechanical: "pass",
			judge_verdict: "pass",
			judge_evidence_ids: ["E1"],
		});
		expect(rec.diff_gate.verdict).toBe("approved");
		expect(rec.ledger_sha).toHaveLength(64);
		expect(rec.tokens_total).toBeNull();
		expect(rec.agent_minutes).toBeNull();
		Object.assign(rec, currentVersions());
		appendRun(rec, { fsync: false });
		expect(readRuns().at(-1)!.run_id).toBe(rid);
	});

	it("sources outcome=merged from the merge fact", async () => {
		const rid = "2026-07-04-ENG-80";
		await seedGate(rid);
		writeFileSync(mergeFactPath(rid), JSON.stringify({ merged: true, pr: 3 }));
		const rec = assembleRecord(rid, "demo", { outcome: "abandoned" });
		expect(rec.outcome).toBe("merged");
	});

	it("falls back to the passed outcome without a merge fact", async () => {
		const rid = "2026-07-04-ENG-81";
		await seedGate(rid);
		const rec = assembleRecord(rid, "demo", { outcome: "abandoned" });
		expect(rec.outcome).toBe("abandoned");
	});

	it("sources outcome=abandoned from the abandon fact", async () => {
		const rid = "2026-07-04-ENG-84";
		await seedGate(rid);
		writeFileSync(abandonFactPath(rid), JSON.stringify({ abandoned: true }));
		const rec = assembleRecord(rid, "demo", { outcome: "merged" });
		expect(rec.outcome).toBe("abandoned");
	});

	it("computes waiting_minutes from PR-open time", async () => {
		const rid = "2026-07-04-ENG-82";
		await seedGate(rid);
		writeFileSync(
			prMetaPath(rid),
			JSON.stringify({ created_at: "2020-01-01T00:00:00Z", head_sha: "abc" }),
		);
		const rec = assembleRecord(rid, "demo");
		expect(rec.waiting_minutes).not.toBeNull();
		expect(rec.waiting_minutes).toBeGreaterThan(0);
	});

	it("leaves waiting_minutes null without PR meta", async () => {
		const rid = "2026-07-04-ENG-83";
		await seedGate(rid);
		const rec = assembleRecord(rid, "demo");
		expect(rec.waiting_minutes).toBeNull();
	});
});

describe("crosscheckGate", () => {
	it("refuses a mismatch and allows a match", async () => {
		const rid = "2026-07-04-ENG-71";
		await seedGate(rid, "approved");
		const good = run({
			run_id: rid,
			issue_id: "ENG-71",
			verify: { mechanical: "pass", judge_verdict: "pass" },
			diff_gate: { verdict: "approved" },
		});
		expect(() => crosscheckGate(good, rid)).not.toThrow();
		const bad = run({
			run_id: rid,
			issue_id: "ENG-71",
			verify: { mechanical: "pass", judge_verdict: "pass" },
			diff_gate: { verdict: "rejected" },
		});
		expect(() => crosscheckGate(bad, rid)).toThrow(/label integrity/);
	});

	it("refuses a record that omits the verdict fields", async () => {
		const rid = "2026-07-04-ENG-73";
		await seedGate(rid, "approved");
		const omitted = run({ run_id: rid, issue_id: "ENG-73" });
		expect(() => crosscheckGate(omitted, rid)).toThrow(/label integrity/);
	});
});

describe("ruleRewriteCandidates and choreAuditDue", () => {
	it("flags rules with >= 2 ineffective hits", () => {
		["R1", "R1", "R2"].forEach((rid, i) => {
			appendRun(
				run({
					run_id: `2026-07-04-ENG-${i + 10}`,
					issue_id: `ENG-${i + 10}`,
					diff_gate: {
						verdict: "rejected",
						findings: [{ text: "x", tag: "recurring", rule_ineffective: rid }],
					},
				}),
				{ fsync: false },
			);
		});
		expect(ruleRewriteCandidates()).toEqual({ R1: 2 });
	});

	it("samples the chore audit every N auto chores", () => {
		for (let i = 0; i < 4; i++) {
			appendRun(
				run({
					run_id: `2026-07-04-ENG-${i + 20}`,
					issue_id: `ENG-${i + 20}`,
					repo: "demo",
					tier: "chore",
					spec_gate: "auto",
				}),
				{ fsync: false },
			);
		}
		expect(choreAuditDue("demo")).toBe(true);
		expect(choreAuditDue("other")).toBe(false);
	});
});
