import type { BuzzWebhookEvent } from "cyrus-buzz-event-transport";
import type { ILogger, RepositoryConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionManager } from "../src/AgentSessionManager.js";
import { BuzzApprovalRegistry } from "../src/buzz/BuzzApprovalRegistry.js";
import type {
	BuzzCliClient,
	BuzzEventRecord,
} from "../src/buzz/BuzzCliClient.js";
import {
	BuzzSessionCoordinator,
	threadRootOf,
} from "../src/buzz/BuzzSessionCoordinator.js";
import type { SessionOrchestrator } from "../src/SessionOrchestrator.js";
import type { IActivitySink } from "../src/sinks/IActivitySink.js";

const CHANNEL_ID = "6f1a2b3c-0000-4000-8000-000000000001";
const ROOT_ID = `a1b2c3${"0".repeat(58)}`;
const REPLY_ID = "f".repeat(64);
const GATE_ID = "c".repeat(64);
const AUTHOR = "9".repeat(64);

const REPOSITORY = {
	id: "repo-1",
	name: "cyrus",
	repositoryPath: "/repos/cyrus",
	baseBranch: "main",
	workspaceBaseDir: "/worktrees",
} as RepositoryConfig;

function createLogger(): ILogger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		withContext: vi.fn().mockReturnThis(),
	} as unknown as ILogger;
}

function event(overrides: Partial<BuzzWebhookEvent> = {}): BuzzWebhookEvent {
	return {
		eventType: "message_posted",
		messageId: ROOT_ID,
		channelId: CHANNEL_ID,
		authorPubkey: AUTHOR,
		timestamp: "1753500000",
		deliveryId: `message_posted:${ROOT_ID}:`,
		...overrides,
	};
}

function record(overrides: Partial<BuzzEventRecord> = {}): BuzzEventRecord {
	return {
		id: ROOT_ID,
		pubkey: AUTHOR,
		kind: 9,
		content: "Please look at the flaky worktree test",
		created_at: 1753500000,
		tags: [],
		...overrides,
	};
}

/** Let the un-awaited gate handling chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("threadRootOf", () => {
	it("returns the event id when there are no thread tags", () => {
		expect(threadRootOf(record())).toBe(ROOT_ID);
	});

	it("prefers an explicit NIP-10 root marker", () => {
		const nested = record({
			id: REPLY_ID,
			tags: [
				["e", ROOT_ID, "", "root"],
				["e", "b".repeat(64), "", "reply"],
			],
		});
		expect(threadRootOf(nested)).toBe(ROOT_ID);
	});

	// A direct reply's parent IS the thread root — buzz-cli relies on the same
	// fallback, so the two must agree or replies land in a different thread.
	it("falls back to a reply marker when no root marker exists", () => {
		const direct = record({
			id: REPLY_ID,
			tags: [["e", ROOT_ID, "", "reply"]],
		});
		expect(threadRootOf(direct)).toBe(ROOT_ID);
	});

	it("ignores malformed event ids in tags", () => {
		const malformed = record({
			id: REPLY_ID,
			tags: [["e", "not-a-hex-id", "", "root"]],
		});
		expect(threadRootOf(malformed)).toBe(REPLY_ID);
	});
});

describe("BuzzSessionCoordinator", () => {
	let getEvent: ReturnType<typeof vi.fn>;
	let sendMessage: ReturnType<typeof vi.fn>;
	let addReaction: ReturnType<typeof vi.fn>;
	let getSession: ReturnType<typeof vi.fn>;
	let startBuzzSession: ReturnType<typeof vi.fn>;
	let createBuzzWorkspace: ReturnType<typeof vi.fn>;
	let onTrackRequested: ReturnType<typeof vi.fn>;
	let approvals: BuzzApprovalRegistry;
	let logger: ILogger;
	let coordinator: BuzzSessionCoordinator;
	let routes: { channelId: string; repositoryId: string }[];

	beforeEach(() => {
		getEvent = vi.fn().mockResolvedValue(record());
		sendMessage = vi.fn().mockResolvedValue(GATE_ID);
		addReaction = vi.fn().mockResolvedValue(undefined);
		getSession = vi.fn().mockReturnValue(undefined);
		startBuzzSession = vi.fn().mockResolvedValue("claude-session-1");
		createBuzzWorkspace = vi.fn().mockResolvedValue({
			path: "/worktrees/BUZZ-a1b2c3",
			isGitWorktree: true,
		});
		onTrackRequested = vi.fn().mockResolvedValue(undefined);
		logger = createLogger();
		approvals = new BuzzApprovalRegistry(logger);
		routes = [{ channelId: CHANNEL_ID, repositoryId: "repo-1" }];

		coordinator = new BuzzSessionCoordinator({
			logger,
			client: {
				getEvent,
				sendMessage,
				addReaction,
			} as unknown as BuzzCliClient,
			agentSessionManager: {
				getSession,
			} as unknown as AgentSessionManager,
			sessionOrchestrator: {
				startBuzzSession,
				createBuzzWorkspace,
			} as unknown as SessionOrchestrator,
			approvals,
			getChannelRoutes: () => routes,
			getRepositoryById: (id) => (id === "repo-1" ? REPOSITORY : undefined),
			getActivitySinkForChannel: () => ({}) as IActivitySink,
			onTrackRequested,
		});
	});

	it("starts a session keyed on the thread root", async () => {
		await coordinator.handleEvent(event());

		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({
				repository: REPOSITORY,
				sessionId: `buzz-${ROOT_ID}`,
				sessionKey: "BUZZ-a1b2c3",
				threadRootId: ROOT_ID,
				taskInstructions: "Please look at the flaky worktree test",
			}),
		);
	});

	// The whole point of the gate: a fresh thread cannot write code, no matter
	// what it is asked to do.
	it("starts a new thread in the read-only triage phase", async () => {
		await coordinator.handleEvent(event());

		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "triage" }),
		);
	});

	it("derives a branch name from the message", async () => {
		await coordinator.handleEvent(event());

		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({
				branchName: "BUZZ-a1b2c3-please-look-at-the-flaky-workt",
			}),
		);
	});

	it("offers the execution gate after a triage turn", async () => {
		await coordinator.handleEvent(event());

		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				channelId: CHANNEL_ID,
				replyTo: ROOT_ID,
				content: expect.stringContaining("▶️"),
			}),
		);
		// Seeded so answering is one tap rather than an emoji search.
		expect(addReaction).toHaveBeenCalledWith({
			eventId: GATE_ID,
			emoji: "▶️",
		});
		expect(addReaction).toHaveBeenCalledWith({
			eventId: GATE_ID,
			emoji: "📝",
		});
	});

	it("promotes the thread to the execute phase when a human reacts ▶️", async () => {
		await coordinator.handleEvent(event());
		startBuzzSession.mockClear();

		await coordinator.handleEvent(
			event({
				eventType: "reaction_added",
				messageId: GATE_ID,
				emoji: "▶️",
				deliveryId: `reaction_added:${GATE_ID}:▶️:${AUTHOR}`,
			}),
		);
		await settle();

		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "execute",
				// The triage conversation carries over so the human need not repeat it.
				resumeSessionId: "claude-session-1",
			}),
		);
	});

	it("tracks without implementing when a human reacts 📝", async () => {
		await coordinator.handleEvent(event());
		startBuzzSession.mockClear();

		await coordinator.handleEvent(
			event({
				eventType: "reaction_added",
				messageId: GATE_ID,
				emoji: "📝",
				deliveryId: `reaction_added:${GATE_ID}:📝:${AUTHOR}`,
			}),
		);
		await settle();

		expect(startBuzzSession).not.toHaveBeenCalled();
		expect(onTrackRequested).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionKey: "BUZZ-a1b2c3",
				threadRootId: ROOT_ID,
				summary: "Please look at the flaky worktree test",
			}),
		);
	});

	// An emoji on an unrelated message is ordinary chat. If this leaked through,
	// a thumbs-up on a colleague's message would spend tokens.
	it("ignores a reaction that matches no open prompt", async () => {
		await coordinator.handleEvent(
			event({
				eventType: "reaction_added",
				messageId: "e".repeat(64),
				emoji: "▶️",
				deliveryId: "reaction_added:other:▶️",
			}),
		);
		await settle();

		expect(getEvent).not.toHaveBeenCalled();
		expect(startBuzzSession).not.toHaveBeenCalled();
	});

	// Prose must not open a gate: the decision to write code has to be deliberate.
	it("does not open the gate from an unrelated reply", async () => {
		await coordinator.handleEvent(event());
		startBuzzSession.mockClear();

		getEvent.mockResolvedValue(
			record({
				id: REPLY_ID,
				content: "sounds good, maybe later",
				tags: [["e", ROOT_ID, "", "root"]],
			}),
		);
		await coordinator.handleEvent(
			event({ messageId: REPLY_ID, deliveryId: "message_posted:reply:" }),
		);
		await settle();

		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "triage" }),
		);
	});

	// A follow-up message in the same thread must continue the conversation,
	// not fork a second worktree against the same branch.
	it("continues the existing session for a reply in the same thread", async () => {
		await coordinator.handleEvent(event());
		createBuzzWorkspace.mockClear();
		startBuzzSession.mockClear();

		getEvent.mockResolvedValue(
			record({
				id: REPLY_ID,
				content: "also check the teardown path",
				tags: [["e", ROOT_ID, "", "root"]],
			}),
		);

		await coordinator.handleEvent(
			event({ messageId: REPLY_ID, deliveryId: "message_posted:reply:" }),
		);

		expect(createBuzzWorkspace).not.toHaveBeenCalled();
		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: `buzz-${ROOT_ID}`,
				taskInstructions: "also check the teardown path",
				resumeSessionId: "claude-session-1",
			}),
		);
	});

	// buzz-workflow retries a call_webhook step that does not answer within 10s,
	// and the polling ingress re-reads an inclusive `--since` window.
	it("ignores a repeated delivery", async () => {
		await coordinator.handleEvent(event());
		await coordinator.handleEvent(event());

		expect(startBuzzSession).toHaveBeenCalledTimes(1);
	});

	it("ignores channels with no repository route", async () => {
		routes = [];

		await coordinator.handleEvent(event());

		expect(startBuzzSession).not.toHaveBeenCalled();
		expect(getEvent).not.toHaveBeenCalled();
	});

	it("ignores a route pointing at an unknown repository", async () => {
		routes = [{ channelId: CHANNEL_ID, repositoryId: "does-not-exist" }];

		await coordinator.handleEvent(event());

		expect(startBuzzSession).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalled();
	});

	it("ignores an empty message", async () => {
		getEvent.mockResolvedValue(record({ content: "   " }));

		await coordinator.handleEvent(event());

		expect(startBuzzSession).not.toHaveBeenCalled();
	});

	it("does not start a session when the relay lookup fails", async () => {
		getEvent.mockRejectedValue(new Error("relay down"));

		await coordinator.handleEvent(event());

		expect(startBuzzSession).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalled();
	});

	it("does not start a session when the worktree cannot be created", async () => {
		createBuzzWorkspace.mockResolvedValue(null);

		await coordinator.handleEvent(event());

		expect(startBuzzSession).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalled();
	});

	it("exposes the thread bound to a session, for the question handler", async () => {
		await coordinator.handleEvent(event());

		expect(coordinator.getThread(`buzz-${ROOT_ID}`)).toEqual({
			channelId: CHANNEL_ID,
			threadRootId: ROOT_ID,
		});
		expect(coordinator.getThread("buzz-unknown")).toBeNull();
	});
});
