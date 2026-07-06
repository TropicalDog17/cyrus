import { describe, expect, it } from "vitest";
import {
	classifyComment,
	isSystemComment,
	reworkSaveIssueArgs,
	specGateFromComment,
} from "../src/linearConventions.js";

// Ported from tests/test_misc.py (linear section)
describe("classifyComment", () => {
	it.each([
		["approve", "approve"],
		["LGTM 🚀", "approve"],
		["reject: missing tests", "reject"],
		["edit: tighten the non-goals", "edit"],
		["edited spec below\n## Goal ...", "edit"],
		["what about the edge case?", "none"],
	])("classifies %j as %s", (body, expected) => {
		expect(classifyComment(body)).toBe(expected);
	});
});

describe("specGateFromComment", () => {
	it("maps a classified reply to a runs.jsonl spec_gate value", () => {
		expect(specGateFromComment("approve")).toBe("approved");
		expect(specGateFromComment("edit: x")).toBe("edited");
		expect(specGateFromComment("reject")).toBe("rejected");
		expect(specGateFromComment("hmm")).toBeNull();
	});
});

describe("isSystemComment", () => {
	it("treats an author-less comment as a system marker", () => {
		expect(isSystemComment({ author: null })).toBe(true);
		expect(isSystemComment({ author: { name: "me" } })).toBe(false);
	});
});

describe("reworkSaveIssueArgs", () => {
	it("uses a flat label plus a relatedTo relation, never a colon label", () => {
		const args = reworkSaveIssueArgs("ENG-91", "ENG-78", ["Bug"]);
		expect(args.labels).toEqual(["rework-of", "Bug"]);
		expect(args.relatedTo).toEqual(["ENG-78"]);
		// the corrected convention: no colon label carrying the issue id
		expect(args.labels.some((label) => label.includes(":"))).toBe(false);
	});
});
