import { describe, expect, it } from "vitest";
import { acceptance, filesExpected, parseSpec } from "../src/spec.js";

// Ported from tests/test_misc.py (spec section)
const SPEC = `## Goal
Do the thing.

## Non-goals
- not this

## Files expected
- lib/a.dart
- src/b.py
- just some prose, not a path

## Acceptance
- [ ] tests pass
- [ ] it builds
`;

describe("spec", () => {
	it("parses the ## sections", () => {
		const sections = parseSpec(SPEC);
		expect(sections.goal!.startsWith("Do the thing")).toBe(true);
		expect(sections["non-goals"]).toContain("not this");
	});

	it("filters files expected to path-looking bullets only", () => {
		const files = filesExpected(SPEC);
		expect(files).toContain("lib/a.dart");
		expect(files).toContain("src/b.py");
		expect(files).not.toContain("just some prose, not a path");
	});

	it("returns acceptance bullets (checkbox prefix stripped)", () => {
		expect(acceptance(SPEC)).toEqual(["tests pass", "it builds"]);
	});
});
