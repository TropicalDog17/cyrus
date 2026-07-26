import type { ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuzzApprovalRegistry } from "../src/buzz/BuzzApprovalRegistry.js";

const EVENT_ID = "a".repeat(64);
const OTHER_EVENT_ID = "b".repeat(64);
const SESSION_ID = "buzz-session";
const ACTOR = "9".repeat(64);

const GATE_OPTIONS = [
	{ emoji: "▶️", value: "implement", label: "implement" },
	{ emoji: "📝", value: "track", label: "track" },
];

const QUESTION_OPTIONS = [
	{ emoji: "1⃣", value: "Postgres", label: "Postgres" },
	{ emoji: "2⃣", value: "SQLite", label: "SQLite" },
];

function createLogger(): ILogger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		withContext: vi.fn().mockReturnThis(),
	} as unknown as ILogger;
}

describe("BuzzApprovalRegistry", () => {
	let registry: BuzzApprovalRegistry;

	beforeEach(() => {
		registry = new BuzzApprovalRegistry(createLogger());
	});

	it("resolves a gate from a matching reaction", async () => {
		const pending = registry.register({
			eventId: EVENT_ID,
			channelId: "channel",
			sessionId: SESSION_ID,
			kind: "gate",
			options: GATE_OPTIONS,
		});

		expect(registry.resolveByReaction(EVENT_ID, "▶️", ACTOR)).toBe(true);

		await expect(pending).resolves.toEqual({
			value: "implement",
			via: "reaction",
			actorPubkey: ACTOR,
		});
	});

	it("ignores a reaction that is not one of the offered options", async () => {
		registry.register({
			eventId: EVENT_ID,
			channelId: "channel",
			sessionId: SESSION_ID,
			kind: "gate",
			options: GATE_OPTIONS,
		});

		expect(registry.resolveByReaction(EVENT_ID, "🎉", ACTOR)).toBe(false);
		expect(registry.hasPendingPrompt(SESSION_ID)).toBe(true);
	});

	it("ignores a reaction on an event with no open prompt", () => {
		expect(registry.resolveByReaction(OTHER_EVENT_ID, "▶️", ACTOR)).toBe(false);
	});

	// Free text is the whole point of a chat surface: a human who types something
	// other than an offered option is still answering.
	it("resolves a question from free-text prose", async () => {
		const pending = registry.register({
			eventId: EVENT_ID,
			channelId: "channel",
			sessionId: SESSION_ID,
			kind: "question",
			options: QUESTION_OPTIONS,
		});

		expect(
			registry.resolveByReply(SESSION_ID, "neither, use DuckDB", ACTOR),
		).toBe(true);

		await expect(pending).resolves.toEqual({
			value: "neither, use DuckDB",
			via: "reply",
			actorPubkey: ACTOR,
		});
	});

	it("maps a reply that names an option onto that option's value", async () => {
		const pending = registry.register({
			eventId: EVENT_ID,
			channelId: "channel",
			sessionId: SESSION_ID,
			kind: "question",
			options: QUESTION_OPTIONS,
		});

		registry.resolveByReply(SESSION_ID, "  sqlite  ", ACTOR);

		await expect(pending).resolves.toEqual(
			expect.objectContaining({ value: "SQLite" }),
		);
	});

	// Opening the gate must be deliberate. Chat in a thread with an open gate is
	// conversation, not consent to write code.
	it("does not open a gate from prose", () => {
		registry.register({
			eventId: EVENT_ID,
			channelId: "channel",
			sessionId: SESSION_ID,
			kind: "gate",
			options: GATE_OPTIONS,
		});

		expect(registry.resolveByReply(SESSION_ID, "yeah go for it", ACTOR)).toBe(
			false,
		);
		expect(registry.hasPendingPrompt(SESSION_ID)).toBe(true);
	});

	it("opens a gate from a reply that names the option exactly", async () => {
		const pending = registry.register({
			eventId: EVENT_ID,
			channelId: "channel",
			sessionId: SESSION_ID,
			kind: "gate",
			options: GATE_OPTIONS,
		});

		expect(registry.resolveByReply(SESSION_ID, "implement", ACTOR)).toBe(true);
		await expect(pending).resolves.toEqual(
			expect.objectContaining({ value: "implement" }),
		);
	});

	it("resolves a question with the timeout value once the window passes", async () => {
		vi.useFakeTimers();
		try {
			const pending = registry.register({
				eventId: EVENT_ID,
				channelId: "channel",
				sessionId: SESSION_ID,
				kind: "question",
				options: QUESTION_OPTIONS,
				timeoutMs: 1000,
				timeoutValue: "",
			});

			await vi.advanceTimersByTimeAsync(1001);

			await expect(pending).resolves.toEqual({ value: "", via: "timeout" });
		} finally {
			vi.useRealTimers();
		}
	});

	// A gate with no timeout is the wait policy: unattended chat never promotes
	// itself into code changes just because nobody was looking.
	it("never times a gate out on its own", async () => {
		vi.useFakeTimers();
		try {
			registry.register({
				eventId: EVENT_ID,
				channelId: "channel",
				sessionId: SESSION_ID,
				kind: "gate",
				options: GATE_OPTIONS,
			});

			await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

			expect(registry.hasPendingPrompt(SESSION_ID)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("replaces a session's earlier prompt when a new one is registered", async () => {
		const first = registry.register({
			eventId: EVENT_ID,
			channelId: "channel",
			sessionId: SESSION_ID,
			kind: "gate",
			options: GATE_OPTIONS,
		});

		registry.register({
			eventId: OTHER_EVENT_ID,
			channelId: "channel",
			sessionId: SESSION_ID,
			kind: "gate",
			options: GATE_OPTIONS,
		});

		await expect(first).resolves.toEqual({ value: "", via: "timeout" });
		// The superseded event must stop being polled for reactions.
		expect(registry.pendingEventIds()).toEqual([OTHER_EVENT_ID]);
	});

	it("lists open event ids so only those are polled for reactions", () => {
		expect(registry.pendingEventIds()).toEqual([]);

		registry.register({
			eventId: EVENT_ID,
			channelId: "channel",
			sessionId: SESSION_ID,
			kind: "gate",
			options: GATE_OPTIONS,
		});

		expect(registry.pendingEventIds()).toEqual([EVENT_ID]);

		registry.resolveByReaction(EVENT_ID, "▶️", ACTOR);
		expect(registry.pendingEventIds()).toEqual([]);
	});

	it("settles a session's prompt when the session is cancelled", async () => {
		const pending = registry.register({
			eventId: EVENT_ID,
			channelId: "channel",
			sessionId: SESSION_ID,
			kind: "question",
			options: QUESTION_OPTIONS,
		});

		registry.cancelSession(SESSION_ID, "Session was stopped");

		await expect(pending).resolves.toEqual({ value: "", via: "timeout" });
		expect(registry.hasPendingPrompt(SESSION_ID)).toBe(false);
	});

	it("only settles a prompt once", async () => {
		const pending = registry.register({
			eventId: EVENT_ID,
			channelId: "channel",
			sessionId: SESSION_ID,
			kind: "gate",
			options: GATE_OPTIONS,
		});

		expect(registry.resolveByReaction(EVENT_ID, "▶️", ACTOR)).toBe(true);
		expect(registry.resolveByReaction(EVENT_ID, "📝", ACTOR)).toBe(false);

		await expect(pending).resolves.toEqual(
			expect.objectContaining({ value: "implement" }),
		);
	});

	it("ignores a whitespace-only reply", () => {
		registry.register({
			eventId: EVENT_ID,
			channelId: "channel",
			sessionId: SESSION_ID,
			kind: "question",
			options: QUESTION_OPTIONS,
		});

		expect(registry.resolveByReply(SESSION_ID, "   \n ", ACTOR)).toBe(false);
		expect(registry.hasPendingPrompt(SESSION_ID)).toBe(true);
	});
});
