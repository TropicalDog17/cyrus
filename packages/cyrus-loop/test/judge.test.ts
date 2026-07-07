import { describe, expect, it } from "vitest";
import {
	deriveJudgeEval,
	evidenceIdsCited,
	ledgerIds,
	validateJudgeOutput,
} from "../src/judge.js";

// Ported from tests/test_judge.py
const LEDGER = new Set(["E1", "E2", "E3"]);
const v = (obj: unknown) => validateJudgeOutput(JSON.stringify(obj), LEDGER);

describe("validateJudgeOutput", () => {
	it("accepts a valid pass", () => {
		const out = v({
			verdict: "pass",
			claims: [{ claim: "tests pass", evidence: "E1" }],
			concerns: [],
		});
		expect(out.verdict).toBe("pass");
		expect(out._validation_error).toBeUndefined();
	});

	it("accepts a valid fail", () => {
		const out = v({
			verdict: "fail",
			claims: [],
			concerns: [{ text: "3 failed", evidence: "E1" }],
		});
		expect(out.verdict).toBe("fail");
	});

	it("forces cannot-verify on a dangling citation", () => {
		const out = v({
			verdict: "pass",
			claims: [{ claim: "x", evidence: "E9" }],
			concerns: [],
		});
		expect(out.verdict).toBe("cannot-verify");
		expect(out._validation_error).toBe("ungrounded_citation");
	});

	it("forces cannot-verify on a malformed evidence id", () => {
		const out = v({
			verdict: "pass",
			claims: [{ claim: "x", evidence: "e1" }],
			concerns: [],
		});
		expect(out.verdict).toBe("cannot-verify");
	});

	it("forces cannot-verify on pass without claims", () => {
		const out = v({ verdict: "pass", claims: [], concerns: [] });
		expect(out.verdict).toBe("cannot-verify");
		expect(out._validation_error).toBe("pass_without_claims");
	});

	it("forces cannot-verify on fail without concerns", () => {
		const out = v({ verdict: "fail", claims: [], concerns: [] });
		expect(out.verdict).toBe("cannot-verify");
		expect(out._validation_error).toBe("fail_without_concerns");
	});

	it("does not crash on non-object input", () => {
		expect(validateJudgeOutput("[1,2,3]", LEDGER).verdict).toBe(
			"cannot-verify",
		);
		expect(validateJudgeOutput("null", LEDGER).verdict).toBe("cannot-verify");
		expect(validateJudgeOutput('"a string"', LEDGER).verdict).toBe(
			"cannot-verify",
		);
	});

	it("forces cannot-verify on invalid JSON", () => {
		expect(validateJudgeOutput("{not json", LEDGER).verdict).toBe(
			"cannot-verify",
		);
	});

	it("forces cannot-verify when a claim item is not an object", () => {
		const out = v({ verdict: "pass", claims: ["just a string"], concerns: [] });
		expect(out.verdict).toBe("cannot-verify");
	});

	it("rejects extra keys via shape validation", () => {
		const out = v({ verdict: "pass", claims: [], concerns: [], sneaky: 1 });
		expect(out.verdict).toBe("cannot-verify");
		expect(out._validation_error).toBe("schema_violation");
	});
});

describe("ledgerIds", () => {
	it("collects ids from entries", () => {
		expect(ledgerIds([{ id: "E1" }, { id: "E2" }, { nope: 1 } as any])).toEqual(
			new Set(["E1", "E2"]),
		);
	});
});

describe("evidenceIdsCited", () => {
	it("dedups and sorts cited evidence ids", () => {
		expect(
			evidenceIdsCited({
				claims: [
					{ claim: "x", evidence: "E3" },
					{ claim: "y", evidence: "E1" },
				],
				concerns: [{ text: "z", evidence: "E1" }],
			} as any),
		).toEqual(["E1", "E3"]);
	});
});

describe("deriveJudgeEval", () => {
	it.each([
		["pass", "approved", "true_pass"],
		["pass", "rejected", "missed_fail"],
		["pass", "needs-rework", "missed_fail"],
		["fail", "rejected", "true_fail"],
		["fail", "approved", "false_alarm"],
		["cannot-verify", "approved", "cv_on_pass"],
		["cannot-verify", "rejected", "cv_on_fail"],
		["skip", "approved", null],
		[null, "approved", null],
		["pass", null, null],
	])("(%s, %s) → %s", (jv, hv, expected) => {
		expect(deriveJudgeEval(jv as string | null, hv as string | null)).toBe(
			expected,
		);
	});
});
