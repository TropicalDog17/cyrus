import type { AskUserQuestionInput, IIssueTrackerService } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AskUserQuestionHandler,
	DEFAULT_QUESTION_TIMEOUT_MS,
	questionTimeoutMsFromMinutes,
} from "../src/AskUserQuestionHandler.js";

/**
 * Unit tests for AskUserQuestionHandler.
 *
 * These tests verify the handler correctly:
 * - Rejects multi-question inputs (only 1 question allowed at a time)
 * - Posts elicitation activities to Linear with the select signal
 * - Tracks pending questions and resolves them on user response
 * - Handles cancellations via AbortSignal properly
 */
describe("AskUserQuestionHandler", () => {
	let handler: AskUserQuestionHandler;
	let mockIssueTracker: IIssueTrackerService;
	let mockGetIssueTracker: (orgId: string) => IIssueTrackerService | null;
	let mockCreateAgentActivity: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		// Setup mock issue tracker
		mockCreateAgentActivity = vi.fn().mockResolvedValue({ success: true });
		mockIssueTracker = {
			createAgentActivity: mockCreateAgentActivity,
		} as unknown as IIssueTrackerService;

		mockGetIssueTracker = vi.fn().mockReturnValue(mockIssueTracker);

		handler = new AskUserQuestionHandler({
			getIssueTracker: mockGetIssueTracker,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("input validation", () => {
		it("should reject inputs with no questions", async () => {
			const input: AskUserQuestionInput = { questions: [] };
			const abortController = new AbortController();

			const result = await handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			expect(result.answered).toBe(false);
			expect(result.message).toContain(
				"Only one question at a time is supported",
			);
		});

		it("should reject inputs with multiple questions", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Question 1?",
						header: "Q1",
						options: [
							{ label: "A", description: "Option A" },
							{ label: "B", description: "Option B" },
						],
						multiSelect: false,
					},
					{
						question: "Question 2?",
						header: "Q2",
						options: [
							{ label: "C", description: "Option C" },
							{ label: "D", description: "Option D" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const result = await handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			expect(result.answered).toBe(false);
			expect(result.message).toContain(
				"Only one question at a time is supported",
			);
			// Should not have called createAgentActivity
			expect(mockCreateAgentActivity).not.toHaveBeenCalled();
		});

		it("should reject if signal is already aborted", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which framework?",
						header: "Framework",
						options: [
							{ label: "React", description: "Facebook's library" },
							{ label: "Vue", description: "Progressive framework" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();
			abortController.abort();

			const result = await handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			expect(result.answered).toBe(false);
			expect(result.message).toBe("Operation was cancelled");
		});

		it("should reject if issue tracker is not available", async () => {
			const noTrackerHandler = new AskUserQuestionHandler({
				getIssueTracker: () => null,
			});

			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which framework?",
						header: "Framework",
						options: [
							{ label: "React", description: "Facebook's library" },
							{ label: "Vue", description: "Progressive framework" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const result = await noTrackerHandler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			expect(result.answered).toBe(false);
			expect(result.message).toBe("Issue tracker not available");
		});
	});

	describe("elicitation posting", () => {
		it("should post elicitation to Linear with select signal", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database should we use?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
							{ label: "MongoDB", description: "Document database" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			// Don't await - just start the promise
			const resultPromise = handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			// Give it a moment to post the activity
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify the elicitation was posted. Options mirror the offered
			// choices exactly — no synthetic "Other" option, which could only
			// deliver the literal string "Other" (see handler for rationale).
			expect(mockCreateAgentActivity).toHaveBeenCalledWith({
				agentSessionId: "session-123",
				content: {
					type: "elicitation",
					body: expect.stringContaining("Which database should we use?"),
				},
				signal: "select",
				signalMetadata: {
					options: [{ value: "PostgreSQL" }, { value: "MongoDB" }],
				},
			});

			// The body should tell the user they can reply with a free-form answer.
			const postedBody = (mockCreateAgentActivity.mock.calls[0][0] as any)
				.content.body as string;
			expect(postedBody).toContain("reply with your own answer");
			expect(postedBody).not.toContain("Other");

			// Clean up by simulating response
			handler.handleUserResponse("session-123", "PostgreSQL");
			await resultPromise;
		});

		it("delivers a free-form (non-option) reply verbatim as the answer", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database should we use?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
							{ label: "MongoDB", description: "Document database" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const resultPromise = handler.handleAskUserQuestion(
				input,
				"session-free",
				"org-123",
				abortController.signal,
			);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// User ignores the buttons and types their own answer.
			handler.handleUserResponse(
				"session-free",
				"Use CockroachDB — we need multi-region",
			);

			const result = await resultPromise;
			expect(result.answered).toBe(true);
			expect(result.answers).toEqual({
				"Which database should we use?":
					"Use CockroachDB — we need multi-region",
			});
		});

		it("should include option descriptions in elicitation body", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which framework?",
						header: "Framework",
						options: [
							{ label: "React", description: "Facebook's library" },
							{ label: "Vue", description: "Progressive framework" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const resultPromise = handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			const callArg = mockCreateAgentActivity.mock.calls[0][0];
			expect(callArg.content.body).toContain("React");
			expect(callArg.content.body).toContain("Facebook's library");
			expect(callArg.content.body).toContain("Vue");
			expect(callArg.content.body).toContain("Progressive framework");

			handler.handleUserResponse("session-123", "React");
			await resultPromise;
		});
	});

	describe("response handling", () => {
		it("should resolve promise when user responds", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
							{ label: "MongoDB", description: "Document database" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const resultPromise = handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			// Wait for the pending question to be stored
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Simulate user response
			const handled = handler.handleUserResponse("session-123", "PostgreSQL");
			expect(handled).toBe(true);

			const result = await resultPromise;
			expect(result.answered).toBe(true);
			expect(result.answers).toEqual({
				"Which database?": "PostgreSQL",
			});
		});

		it("should not resolve for unknown session", () => {
			const handled = handler.handleUserResponse(
				"unknown-session",
				"PostgreSQL",
			);
			expect(handled).toBe(false);
		});

		it("should return false for hasPendingQuestion when no pending", () => {
			expect(handler.hasPendingQuestion("non-existent")).toBe(false);
		});

		it("should return true for hasPendingQuestion when pending", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			// Start but don't await
			const promise = handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(handler.hasPendingQuestion("session-123")).toBe(true);

			// Clean up
			handler.handleUserResponse("session-123", "PostgreSQL");
			await promise;
		});
	});

	describe("cancellation handling", () => {
		it("should resolve with cancellation message when aborted", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const resultPromise = handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			// Wait for pending question to be stored
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Abort
			abortController.abort();

			const result = await resultPromise;
			expect(result.answered).toBe(false);
			expect(result.message).toBe("Operation was cancelled");
		});

		it("should resolve with custom message when cancelPendingQuestion is called", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const resultPromise = handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			handler.cancelPendingQuestion(
				"session-123",
				"Custom cancellation reason",
			);

			const result = await resultPromise;
			expect(result.answered).toBe(false);
			expect(result.message).toBe("Custom cancellation reason");
		});
	});

	describe("replacing pending questions", () => {
		it("should cancel existing pending question when new one arrives", async () => {
			const input1: AskUserQuestionInput = {
				questions: [
					{
						question: "First question?",
						header: "First",
						options: [{ label: "A", description: "Option A" }],
						multiSelect: false,
					},
				],
			};
			const input2: AskUserQuestionInput = {
				questions: [
					{
						question: "Second question?",
						header: "Second",
						options: [{ label: "B", description: "Option B" }],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			// Start first question
			const resultPromise1 = handler.handleAskUserQuestion(
				input1,
				"session-123",
				"org-123",
				abortController.signal,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Start second question for same session
			const resultPromise2 = handler.handleAskUserQuestion(
				input2,
				"session-123",
				"org-123",
				abortController.signal,
			);

			// First should be cancelled
			const result1 = await resultPromise1;
			expect(result1.answered).toBe(false);
			expect(result1.message).toBe("Replaced by new question");

			// Clean up second
			await new Promise((resolve) => setTimeout(resolve, 10));
			handler.handleUserResponse("session-123", "B");
			const result2 = await resultPromise2;
			expect(result2.answered).toBe(true);
		});
	});

	describe("error handling", () => {
		it("should handle createAgentActivity failure", async () => {
			mockCreateAgentActivity.mockRejectedValue(new Error("API Error"));

			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const result = await handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			expect(result.answered).toBe(false);
			expect(result.message).toContain("Failed to present question");
			expect(result.message).toContain("API Error");
		});
	});

	describe("pendingCount", () => {
		it("should track number of pending questions", async () => {
			expect(handler.pendingCount).toBe(0);

			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const promise = handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(handler.pendingCount).toBe(1);

			handler.handleUserResponse("session-123", "PostgreSQL");
			await promise;

			expect(handler.pendingCount).toBe(0);
		});
	});

	describe("timeout handling", () => {
		const buildInput = (): AskUserQuestionInput => ({
			questions: [
				{
					question: "Which database?",
					header: "Database",
					options: [
						{ label: "PostgreSQL", description: "Open source relational DB" },
					],
					multiSelect: false,
				},
			],
		});

		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("should resolve with a denial when no response arrives before the timeout", async () => {
			const timeoutHandler = new AskUserQuestionHandler(
				{ getIssueTracker: mockGetIssueTracker },
				{ timeoutMs: 1000 },
			);
			const abortController = new AbortController();

			const resultPromise = timeoutHandler.handleAskUserQuestion(
				buildInput(),
				"session-timeout",
				"org-123",
				abortController.signal,
			);

			// Flush the elicitation post so the pending question registers
			await vi.advanceTimersByTimeAsync(0);
			expect(timeoutHandler.hasPendingQuestion("session-timeout")).toBe(true);

			// Advance past the timeout
			await vi.advanceTimersByTimeAsync(1000);

			const result = await resultPromise;
			expect(result.answered).toBe(false);
			expect(result.message).toContain("No response was received");
			// Pending entry must be cleaned up
			expect(timeoutHandler.hasPendingQuestion("session-timeout")).toBe(false);
		});

		it("should not time out when a response arrives first", async () => {
			const timeoutHandler = new AskUserQuestionHandler(
				{ getIssueTracker: mockGetIssueTracker },
				{ timeoutMs: 1000 },
			);
			const abortController = new AbortController();

			const resultPromise = timeoutHandler.handleAskUserQuestion(
				buildInput(),
				"session-fast",
				"org-123",
				abortController.signal,
			);

			await vi.advanceTimersByTimeAsync(0);

			const handled = timeoutHandler.handleUserResponse(
				"session-fast",
				"PostgreSQL",
			);
			expect(handled).toBe(true);

			// Advancing past the timeout must not double-resolve or throw
			await vi.advanceTimersByTimeAsync(2000);

			const result = await resultPromise;
			expect(result.answered).toBe(true);
			expect(result.answers).toEqual({ "Which database?": "PostgreSQL" });
		});

		it("should wait indefinitely when timeoutMs is 0", async () => {
			const noTimeoutHandler = new AskUserQuestionHandler(
				{ getIssueTracker: mockGetIssueTracker },
				{ timeoutMs: 0 },
			);
			const abortController = new AbortController();

			const resultPromise = noTimeoutHandler.handleAskUserQuestion(
				buildInput(),
				"session-inf",
				"org-123",
				abortController.signal,
			);

			await vi.advanceTimersByTimeAsync(0);
			// Even after a long time, the question is still pending
			await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
			expect(noTimeoutHandler.hasPendingQuestion("session-inf")).toBe(true);

			// Clean up
			noTimeoutHandler.handleUserResponse("session-inf", "PostgreSQL");
			const result = await resultPromise;
			expect(result.answered).toBe(true);
		});

		it("should prefer getTimeoutMs over constructor config", async () => {
			const getterHandler = new AskUserQuestionHandler(
				{
					getIssueTracker: mockGetIssueTracker,
					getTimeoutMs: () => 500,
				},
				{ timeoutMs: 60_000 },
			);
			const abortController = new AbortController();

			const resultPromise = getterHandler.handleAskUserQuestion(
				buildInput(),
				"session-getter",
				"org-123",
				abortController.signal,
			);

			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(500);

			const result = await resultPromise;
			expect(result.answered).toBe(false);
			expect(result.message).toContain("No response was received");
		});

		it("should fall back to constructor config when getTimeoutMs returns undefined", async () => {
			const fallbackHandler = new AskUserQuestionHandler(
				{
					getIssueTracker: mockGetIssueTracker,
					getTimeoutMs: () => undefined,
				},
				{ timeoutMs: 800 },
			);
			const abortController = new AbortController();

			const resultPromise = fallbackHandler.handleAskUserQuestion(
				buildInput(),
				"session-fallback",
				"org-123",
				abortController.signal,
			);

			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(800);

			const result = await resultPromise;
			expect(result.answered).toBe(false);
		});

		it("should wait indefinitely when getTimeoutMs returns 0", async () => {
			const indefiniteHandler = new AskUserQuestionHandler(
				{
					getIssueTracker: mockGetIssueTracker,
					getTimeoutMs: () => 0,
				},
				{ timeoutMs: 1000 },
			);
			const abortController = new AbortController();

			const resultPromise = indefiniteHandler.handleAskUserQuestion(
				buildInput(),
				"session-getter-zero",
				"org-123",
				abortController.signal,
			);

			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
			expect(indefiniteHandler.hasPendingQuestion("session-getter-zero")).toBe(
				true,
			);

			indefiniteHandler.handleUserResponse("session-getter-zero", "PostgreSQL");
			const result = await resultPromise;
			expect(result.answered).toBe(true);
		});

		it("should re-read getTimeoutMs on each question", async () => {
			let configuredTimeoutMs = 400;
			const hotReloadHandler = new AskUserQuestionHandler(
				{
					getIssueTracker: mockGetIssueTracker,
					getTimeoutMs: () => configuredTimeoutMs,
				},
				{ timeoutMs: 60_000 },
			);
			const abortController = new AbortController();

			const firstPromise = hotReloadHandler.handleAskUserQuestion(
				buildInput(),
				"session-reload-1",
				"org-123",
				abortController.signal,
			);

			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(400);
			const firstResult = await firstPromise;
			expect(firstResult.answered).toBe(false);

			configuredTimeoutMs = 200;
			const secondAbort = new AbortController();
			const secondPromise = hotReloadHandler.handleAskUserQuestion(
				buildInput(),
				"session-reload-2",
				"org-123",
				secondAbort.signal,
			);

			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(200);
			const secondResult = await secondPromise;
			expect(secondResult.answered).toBe(false);
		});
	});

	describe("questionTimeoutMsFromMinutes", () => {
		it("converts minutes to milliseconds", () => {
			expect(questionTimeoutMsFromMinutes(45)).toBe(2_700_000);
		});

		it("preserves 0 as indefinite wait", () => {
			expect(questionTimeoutMsFromMinutes(0)).toBe(0);
		});

		it("returns undefined when minutes is unset", () => {
			expect(questionTimeoutMsFromMinutes(undefined)).toBeUndefined();
		});
	});

	describe("default timeout", () => {
		const buildInput = (): AskUserQuestionInput => ({
			questions: [
				{
					question: "Which database?",
					header: "Database",
					options: [
						{ label: "PostgreSQL", description: "Open source relational DB" },
					],
					multiSelect: false,
				},
			],
		});

		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("defaults to 10 minutes (600_000 ms)", () => {
			expect(DEFAULT_QUESTION_TIMEOUT_MS).toBe(600_000);
		});

		it("uses DEFAULT_QUESTION_TIMEOUT_MS when no config or getter is provided", async () => {
			const defaultHandler = new AskUserQuestionHandler({
				getIssueTracker: mockGetIssueTracker,
			});
			const abortController = new AbortController();

			const resultPromise = defaultHandler.handleAskUserQuestion(
				buildInput(),
				"session-default",
				"org-123",
				abortController.signal,
			);

			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(DEFAULT_QUESTION_TIMEOUT_MS);

			const result = await resultPromise;
			expect(result.answered).toBe(false);
			expect(result.message).toContain("No response was received");
		});
	});
});
