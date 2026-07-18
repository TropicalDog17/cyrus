/**
 * Single source of truth for AskUserQuestion tool guidance appended to every
 * customer-facing Claude system prompt.
 *
 * The Claude runner rejects multiple questions in a single AskUserQuestion call;
 * this addendum warns the agent up front so it does not waste a turn.
 */
export const ASK_USER_QUESTION_PROMPT_ADDENDUM = `
<ask_user_question>
When using the AskUserQuestion tool, ask exactly ONE question per call —
multiple questions in a single call are rejected. If you need several answers,
make separate calls.
</ask_user_question>
`.trim();

/**
 * Append the AskUserQuestion addendum to a system prompt fragment,
 * normalizing spacing so the boundary doesn't collide with prior content.
 */
export function appendAskUserQuestionAddendum(
	existing: string | undefined | null,
): string {
	const base = (existing ?? "").trimEnd();
	if (base.length === 0) return ASK_USER_QUESTION_PROMPT_ADDENDUM;
	return `${base}\n\n${ASK_USER_QUESTION_PROMPT_ADDENDUM}`;
}
