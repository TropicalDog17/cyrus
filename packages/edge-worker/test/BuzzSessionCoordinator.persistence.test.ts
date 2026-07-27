import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuzzWebhookEvent } from "cyrus-buzz-event-transport";
import type {
	IIssueTrackerService,
	ILogger,
	PersistedBuzzThread,
	RepositoryConfig,
} from "cyrus-core";
import { PersistenceManager } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionManager } from "../src/AgentSessionManager.js";
import { BuzzApprovalRegistry } from "../src/buzz/BuzzApprovalRegistry.js";
import type {
	BuzzCliClient,
	BuzzEventRecord,
} from "../src/buzz/BuzzCliClient.js";
import { BuzzLinearProjection } from "../src/buzz/BuzzLinearProjection.js";
import { BuzzSessionCoordinator } from "../src/buzz/BuzzSessionCoordinator.js";
import type { SessionOrchestrator } from "../src/SessionOrchestrator.js";
import type { IActivitySink } from "../src/sinks/IActivitySink.js";

const CHANNEL_ID = "6f1a2b3c-0000-4000-8000-000000000001";
const ROOT_ID = `a1b2c3${"0".repeat(58)}`;
const REPLY_ID = "f".repeat(64);
const GATE_ID = "c".repeat(64);
const PLAN_ID = "d".repeat(64);
const AUTHOR = "9".repeat(64);
const SELF = "5".repeat(64);
const SESSION_ID = `buzz-${ROOT_ID}`;
const BRANCH = "BUZZ-a1b2c3-please-look-at-the-flaky-workt";
const OPENING = "Please look at the flaky worktree test";

/** Frozen so a serialized `lastUsedAt` can be asserted as a whole value. */
const NOW = 1_753_500_123_456;

const REPOSITORY = {
	id: "repo-1",
	name: "cyrus",
	repositoryPath: "/repos/cyrus",
	baseBranch: "main",
	workspaceBaseDir: "/worktrees",
	teamKeys: ["DEV"],
	projectKeys: ["Cyrus Agent"],
} as RepositoryConfig;

/** The scope block every Buzz turn is prefixed with, spelled out in full. */
const CYRUS_SCOPE = [
	"<session_scope>",
	"This thread works on the `cyrus` repository, checked out in the worktree you are running in. Nothing outside it is in scope.",
	"",
	'Linear scope for this repository: team DEV; project "Cyrus Agent". Constrain every Linear lookup to it — do not search the workspace at large.',
	"An issue outside that scope belongs to a different repository. Do not read it, plan it, or act on it here: say which scope it falls in and stop.",
	"</session_scope>",
].join("\n");

const GATE_MESSAGE = [
	`▶️ implement this — I'll write code on \`${BRANCH}\``,
	"📝 just track it — no code changes",
	"",
	"_React to choose. I'll stay read-only until you do._",
].join("\n");

const LOST_QUESTION =
	"⚠️ I restarted while waiting on your answer, so the question above is lost. Say what you'd like again and I'll pick it up from there.";

const GATE_OPTIONS = [
	{ emoji: "▶️", value: "implement", label: "implement" },
	{ emoji: "📝", value: "track", label: "track" },
];

const PROGRAM = {
	issueId: "issue-77",
	identifier: "DEV-77",
	url: "https://linear.app/cyrus/issue/DEV-77",
};

/**
 * A thread as persisted, with every optional field populated: a plan, its work
 * units and the gate it is parked on. Work units have no producer until the
 * planning stage lands, and that is exactly why they are asserted here — a
 * hydrate/serialize cycle that dropped them would erase an approved plan.
 */
function persistedThread(
	overrides: Partial<PersistedBuzzThread> = {},
): PersistedBuzzThread {
	return {
		channelId: CHANNEL_ID,
		threadRootId: ROOT_ID,
		sessionKey: "BUZZ-a1b2c3",
		title: OPENING,
		repositoryId: "repo-1",
		branchName: BRANCH,
		workspace: { path: "/worktrees/BUZZ-a1b2c3", isGitWorktree: true },
		phase: "execute",
		openingMessage: OPENING,
		lastResponse: "Rewrote the teardown to await cleanup.",
		agentSessionId: "claude-session-1",
		lastUsedAt: 1_753_400_000_000,
		program: PROGRAM,
		workUnits: [
			{
				unitId: "unit-1",
				unitKey: "BUZZ-a1b2c3-1",
				title: "Await cleanup in the teardown",
				branchName: "BUZZ-a1b2c3-1-await-cleanup",
				workspace: { path: "/worktrees/BUZZ-a1b2c3-1", isGitWorktree: true },
				agentSessionId: "claude-unit-1",
				issueId: "issue-78",
				identifier: "DEV-78",
				url: "https://linear.app/cyrus/issue/DEV-78",
				blockedBy: [],
				state: "finished",
				pr: { number: 61, url: "https://github.com/cyrus/cyrus/pull/61" },
			},
			{
				unitId: "unit-2",
				unitKey: "BUZZ-a1b2c3-2",
				title: "Drop the sleep from the polling test",
				branchName: "BUZZ-a1b2c3-2-drop-the-sleep",
				workspace: { path: "/worktrees/BUZZ-a1b2c3-2", isGitWorktree: true },
				blockedBy: ["unit-1"],
				state: "planned",
			},
		],
		plan: {
			postedEventId: PLAN_ID,
			slices: [
				{
					unitId: "unit-1",
					title: "Await cleanup in the teardown",
					rationale: "The leak is what makes the next test flaky.",
					blockedBy: [],
				},
				{
					unitId: "unit-2",
					title: "Drop the sleep from the polling test",
					rationale: "Only reviewable once the teardown is deterministic.",
					blockedBy: ["unit-1"],
				},
			],
		},
		openPrompt: {
			eventId: GATE_ID,
			channelId: CHANNEL_ID,
			kind: "gate",
			options: GATE_OPTIONS,
		},
		...overrides,
	};
}

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

function reaction(emoji: string): BuzzWebhookEvent {
	return event({
		eventType: "reaction_added",
		messageId: GATE_ID,
		emoji,
		deliveryId: `reaction_added:${GATE_ID}:${emoji}:${AUTHOR}`,
	});
}

function record(overrides: Partial<BuzzEventRecord> = {}): BuzzEventRecord {
	return {
		id: ROOT_ID,
		pubkey: AUTHOR,
		kind: 9,
		content: OPENING,
		created_at: 1753500000,
		tags: [],
		...overrides,
	};
}

/** Let the un-awaited gate handling chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("BuzzSessionCoordinator persistence", () => {
	let getEvent: ReturnType<typeof vi.fn>;
	let sendMessage: ReturnType<typeof vi.fn>;
	let startBuzzSession: ReturnType<typeof vi.fn>;
	let createIssue: ReturnType<typeof vi.fn>;
	let approvals: BuzzApprovalRegistry;
	let projection: BuzzLinearProjection;
	let logger: ILogger;
	let coordinator: BuzzSessionCoordinator;
	let repositories: Record<string, RepositoryConfig | undefined>;
	let activitySink: IActivitySink;
	let saveState: ReturnType<typeof vi.fn>;
	/** What a save would have written, captured at the moment it was asked for. */
	let saved: ReturnType<BuzzSessionCoordinator["serialize"]>[];

	beforeEach(() => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);

		getEvent = vi.fn().mockResolvedValue(record());
		sendMessage = vi.fn().mockResolvedValue(GATE_ID);
		startBuzzSession = vi.fn().mockResolvedValue("claude-session-1");
		createIssue = vi.fn().mockResolvedValue({
			id: PROGRAM.issueId,
			identifier: PROGRAM.identifier,
			url: PROGRAM.url,
		});
		logger = createLogger();
		approvals = new BuzzApprovalRegistry(logger);
		repositories = { "repo-1": REPOSITORY };
		activitySink = {} as IActivitySink;
		saved = [];
		saveState = vi.fn(async () => {
			saved.push(coordinator.serialize());
		});

		// The real projection, not a stub: the duplicate-program defect lives in
		// its in-memory map, so only the real one can show that hydration fixes it.
		projection = new BuzzLinearProjection({
			logger,
			getIssueTracker: () =>
				({
					createIssue,
					createComment: vi.fn().mockResolvedValue(undefined),
					fetchIssue: vi
						.fn()
						.mockResolvedValue({ team: Promise.resolve({ id: "team-1" }) }),
					fetchWorkflowStates: vi.fn().mockResolvedValue({
						nodes: [
							{ id: "state-1", name: "In Progress" },
							{ id: "state-2", name: "In Review" },
						],
					}),
					updateIssue: vi.fn().mockResolvedValue(undefined),
				}) as unknown as IIssueTrackerService,
		});

		coordinator = new BuzzSessionCoordinator({
			logger,
			client: {
				getEvent,
				sendMessage,
				addReaction: vi.fn().mockResolvedValue(undefined),
			} as unknown as BuzzCliClient,
			agentSessionManager: {
				getSession: vi.fn(),
			} as unknown as AgentSessionManager,
			sessionOrchestrator: {
				startBuzzSession,
				createBuzzWorkspace: vi.fn().mockResolvedValue({
					path: "/worktrees/BUZZ-a1b2c3",
					isGitWorktree: true,
				}),
			} as unknown as SessionOrchestrator,
			approvals,
			getChannelRoutes: () => [
				{ channelId: CHANNEL_ID, repositoryId: "repo-1" },
			],
			getSelfPubkey: () => SELF,
			getRepositoryById: (id) => repositories[id],
			saveState,
			getActivitySinkForChannel: () => activitySink,
			projection,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const hydrate = (overrides: Partial<PersistedBuzzThread> = {}) =>
		coordinator.hydrate({
			threads: { [SESSION_ID]: persistedThread(overrides) },
			repoMru: ["repo-1"],
		});

	/** A follow-up message in the hydrated thread. */
	const followUp = async () => {
		getEvent.mockResolvedValue(
			record({
				id: REPLY_ID,
				content: "also check the teardown path",
				tags: [["e", ROOT_ID, "", "root"]],
			}),
		);
		await coordinator.handleEvent(
			event({ messageId: REPLY_ID, deliveryId: `message_posted:${REPLY_ID}:` }),
		);
	};

	// The whole record, through the real state file. A field that cannot survive
	// JSON, or that hydrate quietly drops, fails here rather than in production
	// after a deploy.
	it("round-trips a thread, its program, its plan, its work units and its open gate", async () => {
		await hydrate();

		const persistence = new PersistenceManager(
			mkdtempSync(join(tmpdir(), "cyrus-buzz-persistence-")),
			logger,
		);
		await persistence.saveEdgeWorkerState({ buzz: coordinator.serialize() });
		const loaded = await persistence.loadEdgeWorkerState();

		expect(loaded?.buzz).toEqual({
			threads: { [SESSION_ID]: persistedThread() },
			repoMru: ["repo-1"],
		});
	});

	it("serializes the thread it just ran, gate answered and program projected", async () => {
		await coordinator.handleEvent(event());
		await coordinator.handleEvent(reaction("▶️"));
		await settle();

		expect(coordinator.serialize()).toEqual({
			threads: {
				[SESSION_ID]: {
					channelId: CHANNEL_ID,
					threadRootId: ROOT_ID,
					sessionKey: "BUZZ-a1b2c3",
					title: OPENING,
					repositoryId: "repo-1",
					branchName: BRANCH,
					workspace: { path: "/worktrees/BUZZ-a1b2c3", isGitWorktree: true },
					phase: "execute",
					openingMessage: OPENING,
					agentSessionId: "claude-session-1",
					lastUsedAt: NOW,
					program: PROGRAM,
					workUnits: [],
				},
			},
			repoMru: ["repo-1"],
		});
	});

	// The event id is the one humans have already reacted to, so it is the only
	// thing a re-arm can be built from.
	it("serializes the gate a triage thread is waiting on", async () => {
		await coordinator.handleEvent(event());

		expect(coordinator.serialize()).toEqual({
			threads: {
				[SESSION_ID]: {
					channelId: CHANNEL_ID,
					threadRootId: ROOT_ID,
					sessionKey: "BUZZ-a1b2c3",
					title: OPENING,
					repositoryId: "repo-1",
					branchName: BRANCH,
					workspace: { path: "/worktrees/BUZZ-a1b2c3", isGitWorktree: true },
					phase: "triage",
					openingMessage: OPENING,
					agentSessionId: "claude-session-1",
					lastUsedAt: NOW,
					workUnits: [],
					openPrompt: {
						eventId: GATE_ID,
						channelId: CHANNEL_ID,
						kind: "gate",
						options: GATE_OPTIONS,
					},
				},
			},
			repoMru: ["repo-1"],
		});
	});

	// The turn that offered the gate saved at both ends before the gate existed,
	// and the next turn only happens once the gate resolves. Nothing else would
	// write it, so a boot would find no prompt to re-arm.
	it("saves the gate at the moment the thread parks on it", async () => {
		await coordinator.handleEvent(event());

		expect(saved.map((state) => state.threads[SESSION_ID]?.openPrompt)).toEqual(
			[
				{
					eventId: GATE_ID,
					channelId: CHANNEL_ID,
					kind: "gate",
					options: GATE_OPTIONS,
				},
			],
		);
	});

	it("keeps an approved thread in the execute phase", async () => {
		await hydrate();

		expect(coordinator.serialize().threads[SESSION_ID]?.phase).toBe("execute");
	});

	// D3. Written against a phase the union does not admit on purpose: the rule
	// has to be right before the phase exists, not adapted once it does.
	it("reverts a phase it cannot run back to triage, and re-offers the gate", async () => {
		await hydrate({
			phase: "planning",
			openPrompt: {
				eventId: PLAN_ID,
				channelId: CHANNEL_ID,
				kind: "question",
				options: [{ emoji: "1⃣", value: "approve", label: "approve" }],
			},
		});

		expect(coordinator.serialize().threads[SESSION_ID]?.phase).toBe("triage");

		await followUp();

		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "triage" }),
		);
		// The lost plan question, then the gate the thread needs to get out of
		// triage again. Without the revert there is neither, and the thread is dead.
		expect(
			sendMessage.mock.calls.map(
				(call) => (call[0] as { content: string }).content,
			),
		).toEqual([LOST_QUESTION, GATE_MESSAGE]);
	});

	// The duplicate-program defect: track() dedupes from an in-memory map that a
	// restart empties.
	it("does not project a second program issue for a hydrated thread", async () => {
		await hydrate({ phase: "triage" });

		await coordinator.handleEvent(reaction("📝"));
		await settle();

		expect(createIssue).not.toHaveBeenCalled();
		expect(sendMessage).toHaveBeenLastCalledWith({
			channelId: CHANNEL_ID,
			content: "📝 Tracked as **DEV-77**. I won't make any changes.",
			replyTo: ROOT_ID,
		});
	});

	it("re-arms the recorded gate and routes its answer into the decision", async () => {
		const register = vi.spyOn(approvals, "register");

		await hydrate({ phase: "triage" });

		expect(register.mock.calls).toEqual([
			[
				{
					eventId: GATE_ID,
					channelId: CHANNEL_ID,
					sessionId: SESSION_ID,
					kind: "gate",
					options: GATE_OPTIONS,
				},
			],
		]);
		// register() alone arms nothing — the resolution has to reach the decision.
		expect(sendMessage).not.toHaveBeenCalled();

		await coordinator.handleEvent(reaction("▶️"));
		await settle();

		expect(startBuzzSession).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "execute" }),
		);
	});

	// A re-armed gate is live again with an empty delivery cache, so the ▶️ that
	// promoted the thread before the restart arrives a second time. It must not
	// start a second implementation turn against the same branch.
	it("ignores a re-delivered gate reaction on a thread already executing", async () => {
		await hydrate();

		await coordinator.handleEvent(reaction("▶️"));
		await settle();

		expect(startBuzzSession).not.toHaveBeenCalled();
		expect(createIssue).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
	});

	// The assertion that makes a missing field impossible to ship: a hydrated
	// turn runs on the persisted branch, in the persisted worktree, or not at all.
	it("runs a hydrated thread's next turn on the persisted branch and worktree", async () => {
		await hydrate({ openPrompt: undefined });

		await followUp();

		expect(startBuzzSession).toHaveBeenCalledWith({
			repository: REPOSITORY,
			workspace: { path: "/worktrees/BUZZ-a1b2c3", isGitWorktree: true },
			sessionId: SESSION_ID,
			sessionKey: "BUZZ-a1b2c3",
			threadRootId: ROOT_ID,
			branchName: BRANCH,
			title: OPENING,
			taskInstructions: `${CYRUS_SCOPE}\n\nalso check the teardown path`,
			activitySink,
			phase: "execute",
			resumeSessionId: "claude-session-1",
		});
	});

	// An AskUserQuestion needs a live SDK session and a blocked caller; neither
	// survives. Silence there is indistinguishable from Cyrus ignoring an answer.
	it("announces a lost question instead of re-arming it", async () => {
		const register = vi.spyOn(approvals, "register");

		await hydrate({
			openPrompt: {
				eventId: PLAN_ID,
				channelId: CHANNEL_ID,
				kind: "question",
				options: [{ emoji: "1⃣", value: "approve", label: "approve" }],
			},
		});

		expect(sendMessage.mock.calls).toEqual([
			[{ channelId: CHANNEL_ID, content: LOST_QUESTION, replyTo: ROOT_ID }],
		]);
		expect(register).not.toHaveBeenCalled();
		expect(approvals.pendingEventIds()).toEqual([]);
		// Not re-armed means not in the registry, which is what clears it from the
		// next save.
		expect(
			coordinator.serialize().threads[SESSION_ID]?.openPrompt,
		).toBeUndefined();
	});

	// Its worktree is unreachable, so there is no turn left to run in it.
	it("drops a thread whose repository has left the configuration", async () => {
		await hydrate({ repositoryId: "repo-gone" });

		expect(coordinator.serialize()).toEqual({ threads: {}, repoMru: [] });
		expect(logger.warn).toHaveBeenCalledWith(
			'Dropping Buzz thread BUZZ-a1b2c3: repository "repo-gone" is no longer configured',
		);
	});
});
