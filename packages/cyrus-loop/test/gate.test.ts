import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as gate from "../src/gate.js";
import * as judge from "../src/judge.js";
import { HUMAN_VERDICTS } from "../src/judge.js";
import { EvidenceLedger } from "../src/ledger.js";

// Ported from tests/test_gate.py
const VALID_PASS = {
	verdict: "pass",
	claims: [{ claim: "tests pass", evidence: "E1" }],
	concerns: [],
};
const VALID_FAIL = {
	verdict: "fail",
	claims: [],
	concerns: [{ text: "SECRETJUDGECONCERN", evidence: "E2" }],
};

async function seedLedger(runId: string): Promise<void> {
	const led = new EvidenceLedger(runId);
	await led.runCommand("tests", "true", { cwd: "." });
	led.diffscan(["a.py", "surprise.py"], ["a.py"]);
}

let prevData: string | undefined;

beforeEach(() => {
	prevData = process.env.AGENTIC_PIPELINE_DATA;
	process.env.AGENTIC_PIPELINE_DATA = mkdtempSync(
		join(tmpdir(), "cyrus-loop-gate-"),
	);
});

afterEach(() => {
	if (prevData === undefined) delete process.env.AGENTIC_PIPELINE_DATA;
	else process.env.AGENTIC_PIPELINE_DATA = prevData;
});

describe("blind gate", () => {
	it("refuses to reveal before the human verdict is recorded", async () => {
		await seedLedger("2026-07-04-ENG-1");
		gate.storeJudgeVerdict("2026-07-04-ENG-1", VALID_PASS);
		expect(() => gate.reveal("2026-07-04-ENG-1")).toThrow(
			gate.RevealBeforeHuman,
		);
	});

	it("review package never contains the judge output", async () => {
		await seedLedger("2026-07-04-ENG-2");
		gate.storeJudgeVerdict("2026-07-04-ENG-2", VALID_FAIL);
		const pkg = gate.reviewPackage("2026-07-04-ENG-2");
		expect("judge" in pkg).toBe(false);
		expect(JSON.stringify(pkg)).not.toContain("SECRETJUDGECONCERN");
		expect(pkg.diffscan_warnings.length).toBeGreaterThan(0); // E4 warn surfaced
	});

	it("derives judge_eval only after the human records", async () => {
		const rid = "2026-07-04-ENG-3";
		await seedLedger(rid);
		gate.storeJudgeVerdict(rid, VALID_PASS);
		gate.recordHumanVerdict(rid, "rejected", [
			{ text: "missed edge", tag: "recurring" },
		]);
		const revealed = gate.reveal(rid);
		expect(revealed.judge_eval).toBe("missed_fail"); // judge pass, human rejected
		expect(revealed.human.verdict).toBe("rejected");
		expect(revealed.judge_evidence_ids).toEqual(["E1"]); // derived, not hand-typed
	});

	it("storeJudgeVerdict re-validates an ungrounded output", async () => {
		const rid = "2026-07-04-ENG-6";
		await seedLedger(rid);
		// "pass" with no supporting claim → validator forces cannot-verify.
		gate.storeJudgeVerdict(rid, { verdict: "pass", claims: [], concerns: [] });
		gate.recordHumanVerdict(rid, "approved", []);
		const revealed = gate.reveal(rid);
		expect(revealed.judge?.verdict).toBe("cannot-verify");
		expect(revealed.judge_eval).toBe("cv_on_pass");
	});

	it("refuses a second human verdict without force", () => {
		const rid = "2026-07-04-ENG-4";
		gate.recordHumanVerdict(rid, "approved", []);
		expect(() => gate.recordHumanVerdict(rid, "rejected", [])).toThrow(
			gate.HumanVerdictExists,
		);
		const rec = gate.recordHumanVerdict(rid, "rejected", [], { force: true });
		expect(rec.verdict).toBe("rejected");
	});

	it("rejects a bad finding tag", () => {
		expect(() =>
			gate.recordHumanVerdict("2026-07-04-ENG-5", "approved", [
				{ text: "x", tag: "weird" },
			]),
		).toThrow(/tag/);
	});

	it("shares one human-verdict vocabulary with judge", () => {
		expect(gate.HUMAN_VERDICTS).toBe(judge.HUMAN_VERDICTS);
		expect(HUMAN_VERDICTS).toBe(judge.HUMAN_VERDICTS);
	});
});

describe("parseFindingArg", () => {
	it("keeps empty text with a valid tag (no label smuggling)", () => {
		expect(gate.parseFindingArg("::recurring")).toEqual({
			text: "",
			tag: "recurring",
			rule_ineffective: null,
		});
	});

	it("treats a token with no :: as text with an empty (rejected) tag", () => {
		expect(gate.parseFindingArg("missed error path")).toEqual({
			text: "missed error path",
			tag: "",
			rule_ineffective: null,
		});
	});
});
