import {
	appendFileSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendRun, readRuns, repairRuns, updateRun } from "../src/runLog.js";
import { SchemaValidationError } from "../src/schemas.js";

// Ported from tests/test_append_run.py

function rec(over: Record<string, unknown> = {}): any {
	return {
		run_id: "2026-07-04-ENG-1",
		issue_id: "ENG-1",
		repo: "demo",
		tier: "feature",
		spec_proposed: "do a thing",
		spec_gate: "approved",
		scope_prompt_version: "scope-v1",
		judge_prompt_version: "judge-v1",
		outcome: "merged",
		...over,
	};
}

function tmpRuns(): string {
	const dir = mkdtempSync(join(tmpdir(), "cyrus-loop-runlog-"));
	return join(dir, "runs.jsonl");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("appendRun / readRuns", () => {
	it("round-trips appended records in order", () => {
		const path = tmpRuns();
		appendRun(rec(), { fsync: false, path });
		appendRun(rec({ run_id: "2026-07-04-ENG-2", issue_id: "ENG-2" }), {
			fsync: false,
			path,
		});
		expect(readRuns({ path }).map((r) => r.run_id)).toEqual([
			"2026-07-04-ENG-1",
			"2026-07-04-ENG-2",
		]);
	});

	it.each([
		{ tier: "gigantic" }, // bad enum
		{ run_id: "ENG-1" }, // bad run_id pattern
		{ issue_id: "nope" }, // bad issue pattern
		{ ledger_sha: "xyz" }, // bad sha pattern
		{ extra_field: 1 }, // additionalProperties: false
	])("rejects invalid record %o", (bad) => {
		const path = tmpRuns();
		expect(() => appendRun(rec(bad), { fsync: false, path })).toThrow(
			SchemaValidationError,
		);
	});

	it("rejects a missing required field", () => {
		const path = tmpRuns();
		const r = rec();
		delete r.outcome;
		expect(() => appendRun(r, { fsync: false, path })).toThrow(
			SchemaValidationError,
		);
	});

	it("tolerates a torn last line (warns, skips)", () => {
		const path = tmpRuns();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		appendRun(rec(), { fsync: false, path });
		// Simulate a crashed writer leaving a partial final line (no newline).
		appendFileSync(path, '{"run_id": "2026-07-04-ENG-2", "iss');
		const runs = readRuns({ path });
		expect(runs.length).toBe(1);
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/torn last line/));
	});

	it("isolates a torn fragment on append and surfaces it loudly on read", () => {
		const path = tmpRuns();
		// A crashed writer left a fragment with NO trailing newline.
		writeFileSync(path, '{"run_id": "2026-07-04-ENG-9", "iss');
		appendRun(rec(), { fsync: false, path }); // newline guard must isolate the fragment
		const text = readFileSync(path, "utf-8");
		expect(text).toContain("2026-07-04-ENG-1");
		expect(text).toContain('\n{"'); // the good record is on its OWN line
		// The corruption surfaces loudly rather than silently dropping the good record.
		expect(() => readRuns({ path })).toThrow(/corrupt line/);
	});

	it("raises on mid-file corruption (not the last line)", () => {
		const path = tmpRuns();
		appendRun(rec(), { fsync: false, path });
		appendRun(rec({ run_id: "2026-07-04-ENG-2", issue_id: "ENG-2" }), {
			fsync: false,
			path,
		});
		const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
		lines.splice(1, 0, "{ this is broken");
		writeFileSync(path, `${lines.join("\n")}\n`);
		expect(() => readRuns({ path })).toThrow(/corrupt line/);
	});

	it("does not interleave concurrent appends", async () => {
		const path = tmpRuns();
		const N = 25;
		await Promise.all(
			Array.from({ length: N }, (_, i) =>
				Promise.resolve().then(() =>
					appendRun(
						rec({
							run_id: `2026-07-04-ENG-${i + 1}`,
							issue_id: `ENG-${i + 1}`,
						}),
						{ fsync: false, path },
					),
				),
			),
		);
		const runs = readRuns({ path });
		expect(runs.length).toBe(N);
		expect(new Set(runs.map((r) => r.run_id)).size).toBe(N);
	});
});

describe("updateRun", () => {
	it("backfills fields on an existing run", () => {
		const path = tmpRuns();
		appendRun(rec(), { fsync: false, path });
		const updated = updateRun(
			"2026-07-04-ENG-1",
			{ outcome: "rework", rework_issue: "ENG-9" },
			{ path },
		);
		expect(updated.outcome).toBe("rework");
		expect(readRuns({ path })[0]!.rework_issue).toBe("ENG-9");
	});

	it("tolerates a torn last line", () => {
		const path = tmpRuns();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		appendRun(rec(), { fsync: false, path });
		appendFileSync(path, '{"run_id": "2026-07-04-ENG-2", "iss'); // torn tail
		updateRun(
			"2026-07-04-ENG-1",
			{ outcome: "rework", rework_issue: "ENG-9" },
			{ path },
		);
		const runs = readRuns({ path });
		expect(runs.length).toBe(1);
		expect(runs[0]!.outcome).toBe("rework");
	});

	it("throws on an unknown run_id", () => {
		const path = tmpRuns();
		appendRun(rec(), { fsync: false, path });
		expect(() =>
			updateRun("2026-07-04-ENG-404", { outcome: "merged" }, { path }),
		).toThrow(/not found/);
	});

	it("rejects an invalid patch", () => {
		const path = tmpRuns();
		appendRun(rec(), { fsync: false, path });
		expect(() =>
			updateRun("2026-07-04-ENG-1", { tier: "nonsense" } as any, { path }),
		).toThrow(SchemaValidationError);
	});
});

describe("repairRuns", () => {
	it("quarantines a corrupt mid-file line so reads work again", () => {
		const path = tmpRuns();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const good1 = JSON.stringify(
			rec({ run_id: "2026-07-04-ENG-1", issue_id: "ENG-1" }),
		);
		const good2 = JSON.stringify(
			rec({ run_id: "2026-07-04-ENG-2", issue_id: "ENG-2" }),
		);
		writeFileSync(path, `${good1}\n{"run_id": "torn\n${good2}\n`);
		// the corrupt mid-file line makes a normal read fatal
		expect(() => readRuns({ path })).toThrow();
		const summary = repairRuns({ path });
		expect(summary.kept).toBe(2);
		expect(summary.quarantined).toBe(1);
		expect(summary.quarantinePath?.endsWith(".corrupt")).toBe(true);
		// reads work again and preserve the two good records in order
		expect(readRuns({ path }).map((r) => r.run_id)).toEqual([
			"2026-07-04-ENG-1",
			"2026-07-04-ENG-2",
		]);
		expect(readFileSync(summary.quarantinePath!, "utf-8")).toContain("torn");
	});
});
