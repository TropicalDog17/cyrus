import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	canonicalStringify,
	formatErrors,
	SchemaValidationError,
	validate,
} from "../src/schemas.js";

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");

function exampleRuns(): { line: string; record: Record<string, unknown> }[] {
	const text = readFileSync(join(FIXTURES, "runs.jsonl.example"), "utf-8");
	return text
		.split("\n")
		.filter((l) => l.trim())
		.map((line) => ({ line, record: JSON.parse(line) }));
}

describe("runs schema", () => {
	it("accepts every record in the example file", () => {
		for (const { record } of exampleRuns()) {
			expect(formatErrors("runs", record)).toEqual([]);
		}
	});

	it("rejects a malformed run_id", () => {
		const rec = { ...exampleRuns()[0]!.record, run_id: "not-a-run-id" };
		const errors = formatErrors("runs", rec);
		expect(errors.some((e) => e.startsWith("$.run_id"))).toBe(true);
		expect(() => validate("runs", rec)).toThrow(SchemaValidationError);
	});

	it("rejects unknown top-level properties (additionalProperties:false)", () => {
		const rec = { ...exampleRuns()[0]!.record, bogus_field: 1 };
		expect(formatErrors("runs", rec).length).toBeGreaterThan(0);
	});

	it("rejects a missing required field", () => {
		const rec = { ...exampleRuns()[0]!.record };
		delete (rec as Record<string, unknown>).outcome;
		expect(formatErrors("runs", rec).length).toBeGreaterThan(0);
	});
});

describe("ledger schema", () => {
	it("accepts a minimal entry and rejects a bad id / kind", () => {
		expect(formatErrors("ledger", { id: "E1", kind: "tests" })).toEqual([]);
		expect(
			formatErrors("ledger", { id: "X1", kind: "tests" }).length,
		).toBeGreaterThan(0);
		expect(
			formatErrors("ledger", { id: "E1", kind: "nope" }).length,
		).toBeGreaterThan(0);
	});
});

describe("judge schema", () => {
	it("accepts a citation-locked output and rejects a dangling evidence id shape", () => {
		expect(
			formatErrors("judge", {
				verdict: "pass",
				claims: [{ claim: "x", evidence: "E1" }],
				concerns: [],
			}),
		).toEqual([]);
		expect(
			formatErrors("judge", {
				verdict: "pass",
				claims: [{ claim: "x", evidence: "bad" }],
				concerns: [],
			}).length,
		).toBeGreaterThan(0);
	});
});

describe("canonicalStringify", () => {
	it("reproduces Python json.dumps(sort_keys=True) byte-for-byte on the example file", () => {
		// The example lines were written by Python with sort_keys=True; re-serializing the
		// parsed object here must produce the identical bytes.
		for (const { line, record } of exampleRuns()) {
			expect(canonicalStringify(record)).toBe(line);
		}
	});

	it("sorts keys recursively and uses ', ' / ': ' separators", () => {
		expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
			'{"a": {"c": 3, "d": 2}, "b": 1}',
		);
		expect(canonicalStringify([])).toBe("[]");
		expect(canonicalStringify({})).toBe("{}");
		expect(canonicalStringify(null)).toBe("null");
	});
});
