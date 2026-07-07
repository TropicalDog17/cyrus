import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compute, specEditDistance } from "../src/metrics.js";
import type { RunRecord } from "../src/schemas.js";

// Ported from tests/test_metrics.py
const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");

function loadExamples(): RunRecord[] {
	return readFileSync(join(FIXTURES, "runs.jsonl.example"), "utf-8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as RunRecord);
}

describe("compute", () => {
	it("computes metrics over the example file", () => {
		const m = compute(loadExamples());
		expect(m.runs).toBe(4);

		const cm = m.judge.confusion_matrix;
		expect(cm.true_pass).toBe(1);
		expect(cm.missed_fail).toBe(1);
		expect(cm.cv_on_pass).toBe(1);
		expect(cm.true_fail).toBe(0);
		expect(cm.false_alarm).toBe(0);
		expect(cm.cv_on_fail).toBe(0);

		expect(m.judge.missed_fail_rate_PRIMARY).toBe(1.0);
		expect(m.judge.false_alarm_rate).toBe(0.0);

		expect(m.guard.rework_rate_after_merge).toBe(0.25);
		expect(m.compounding.recurring_finding_rate).toBe(0.25);
		expect(m.compounding.rule_ineffective_rate).toBe(0.25);
		expect(m.chore_safety.should_have_gated_rate).toBe(0.0);
	});

	it("reports raw agreement but flags it as vanity", () => {
		const m = compute(loadExamples());
		expect("raw_agreement_VANITY" in m.judge).toBe(true);
	});

	it("returns None-equivalents on an empty log (no divide-by-zero)", () => {
		const m = compute([]);
		expect(m.runs).toBe(0);
		expect(m.judge.missed_fail_rate_PRIMARY).toBeNull();
		expect(m.compounding.matched_rule_not_loaded_rate).toBeNull();
		expect(m.guard.rework_rate_after_merge).toBeNull();
	});

	it("computes matched_rule_not_loaded_rate", () => {
		const runs = [
			{
				run_id: "2026-07-05-ENG-1",
				issue_id: "ENG-1",
				repo: "demo",
				tier: "feature",
				spec_proposed: "x",
				spec_gate: "approved",
				scope_prompt_version: "s",
				judge_prompt_version: "j",
				outcome: "merged",
				diff_gate: {
					verdict: "rejected",
					findings: [
						{ text: "x", tag: "recurring", matched_rule_not_loaded: "R3" },
					],
				},
			},
		] as unknown as RunRecord[];
		expect(compute(runs).compounding.matched_rule_not_loaded_rate).toBe(1.0);
	});
});

describe("specEditDistance", () => {
	it("is 0 for identical text and > 0 for edits", () => {
		expect(specEditDistance("a b c", "a b c")).toBe(0.0);
		expect(specEditDistance("a b c", "a b c d e f")).toBeGreaterThan(0.0);
	});
});
