import type { AskUserQuestionInput, ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuzzApprovalRegistry } from "../src/buzz/BuzzApprovalRegistry.js";
import type { BuzzCliClient } from "../src/buzz/BuzzCliClient.js";
import { BuzzQuestionHandler } from "../src/buzz/BuzzQuestionHandler.js";

const CHANNEL_ID = "6f1a2b3c-0000-4000-8000-000000000001";
const THREAD_ROOT = "d".repeat(64);
const QUESTION_ID = "e".repeat(64);
const SESSION_ID = `buzz-${THREAD_ROOT}`;
const ACTOR = "9".repeat(64);

const INPUT: AskUserQuestionInput = {
	questions: [
		{
			question: "Which database should I use?",
			header: "Database",
			multiSelect: false,
			options: [
				{ label: "Postgres", description: "Matches the rest of the stack" },
				{ label: "SQLite", description: "Zero setup, single file" },
			],
		},
	],
};

function createLogger(): ILogger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		withContext: vi.fn().mockReturnThis(),
	} as unknown as ILogger;
}

describe("BuzzQuestionHandler", () => {
	let sendMessage: ReturnType<typeof vi.fn>;
	let addReaction: ReturnType<typeof vi.fn>;
	let approvals: BuzzApprovalRegistry;
	let handler: BuzzQuestionHandler;
	let timeoutMs: number;
	let logger: ILogger;

	beforeEach(() => {
		sendMessage = vi.fn().mockResolvedValue(QUESTION_ID);
		addReaction = vi.fn().mockResolvedValue(undefined);
		logger = createLogger();
		approvals = new BuzzApprovalRegistry(logger);
		timeoutMs = 600_000;

		handler = new BuzzQuestionHandler({
			logger,
			client: { sendMessage, addReaction } as unknown as BuzzCliClient,
			approvals,
			getThread: (sessionId) =>
				sessionId === SESSION_ID
					? { channelId: CHANNEL_ID, threadRootId: THREAD_ROOT }
					: null,
			getTimeoutMs: () => timeoutMs,
		});
	});

	it("only handles sessions bound to a Buzz thread", () => {
		expect(handler.handles(SESSION_ID)).toBe(true);
		expect(handler.handles("linear-session")).toBe(false);
	});

	it("posts the question into the thread with reactable options", async () => {
		const pending = handler.ask(
			INPUT,
			SESSION_ID,
			new AbortController().signal,
		);
		await vi.waitFor(() => expect(addReaction).toHaveBeenCalledTimes(2));

		const [call] = sendMessage.mock.calls;
		expect(call?.[0]).toEqual(
			expect.objectContaining({
				channelId: CHANNEL_ID,
				replyTo: THREAD_ROOT,
			}),
		);
		const content = call?.[0].content as string;
		expect(content).toContain("Which database should I use?");
		expect(content).toContain("1⃣ **Postgres** — Matches the rest of the stack");
		expect(content).toContain("2⃣ **SQLite** — Zero setup, single file");
		// The wait policy is announced, so nobody is surprised that it proceeded.
		expect(content).toContain("10 minute(s)");

		expect(addReaction).toHaveBeenCalledWith({
			eventId: QUESTION_ID,
			emoji: "1⃣",
		});

		approvals.resolveByReaction(QUESTION_ID, "1⃣", ACTOR);
		await pending;
	});

	it("answers from a reaction", async () => {
		const pending = handler.ask(
			INPUT,
			SESSION_ID,
			new AbortController().signal,
		);
		await vi.waitFor(() =>
			expect(approvals.hasPendingPrompt(SESSION_ID)).toBe(true),
		);

		approvals.resolveByReaction(QUESTION_ID, "2⃣", ACTOR);

		await expect(pending).resolves.toEqual({
			answered: true,
			answers: { "Which database should I use?": "SQLite" },
		});
	});

	it("answers from free-text prose in the thread", async () => {
		const pending = handler.ask(
			INPUT,
			SESSION_ID,
			new AbortController().signal,
		);
		await vi.waitFor(() =>
			expect(approvals.hasPendingPrompt(SESSION_ID)).toBe(true),
		);

		approvals.resolveByReply(SESSION_ID, "use DuckDB actually", ACTOR);

		await expect(pending).resolves.toEqual({
			answered: true,
			answers: { "Which database should I use?": "use DuckDB actually" },
		});
	});

	// The wait policy: a question does not park. Cyrus never invents an answer
	// and attributes it to a human — it tells the model to use its own judgment.
	it("proceeds on its own recommendation when nobody answers", async () => {
		timeoutMs = 1000;
		const pending = handler.ask(
			INPUT,
			SESSION_ID,
			new AbortController().signal,
		);
		await vi.waitFor(() =>
			expect(approvals.hasPendingPrompt(SESSION_ID)).toBe(true),
		);

		const result = await pending;

		expect(result.answered).toBe(false);
		expect(result.message).toMatch(/Proceed using your best judgment/);
		// And it says so in the thread rather than going quiet.
		expect(sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("going with my own recommendation"),
			}),
		);
	});

	it("cancels the pending prompt when the session is aborted", async () => {
		const controller = new AbortController();
		const pending = handler.ask(INPUT, SESSION_ID, controller.signal);
		await vi.waitFor(() =>
			expect(approvals.hasPendingPrompt(SESSION_ID)).toBe(true),
		);

		controller.abort();

		await expect(pending).resolves.toEqual({
			answered: false,
			message: "Operation was cancelled",
		});
	});

	it("refuses a session with no Buzz thread", async () => {
		const result = await handler.ask(
			INPUT,
			"linear-session",
			new AbortController().signal,
		);

		expect(result.answered).toBe(false);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("rejects more than one question at a time", async () => {
		const result = await handler.ask(
			{ questions: [...INPUT.questions, ...INPUT.questions] },
			SESSION_ID,
			new AbortController().signal,
		);

		expect(result).toEqual({
			answered: false,
			message: "Only one question at a time is supported in a Buzz thread",
		});
	});

	// A question the human never sees must unblock the runner, not hang it.
	it("unblocks when the relay refuses the message", async () => {
		sendMessage.mockRejectedValue(new Error("relay unreachable"));

		const result = await handler.ask(
			INPUT,
			SESSION_ID,
			new AbortController().signal,
		);

		expect(result.answered).toBe(false);
		expect(result.message).toContain("relay unreachable");
	});

	it("still asks when seeding the reactions fails", async () => {
		addReaction.mockRejectedValue(new Error("rate limited"));

		const pending = handler.ask(
			INPUT,
			SESSION_ID,
			new AbortController().signal,
		);
		await vi.waitFor(() =>
			expect(approvals.hasPendingPrompt(SESSION_ID)).toBe(true),
		);
		approvals.resolveByReaction(QUESTION_ID, "1⃣", ACTOR);

		await expect(pending).resolves.toEqual(
			expect.objectContaining({ answered: true }),
		);
	});
});
