import { describe, expect, it } from "vitest";
import { makeRunId, parseRunId } from "../src/paths.js";

// Ported from tests/test_paths.py
describe("parseRunId", () => {
	it.each([
		["2026-07-05-DEV-123-pr482", "2026-07-05", "DEV-123", 482],
		["2026-07-04-ENG-1", "2026-07-04", "ENG-1", null], // pre-PR / hand-authored
		["2026-07-05-JIRA-100-pr7", "2026-07-05", "JIRA-100", 7],
	])("parses %s", (runId, date, issueId, pr) => {
		const got = parseRunId(runId as string);
		expect([got.date, got.issueId, got.pr]).toEqual([date, issueId, pr]);
	});

	it("roundtrips makeRunId", () => {
		const cases: Array<[string, string, number | null]> = [
			["2026-07-05", "DEV-123", 482],
			["2026-07-05", "DEV-123", null],
		];
		for (const [date, issue, pr] of cases) {
			const rid = makeRunId(date, issue, pr);
			const parsed = parseRunId(rid);
			expect([parsed.date, parsed.issueId, parsed.pr]).toEqual([
				date,
				issue,
				pr,
			]);
		}
	});

	it("does not confuse the issue's trailing -N with the -prN disambiguator", () => {
		// `pr` starts with letters, so the split is unambiguous.
		expect(parseRunId("2026-07-05-DEV-1-pr2").issueId).toBe("DEV-1");
		expect(parseRunId("2026-07-05-DEV-1-pr2").pr).toBe(2);
	});

	it.each([
		"",
		"not-a-run-id",
		"2026-07-05-DEV",
		"2026-7-5-DEV-1",
		"2026-07-05-DEV-1-pr",
		"DEV-1-pr2",
	])("rejects malformed %s", (bad) => {
		expect(() => parseRunId(bad)).toThrow(/malformed run_id/);
	});
});
