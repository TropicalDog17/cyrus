import type { BuzzWebhookEvent } from "cyrus-buzz-event-transport";
import type { ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuzzApprovalRegistry } from "../src/buzz/BuzzApprovalRegistry.js";
import type {
	BuzzCliClient,
	BuzzEventRecord,
} from "../src/buzz/BuzzCliClient.js";
import { BuzzPollingSource } from "../src/buzz/BuzzPollingSource.js";

const CHANNEL_ID = "6f1a2b3c-0000-4000-8000-000000000001";
const MESSAGE_ID = "a".repeat(64);
const GATE_ID = "c".repeat(64);
const ALLOWED = "9".repeat(64);
const STRANGER = "7".repeat(64);
const SELF = "5".repeat(64);
/**
 * Inside the source's initial lookback window. The high-water mark only ever
 * moves forward, so a fixture timestamp older than the window would be clamped
 * to it and the advance would be untestable.
 */
const NOW = Math.floor(Date.now() / 1000);

function createLogger(): ILogger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		withContext: vi.fn().mockReturnThis(),
	} as unknown as ILogger;
}

function message(overrides: Partial<BuzzEventRecord> = {}): BuzzEventRecord {
	return {
		id: MESSAGE_ID,
		pubkey: ALLOWED,
		kind: 9,
		content: "look at the flaky test",
		created_at: NOW - 60,
		tags: [],
		...overrides,
	};
}

describe("BuzzPollingSource", () => {
	let getMessages: ReturnType<typeof vi.fn>;
	let getReactions: ReturnType<typeof vi.fn>;
	let onEvent: ReturnType<typeof vi.fn>;
	let approvals: BuzzApprovalRegistry;
	let logger: ILogger;
	let allowed: string[];
	let source: BuzzPollingSource;

	beforeEach(() => {
		getMessages = vi.fn().mockResolvedValue([]);
		getReactions = vi.fn().mockResolvedValue([]);
		onEvent = vi.fn();
		logger = createLogger();
		approvals = new BuzzApprovalRegistry(logger);
		allowed = [ALLOWED];

		source = new BuzzPollingSource({
			logger,
			client: { getMessages, getReactions } as unknown as BuzzCliClient,
			approvals,
			getChannelIds: () => [CHANNEL_ID],
			getAllowedPubkeys: () => allowed,
			getSelfPubkey: () => SELF,
			onEvent,
			intervalMs: 5000,
		});
	});

	function emitted(): BuzzWebhookEvent[] {
		return onEvent.mock.calls.map((call) => call[0] as BuzzWebhookEvent);
	}

	it("emits a message from an allowlisted author", async () => {
		getMessages.mockResolvedValue([message()]);

		await source.tick();

		expect(emitted()).toEqual([
			{
				eventType: "message_posted",
				messageId: MESSAGE_ID,
				channelId: CHANNEL_ID,
				authorPubkey: ALLOWED,
				timestamp: String(NOW - 60),
				deliveryId: `message_posted:${MESSAGE_ID}:`,
			},
		]);
	});

	// Buzz membership is not authorization to spend tokens on someone's behalf.
	it("ignores messages from pubkeys that are not allowlisted", async () => {
		getMessages.mockResolvedValue([message({ pubkey: STRANGER })]);

		await source.tick();

		expect(onEvent).not.toHaveBeenCalled();
	});

	it("denies everyone when the allowlist is empty", async () => {
		allowed = [];
		getMessages.mockResolvedValue([message()]);

		await source.tick();

		expect(onEvent).not.toHaveBeenCalled();
	});

	// Cyrus posts into the same channels it reads. Without this the first reply
	// would trigger a new session, which would reply, which would trigger...
	it("ignores its own messages", async () => {
		getMessages.mockResolvedValue([message({ pubkey: SELF })]);
		allowed = [ALLOWED, SELF];

		await source.tick();

		expect(onEvent).not.toHaveBeenCalled();
	});

	// The Nostr `since` filter is inclusive, so the high-water event comes back.
	it("advances the since window past the newest message seen", async () => {
		getMessages.mockResolvedValue([
			message({ created_at: NOW - 60 }),
			message({ id: "b".repeat(64), created_at: NOW - 30 }),
		]);

		await source.tick();
		getMessages.mockResolvedValue([]);
		await source.tick();

		expect(getMessages).toHaveBeenLastCalledWith({
			channelId: CHANNEL_ID,
			since: NOW - 30,
		});
	});

	// Otherwise a channel busy with unlisted chatter re-reads the same window on
	// every tick, forever.
	it("advances the window even for messages it filters out", async () => {
		getMessages.mockResolvedValue([
			message({ pubkey: STRANGER, created_at: NOW - 20 }),
		]);

		await source.tick();
		await source.tick();

		expect(getMessages).toHaveBeenLastCalledWith({
			channelId: CHANNEL_ID,
			since: NOW - 20,
		});
	});

	it("emits a reaction on an event with an open prompt", async () => {
		approvals.register({
			eventId: GATE_ID,
			channelId: CHANNEL_ID,
			sessionId: "buzz-session",
			kind: "gate",
			options: [{ emoji: "▶️", value: "implement", label: "implement" }],
		});
		getReactions.mockResolvedValue([
			{ emoji: "▶️", count: 1, pubkeys: [ALLOWED] },
		]);

		await source.tick();

		expect(getReactions).toHaveBeenCalledWith({ eventId: GATE_ID });
		expect(emitted()).toEqual([
			expect.objectContaining({
				eventType: "reaction_added",
				messageId: GATE_ID,
				emoji: "▶️",
				authorPubkey: ALLOWED,
				deliveryId: `reaction_added:${GATE_ID}:▶️:${ALLOWED}`,
			}),
		]);
	});

	// `reactions get` returns the current set, not a delta, so every tick sees
	// the same reaction again.
	it("emits a given reaction only once", async () => {
		approvals.register({
			eventId: GATE_ID,
			channelId: CHANNEL_ID,
			sessionId: "buzz-session",
			kind: "gate",
			options: [{ emoji: "▶️", value: "implement", label: "implement" }],
		});
		getReactions.mockResolvedValue([
			{ emoji: "▶️", count: 1, pubkeys: [ALLOWED] },
		]);

		await source.tick();
		await source.tick();

		expect(emitted()).toHaveLength(1);
	});

	// An unbounded reaction poll would be one relay round trip per message ever
	// posted; only events something is waiting on are worth the call.
	it("does not poll reactions when nothing is pending", async () => {
		await source.tick();

		expect(getReactions).not.toHaveBeenCalled();
	});

	it("applies the allowlist to reactions too", async () => {
		approvals.register({
			eventId: GATE_ID,
			channelId: CHANNEL_ID,
			sessionId: "buzz-session",
			kind: "gate",
			options: [{ emoji: "▶️", value: "implement", label: "implement" }],
		});
		getReactions.mockResolvedValue([
			{ emoji: "▶️", count: 2, pubkeys: [STRANGER, SELF] },
		]);

		await source.tick();

		expect(onEvent).not.toHaveBeenCalled();
	});

	it("keeps polling after a relay failure on one channel", async () => {
		getMessages.mockRejectedValueOnce(new Error("relay down"));

		await source.tick();
		expect(logger.warn).toHaveBeenCalled();

		getMessages.mockResolvedValue([message()]);
		await source.tick();

		expect(emitted()).toHaveLength(1);
	});

	// A slow relay must not stack concurrent cycles that each re-read the same
	// window and double-dispatch it.
	it("does not run overlapping ticks", async () => {
		let release: () => void = () => {};
		getMessages.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () => resolve([message()]);
				}),
		);

		const first = source.tick();
		const second = source.tick();
		release();
		await Promise.all([first, second]);

		expect(getMessages).toHaveBeenCalledTimes(1);
	});
});
