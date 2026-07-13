import { describe, expect, it } from "vitest";
import {
	ASK_USER_QUESTION_PROMPT_ADDENDUM,
	appendAskUserQuestionAddendum,
} from "../src/prompts/askUserQuestionPromptAddendum.js";

describe("ask-user-question prompt addendum", () => {
	it("covers the one-question-per-call guidance", () => {
		expect(ASK_USER_QUESTION_PROMPT_ADDENDUM).toContain("<ask_user_question>");
		expect(ASK_USER_QUESTION_PROMPT_ADDENDUM).toMatch(/exactly ONE question/i);
		expect(ASK_USER_QUESTION_PROMPT_ADDENDUM).toMatch(/rejected/i);
		expect(ASK_USER_QUESTION_PROMPT_ADDENDUM).toMatch(/separate calls/i);
	});

	it("appends the addendum to an existing system prompt with a blank-line separator", () => {
		const result = appendAskUserQuestionAddendum("You are Cyrus.");
		expect(result.startsWith("You are Cyrus.\n\n")).toBe(true);
		expect(result.endsWith(ASK_USER_QUESTION_PROMPT_ADDENDUM)).toBe(true);
	});

	it("returns the addendum verbatim when no base prompt is provided", () => {
		expect(appendAskUserQuestionAddendum(undefined)).toBe(
			ASK_USER_QUESTION_PROMPT_ADDENDUM,
		);
		expect(appendAskUserQuestionAddendum(null)).toBe(
			ASK_USER_QUESTION_PROMPT_ADDENDUM,
		);
		expect(appendAskUserQuestionAddendum("")).toBe(
			ASK_USER_QUESTION_PROMPT_ADDENDUM,
		);
	});

	it("trims trailing whitespace from the existing prompt before joining", () => {
		const result = appendAskUserQuestionAddendum("Existing.\n\n   \n");
		expect(result).toBe(`Existing.\n\n${ASK_USER_QUESTION_PROMPT_ADDENDUM}`);
	});
});
