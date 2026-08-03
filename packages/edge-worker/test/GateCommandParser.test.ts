import { describe, expect, it } from "vitest";
import { parseGateCommand } from "../src/closure/GateCommandParser.js";

describe("parseGateCommand", () => {
	it("parses approval without an implicit reason", () => {
		expect(parseGateCommand("/approve")).toEqual({ type: "approve" });
	});

	it("requires tagged request-change findings", () => {
		expect(
			parseGateCommand(
				"/request-changes missing test::recurring\nunsafe fallback::one-off",
			),
		).toEqual({
			type: "request-changes",
			findings: [
				{ text: "missing test", tag: "recurring" },
				{ text: "unsafe fallback", tag: "one-off" },
			],
		});
		expect(parseGateCommand("/request-changes missing test")).toBeUndefined();
	});

	it.each([
		"/reject",
		"/escalate",
	])("rejects %s without a reason", (command) => {
		expect(parseGateCommand(command)).toBeUndefined();
	});

	it("does not treat free-form text as a gate command", () => {
		expect(parseGateCommand("I need input before continuing")).toBeUndefined();
	});
});
