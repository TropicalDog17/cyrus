import { describe, expect, it } from "vitest";
import {
	appendContextDisciplineAddendum,
	CONTEXT_DISCIPLINE_PROMPT_ADDENDUM,
} from "../src/prompts/contextDisciplinePromptAddendum.js";

describe("context-discipline prompt addendum", () => {
	it("covers the core read-discipline guidance", () => {
		expect(CONTEXT_DISCIPLINE_PROMPT_ADDENDUM).toContain(
			"<context_discipline>",
		);
		expect(CONTEXT_DISCIPLINE_PROMPT_ADDENDUM).toMatch(/re-read/i);
		expect(CONTEXT_DISCIPLINE_PROMPT_ADDENDUM).toMatch(/targeted reads/i);
		expect(CONTEXT_DISCIPLINE_PROMPT_ADDENDUM).toMatch(/scoped issues/i);
	});

	it("directs broad file sweeps to the Agent tool rather than the main thread", () => {
		// The tool is named `Agent` in the current SDK — the older `Task` name would
		// point the model at a tool that does not exist.
		expect(CONTEXT_DISCIPLINE_PROMPT_ADDENDUM).toMatch(/\bAgent tool\b/);
		expect(CONTEXT_DISCIPLINE_PROMPT_ADDENDUM).not.toMatch(/\bTask tool\b/);
		expect(CONTEXT_DISCIPLINE_PROMPT_ADDENDUM).toMatch(/file:line/);
		// Delegation is scoped to reconnaissance; files being edited are read directly.
		expect(CONTEXT_DISCIPLINE_PROMPT_ADDENDUM).toMatch(
			/Read directly the files you are about to edit/,
		);
		// Post-compact recovery is the case plain re-read discipline misses.
		expect(CONTEXT_DISCIPLINE_PROMPT_ADDENDUM).toMatch(/auto-compact/);
	});

	it("frames the guidance as avoiding wasted work, not cutting corners", () => {
		expect(CONTEXT_DISCIPLINE_PROMPT_ADDENDUM).toMatch(/wasted/i);
		expect(CONTEXT_DISCIPLINE_PROMPT_ADDENDUM).toMatch(
			/whatever you\s+genuinely need/i,
		);
	});

	it("appends the addendum to an existing system prompt with a blank-line separator", () => {
		const result = appendContextDisciplineAddendum("You are Cyrus.");
		expect(result.startsWith("You are Cyrus.\n\n")).toBe(true);
		expect(result.endsWith(CONTEXT_DISCIPLINE_PROMPT_ADDENDUM)).toBe(true);
	});

	it("returns the addendum verbatim when no base prompt is provided", () => {
		expect(appendContextDisciplineAddendum(undefined)).toBe(
			CONTEXT_DISCIPLINE_PROMPT_ADDENDUM,
		);
		expect(appendContextDisciplineAddendum(null)).toBe(
			CONTEXT_DISCIPLINE_PROMPT_ADDENDUM,
		);
		expect(appendContextDisciplineAddendum("")).toBe(
			CONTEXT_DISCIPLINE_PROMPT_ADDENDUM,
		);
	});

	it("trims trailing whitespace from the existing prompt before joining", () => {
		const result = appendContextDisciplineAddendum("Existing.\n\n   \n");
		expect(result).toBe(`Existing.\n\n${CONTEXT_DISCIPLINE_PROMPT_ADDENDUM}`);
	});
});
