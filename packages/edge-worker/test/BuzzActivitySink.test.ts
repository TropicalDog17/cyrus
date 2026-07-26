import type { ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuzzCliClient } from "../src/buzz/BuzzCliClient.js";
import { BuzzActivitySink } from "../src/sinks/BuzzActivitySink.js";

const CHANNEL_ID = "6f1a2b3c-0000-4000-8000-000000000001";
const THREAD_ROOT = "d".repeat(64);

function createLogger(): ILogger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		withContext: vi.fn().mockReturnThis(),
	} as unknown as ILogger;
}

describe("BuzzActivitySink", () => {
	let sendMessage: ReturnType<typeof vi.fn>;
	let sink: BuzzActivitySink;
	let logger: ILogger;

	beforeEach(() => {
		sendMessage = vi.fn().mockResolvedValue("e".repeat(64));
		logger = createLogger();
		sink = new BuzzActivitySink(
			{ sendMessage } as unknown as BuzzCliClient,
			CHANNEL_ID,
			logger,
		);
	});

	it("identifies itself by channel", () => {
		expect(sink.id).toBe(`buzz:${CHANNEL_ID}`);
	});

	it("posts a response as a threaded reply", async () => {
		const result = await sink.post(THREAD_ROOT, {
			type: "response",
			body: "Here is what I found.",
		});

		expect(sendMessage).toHaveBeenCalledWith({
			channelId: CHANNEL_ID,
			content: "Here is what I found.",
			replyTo: THREAD_ROOT,
		});
		expect(result).toEqual({ activityId: "e".repeat(64) });
	});

	it("posts elicitations so a question reaches the thread", async () => {
		await sink.post(THREAD_ROOT, {
			type: "elicitation",
			body: "Which repo should I use?",
		});

		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: "Which repo should I use?" }),
		);
	});

	it("marks errors so they are visible in a chat log", async () => {
		await sink.post(THREAD_ROOT, { type: "error", body: "Build failed" });

		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: "⚠️ Build failed" }),
		);
	});

	// A Buzz thread is a chat log humans read, not a collapsible agent timeline:
	// narrating every tool call would bury the answer.
	it.each([
		["thought", { type: "thought" as const, body: "Considering options" }],
		[
			"action",
			{ type: "action" as const, action: "Read", parameter: "src/index.ts" },
		],
	])("does not post %s activities", async (_label, activity) => {
		const result = await sink.post(THREAD_ROOT, activity);

		expect(sendMessage).not.toHaveBeenCalled();
		expect(result).toEqual({});
	});

	it("drops ephemeral activities, which have no meaning in an append-only thread", async () => {
		await sink.post(THREAD_ROOT, {
			type: "response",
			body: "Working...",
			ephemeral: true,
		});

		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("skips whitespace-only bodies", async () => {
		await sink.post(THREAD_ROOT, { type: "response", body: "   \n  " });

		expect(sendMessage).not.toHaveBeenCalled();
	});

	// Buzz egress is a side effect of a session, not a precondition for it — a
	// relay hiccup must not abort a run that is already writing code.
	it("swallows and logs relay failures", async () => {
		sendMessage.mockRejectedValue(new Error("relay unreachable"));

		const result = await sink.post(THREAD_ROOT, {
			type: "response",
			body: "done",
		});

		expect(result).toEqual({});
		expect(logger.error).toHaveBeenCalled();
	});

	it("refuses to invent a thread for createAgentSession", async () => {
		await expect(sink.createAgentSession("BUZZ-abc123")).rejects.toThrow(
			/originate from an existing chat thread/,
		);
	});
});
