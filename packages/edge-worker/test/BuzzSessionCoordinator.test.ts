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
const SELF = "5".repeat(64);
const OTHER_CHANNEL = "11111111-0000-4000-8000-000000000009";

/** What a Buzz client writes when a human picks Cyrus from @mention. */
const MENTIONS_CYRUS = [["p", SELF]];

const REPOSITORY = {
	id: "repo-1",
	name: "cyrus",
	repositoryPath: "/repos/cyrus",
	baseBranch: "main",
	workspaceBaseDir: "/worktrees",
	teamKeys: ["DEV"],
	projectKeys: ["Cyrus Agent"],
} as RepositoryConfig;

const OTHER_REPOSITORY = {
	id: "repo-2",
	name: "honey-automation",
	repositoryPath: "/repos/honey",
	baseBranch: "master",
	workspaceBaseDir: "/worktrees",
	projectKeys: ["Honey Automation"],
} as RepositoryConfig;

/**
 * The scope block prepended to every turn, spelled out in full. A Buzz channel
 * routes to one repository but the session still gets the whole Linear MCP
 * catalog, so this text is the only thing standing between "check the current
 * issue" and an issue belonging to a different repository's project.
 */
const CYRUS_SCOPE = [
	"<session_scope>",
	"This thread works on the `cyrus` repository, checked out in the worktree you are running in. Nothing outside it is in scope.",
	"",
	'Linear scope for this repository: team DEV; project "Cyrus Agent". Constrain every Linear lookup to it — do not search the workspace at large.',
	"An issue outside that scope belongs to a different repository. Do not read it, plan it, or act on it here: say which scope it falls in and stop.",
	"</session_scope>",
].join("\n");

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
	let track: ReturnType<typeof vi.fn>;
	let note: ReturnType<typeof vi.fn>;
	let setState: ReturnType<typeof vi.fn>;
	let getProjected: ReturnType<typeof vi.fn>;
	let restoreProjection: ReturnType<typeof vi.fn>;
	let approvals: BuzzApprovalRegistry;
	let logger: ILogger;
	let coordinator: BuzzSessionCoordinator;
	let routes: { channelId: string; repositoryId: string }[];
	let repositories: Record<string, RepositoryConfig | undefined>;
	let selfPubkey: string | undefined;

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
		track = vi.fn().mockResolvedValue("DEV-42");
		note = vi.fn().mockResolvedValue(undefined);
		setState = vi.fn().mockResolvedValue(undefined);
		getProjected = vi.fn().mockReturnValue({
			issueId: "issue-42",
			identifier: "DEV-42",
			url: "https://linear.app/team/issue/DEV-42",
		});
		restoreProjection = vi.fn();
		logger = createLogger();
		approvals = new BuzzApprovalRegistry(logger);
		routes = [{ channelId: CHANNEL_ID, repositoryId: "repo-1" }];
		repositories = { "repo-1": REPOSITORY, "repo-2": OTHER_REPOSITORY };
		selfPubkey = SELF;

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
			getSelfPubkey: () => selfPubkey,
			getRepositoryById: (id) => repositories[id],
			saveState: vi.fn().mockResolvedValue(undefined),
			getActivitySinkForChannel: () => ({}) as IActivitySink,
			projection: {
				track,
				note,
				setState,
				get: getProjected,
				restore: restoreProjection,
			},
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
				taskInstructions: `${CYRUS_SCOPE}\n\nPlease look at the flaky worktree test`,
			}),
		);
	});

	// A channel route binds a thread to one repository, but the session still
	// holds the full Linear catalog. Without the scope stated in the prompt, a
	// thread on `cyrus` will happily pick up an issue whose files live in
	// `honey-automation` and then report that it cannot find them.
	it("names the repository's Linear scope ahead of the message", async () => {
		await coordinator.handleEvent(event());

		const { taskInstructions } = startBuzzSession.mock.calls[0]?.[0] as {
			taskInstructions: string;
		};
		expect(taskInstructions.startsWith(`${CYRUS_SCOPE}\n\n`)).toBe(true);
	});

	it("scopes to the repository the channel actually routed to", async () => {
		routes = [{ channelId: CHANNEL_ID, repositoryId: "repo-2" }];

		await coordinator.handleEvent(event());

		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({
				repository: OTHER_REPOSITORY,
				taskInstructions: [
					"<session_scope>",
					"This thread works on the `honey-automation` repository, checked out in the worktree you are running in. Nothing outside it is in scope.",
					"",
					'Linear scope for this repository: project "Honey Automation". Constrain every Linear lookup to it — do not search the workspace at large.',
					"An issue outside that scope belongs to a different repository. Do not read it, plan it, or act on it here: say which scope it falls in and stop.",
					"</session_scope>",
					"",
					"Please look at the flaky worktree test",
				].join("\n"),
			}),
		);
	});

	// Silence would read as "any issue is fair game", which is the failure this
	// block exists to prevent.
	it("says so when the repository declares no Linear scope", async () => {
		const unscoped = {
			id: "repo-3",
			name: "nami",
			repositoryPath: "/repos/nami",
			baseBranch: "main",
			workspaceBaseDir: "/worktrees",
		} as RepositoryConfig;
		repositories["repo-3"] = unscoped;
		routes = [{ channelId: CHANNEL_ID, repositoryId: "repo-3" }];

		await coordinator.handleEvent(event());

		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({
				taskInstructions: [
					"<session_scope>",
					"This thread works on the `nami` repository, checked out in the worktree you are running in. Nothing outside it is in scope.",
					"",
					"This repository declares no Linear team or project, so no Linear issue is in scope for it. Work from what the thread tells you.",
					"</session_scope>",
					"",
					"Please look at the flaky worktree test",
				].join("\n"),
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
		expect(track).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionKey: "BUZZ-a1b2c3",
				threadRootId: ROOT_ID,
				summary: "Please look at the flaky worktree test",
			}),
		);
		// The human is told where it landed, or the record is invisible to them.
		expect(sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("DEV-42"),
			}),
		);
		expect(setState).not.toHaveBeenCalled();
	});

	// The gate is the moment a conversation becomes work worth recording — that
	// is true whether or not anybody writes code for it.
	it("projects an issue and drives its status when implementing", async () => {
		await coordinator.handleEvent(event());

		await coordinator.handleEvent(
			event({
				eventType: "reaction_added",
				messageId: GATE_ID,
				emoji: "▶️",
				deliveryId: `reaction_added:${GATE_ID}:▶️:${AUTHOR}`,
			}),
		);
		await settle();

		expect(track).toHaveBeenCalledTimes(1);
		expect(setState.mock.calls.map((call) => call[1])).toEqual([
			"In Progress",
			"In Review",
		]);
	});

	// A repository with no `teamKeys` projects nothing, and the projection has
	// no way to say so. Silence there means a human watches a gate release and
	// assumes a program issue exists somewhere.
	it("says which repository cannot be projected when it has no teamKeys", async () => {
		repositories = {
			"repo-1": { ...REPOSITORY, teamKeys: [] } as RepositoryConfig,
		};
		track.mockResolvedValue(null);
		getProjected.mockReturnValue(undefined);

		await coordinator.handleEvent(event());
		sendMessage.mockClear();

		await coordinator.handleEvent(
			event({
				eventType: "reaction_added",
				messageId: GATE_ID,
				emoji: "▶️",
				deliveryId: `reaction_added:${GATE_ID}:▶️:${AUTHOR}`,
			}),
		);
		await settle();

		expect(sendMessage.mock.calls.map((call) => call[0].content)).toEqual([
			"⚠️ I can't record this in Linear: the `cyrus` repository has no `teamKeys` configured.",
		]);
		// The work still runs; only its shadow is missing.
		expect(startBuzzSession).toHaveBeenLastCalledWith(
			expect.objectContaining({ phase: "execute" }),
		);
		expect(setState).not.toHaveBeenCalled();
		expect(note).not.toHaveBeenCalled();
	});

	// A Linear outage also returns null. Telling somebody to fix their config
	// over a 503 sends them looking for a problem they do not have.
	it("stays quiet when the projection fails for any other reason", async () => {
		track.mockResolvedValue(null);
		getProjected.mockReturnValue(undefined);

		await coordinator.handleEvent(event());
		sendMessage.mockClear();

		await coordinator.handleEvent(
			event({
				eventType: "reaction_added",
				messageId: GATE_ID,
				emoji: "▶️",
				deliveryId: `reaction_added:${GATE_ID}:▶️:${AUTHOR}`,
			}),
		);
		await settle();

		expect(sendMessage.mock.calls.map((call) => call[0].content)).toEqual([]);
	});

	it("carries the thread's final response into the projected issue", async () => {
		await coordinator.handleEvent(event());
		coordinator.recordResponse(
			ROOT_ID,
			"Rewrote the teardown to await cleanup.",
		);

		await coordinator.handleEvent(
			event({
				eventType: "reaction_added",
				messageId: GATE_ID,
				emoji: "▶️",
				deliveryId: `reaction_added:${GATE_ID}:▶️:${AUTHOR}`,
			}),
		);
		await settle();

		expect(note).toHaveBeenCalledWith(
			`buzz-${ROOT_ID}`,
			expect.stringContaining("Rewrote the teardown to await cleanup."),
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
				// Restated on every turn, not just the first: a compacted or resumed
				// transcript must not be how the scope gets dropped.
				taskInstructions: `${CYRUS_SCOPE}\n\nalso check the teardown path`,
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

	// A triage channel is deliberately allowed to reach several repositories.
	// Guessing means reading the wrong codebase in a fresh worktree.
	it("asks which repository to use when a channel is ambiguous", async () => {
		routes = [
			{
				channelId: CHANNEL_ID,
				repositoryIds: ["repo-1", "repo-2"],
			} as (typeof routes)[number],
		];

		const handled = coordinator.handleEvent(event());
		await vi.waitFor(() =>
			expect(approvals.hasPendingPrompt(`buzz-${ROOT_ID}`)).toBe(true),
		);

		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("Which repository should I work in?"),
			}),
		);
		expect(startBuzzSession).not.toHaveBeenCalled();

		approvals.resolveByReaction(GATE_ID, "2⃣", AUTHOR);
		await handled;

		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({ repository: OTHER_REPOSITORY }),
		);
	});

	it("does not ask when a channel maps to exactly one repository", async () => {
		routes = [
			{
				channelId: CHANNEL_ID,
				repositoryIds: ["repo-1"],
			} as (typeof routes)[number],
		];

		await coordinator.handleEvent(event());

		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({ repository: REPOSITORY }),
		);
	});

	// DMs have channel ids that cannot be configured in advance.
	it("falls back to a catch-all route", async () => {
		routes = [{ channelId: "*", repositoryId: "repo-1" }];
		getEvent.mockResolvedValue(record({ tags: MENTIONS_CYRUS }));

		await coordinator.handleEvent(event({ channelId: OTHER_CHANNEL }));

		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({ repository: REPOSITORY }),
		);
	});

	describe("who Cyrus answers", () => {
		// A shared room Cyrus merely belongs to. Without this, one catch-all route
		// would turn every line of chatter in the workspace into a session.
		it("ignores an unaddressed message in a catch-all channel", async () => {
			routes = [{ channelId: "*", repositoryId: "repo-1" }];

			await coordinator.handleEvent(event({ channelId: OTHER_CHANNEL }));

			expect(startBuzzSession).not.toHaveBeenCalled();
			expect(getEvent).toHaveBeenCalled();
		});

		it("answers a catch-all channel when the message mentions Cyrus", async () => {
			routes = [{ channelId: "*", repositoryId: "repo-1" }];
			getEvent.mockResolvedValue(record({ tags: MENTIONS_CYRUS }));

			await coordinator.handleEvent(event({ channelId: OTHER_CHANNEL }));

			expect(startBuzzSession).toHaveBeenCalled();
		});

		// A `p` tag naming somebody else is the common case in a busy channel.
		it("does not treat a mention of someone else as its own", async () => {
			routes = [{ channelId: "*", repositoryId: "repo-1" }];
			getEvent.mockResolvedValue(record({ tags: [["p", AUTHOR]] }));

			await coordinator.handleEvent(event({ channelId: OTHER_CHANNEL }));

			expect(startBuzzSession).not.toHaveBeenCalled();
		});

		// The channel is Cyrus's own, so talking in it is addressing it — this is
		// how every Buzz channel behaved before catch-all routing existed.
		it("does not require a mention in an explicitly routed channel", async () => {
			await coordinator.handleEvent(event());

			expect(startBuzzSession).toHaveBeenCalled();
		});

		// Once a thread is Cyrus's, every reply in it belongs to that session —
		// re-tagging it on every message would make steering unusable.
		it("continues its own thread in a catch-all channel without a mention", async () => {
			routes = [{ channelId: "*", repositoryId: "repo-1" }];
			getEvent.mockResolvedValueOnce(record({ tags: MENTIONS_CYRUS }));
			await coordinator.handleEvent(event({ channelId: OTHER_CHANNEL }));

			getEvent.mockResolvedValue(
				record({
					id: REPLY_ID,
					content: "also check the second one",
					tags: [["e", ROOT_ID, "", "reply"]],
				}),
			);
			await coordinator.handleEvent(
				event({
					channelId: OTHER_CHANNEL,
					messageId: REPLY_ID,
					deliveryId: `message_posted:${REPLY_ID}:`,
				}),
			);

			expect(startBuzzSession).toHaveBeenCalledTimes(2);
		});

		// With no self pubkey there is no way to tell a mention from chatter, and
		// guessing wrong spends tokens on every message in the workspace.
		it("opens nothing in a catch-all channel when no self pubkey is set", async () => {
			routes = [{ channelId: "*", repositoryId: "repo-1" }];
			selfPubkey = undefined;
			getEvent.mockResolvedValue(record({ tags: MENTIONS_CYRUS }));

			await coordinator.handleEvent(event({ channelId: OTHER_CHANNEL }));

			expect(startBuzzSession).not.toHaveBeenCalled();
		});
	});

	// Otherwise adding a catch-all would silently widen every pinned channel.
	it("prefers an exact route over the catch-all", async () => {
		routes = [
			{ channelId: CHANNEL_ID, repositoryId: "repo-1" },
			{ channelId: "*", repositoryId: "repo-2" },
		];

		await coordinator.handleEvent(event());

		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({ repository: REPOSITORY }),
		);
	});

	it("keeps a thread on the repository it already chose", async () => {
		routes = [
			{
				channelId: CHANNEL_ID,
				repositoryIds: ["repo-1", "repo-2"],
			} as (typeof routes)[number],
		];

		const first = coordinator.handleEvent(event());
		await vi.waitFor(() =>
			expect(approvals.hasPendingPrompt(`buzz-${ROOT_ID}`)).toBe(true),
		);
		approvals.resolveByReaction(GATE_ID, "1⃣", AUTHOR);
		await first;
		sendMessage.mockClear();

		getEvent.mockResolvedValue(
			record({
				id: REPLY_ID,
				content: "and the teardown path",
				tags: [["e", ROOT_ID, "", "root"]],
			}),
		);
		await coordinator.handleEvent(
			event({ messageId: REPLY_ID, deliveryId: "message_posted:reply:" }),
		);

		expect(sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("Which repository"),
			}),
		);
		expect(startBuzzSession).toHaveBeenLastCalledWith(
			expect.objectContaining({ repository: REPOSITORY }),
		);
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
