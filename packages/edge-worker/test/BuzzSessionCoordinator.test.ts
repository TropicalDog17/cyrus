import type { BuzzWebhookEvent } from "cyrus-buzz-event-transport";
import type { ILogger, RepositoryConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionManager } from "../src/AgentSessionManager.js";
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
	let getSession: ReturnType<typeof vi.fn>;
	let startBuzzSession: ReturnType<typeof vi.fn>;
	let createBuzzWorkspace: ReturnType<typeof vi.fn>;
	let resumeSession: ReturnType<typeof vi.fn>;
	let logger: ILogger;
	let coordinator: BuzzSessionCoordinator;
	let routes: { channelId: string; repositoryId: string }[];

	beforeEach(() => {
		getEvent = vi.fn().mockResolvedValue(record());
		getSession = vi.fn().mockReturnValue(undefined);
		startBuzzSession = vi.fn().mockResolvedValue(undefined);
		createBuzzWorkspace = vi.fn().mockResolvedValue({
			path: "/worktrees/BUZZ-a1b2c3",
			isGitWorktree: true,
		});
		resumeSession = vi.fn().mockResolvedValue(undefined);
		logger = createLogger();
		routes = [{ channelId: CHANNEL_ID, repositoryId: "repo-1" }];

		coordinator = new BuzzSessionCoordinator({
			logger,
			client: { getEvent } as unknown as BuzzCliClient,
			agentSessionManager: {
				getSession,
			} as unknown as AgentSessionManager,
			sessionOrchestrator: {
				startBuzzSession,
				createBuzzWorkspace,
				resumeSession,
			} as unknown as SessionOrchestrator,
			getChannelRoutes: () => routes,
			getRepositoryById: (id) => (id === "repo-1" ? REPOSITORY : undefined),
			getActivitySinkForChannel: () => ({}) as IActivitySink,
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

	it("derives a branch name from the message", async () => {
		await coordinator.handleEvent(event());

		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({
				branchName: "BUZZ-a1b2c3-please-look-at-the-flaky-workt",
			}),
		);
	});

	// A follow-up message in the same thread must continue the conversation,
	// not fork a second worktree against the same branch.
	it("resumes the existing session for a reply in the same thread", async () => {
		getEvent.mockResolvedValue(
			record({
				id: REPLY_ID,
				content: "also check the teardown path",
				tags: [["e", ROOT_ID, "", "root"]],
			}),
		);
		getSession.mockReturnValue({ id: `buzz-${ROOT_ID}` });

		await coordinator.handleEvent(
			event({ messageId: REPLY_ID, deliveryId: "message_posted:reply:" }),
		);

		expect(startBuzzSession).not.toHaveBeenCalled();
		expect(resumeSession).toHaveBeenCalledWith(
			expect.objectContaining({ id: `buzz-${ROOT_ID}` }),
			REPOSITORY,
			`buzz-${ROOT_ID}`,
			expect.anything(),
			"also check the teardown path",
			"",
			false,
			[],
			undefined,
			undefined,
			AUTHOR,
			"1753500000",
		);
	});

	// buzz-workflow retries a call_webhook step that does not answer within 10s.
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

	// The 📝/▶️ execution gate arrives with the approval protocol; until then a
	// reaction must not be able to start a coding session.
	it("does not act on reactions yet", async () => {
		await coordinator.handleEvent(
			event({
				eventType: "reaction_added",
				emoji: "▶️",
				deliveryId: "reaction_added:x:▶️",
			}),
		);

		expect(getEvent).not.toHaveBeenCalled();
		expect(startBuzzSession).not.toHaveBeenCalled();
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
});
