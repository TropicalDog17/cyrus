import type { BuzzWebhookEvent } from "cyrus-buzz-event-transport";
import type {
	ILogger,
	PersistedBuzzThread,
	PersistedBuzzWorkUnit,
	RepositoryConfig,
} from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionManager } from "../src/AgentSessionManager.js";
import { BuzzApprovalRegistry } from "../src/buzz/BuzzApprovalRegistry.js";
import type {
	BuzzCliClient,
	BuzzEventRecord,
} from "../src/buzz/BuzzCliClient.js";
import type { BuzzProjectionHooks } from "../src/buzz/BuzzSessionCoordinator.js";
import { BuzzSessionCoordinator } from "../src/buzz/BuzzSessionCoordinator.js";
import type { SessionOrchestrator } from "../src/SessionOrchestrator.js";
import type { IActivitySink } from "../src/sinks/IActivitySink.js";

const CHANNEL_ID = "6f1a2b3c-0000-4000-8000-000000000001";
const ROOT_ID = `a1b2c3${"0".repeat(58)}`;
const REPLY_ID = "f".repeat(64);
const GATE_ID = "c".repeat(64);
const AUTHOR = "9".repeat(64);
const SELF = "5".repeat(64);
const SESSION_ID = `buzz-${ROOT_ID}`;
const OPENING = "Please look at the flaky worktree test";

/** The thread's own key, branch and worktree, as they are already on disk. */
const THREAD_KEY = "BUZZ-a1b2c3";
const THREAD_BRANCH = "BUZZ-a1b2c3-please-look-at-the-flaky-workt";
const THREAD_WORKSPACE = {
	path: "/worktrees/BUZZ-a1b2c3",
	isGitWorktree: true,
};

/** The single issue 0013 projected per thread, which is now the program. */
const PROGRAM = {
	issueId: "issue-77",
	identifier: "DEV-77",
	url: "https://linear.app/cyrus/issue/DEV-77",
};

const GATE_OPTIONS = [
	{ emoji: "▶️", value: "implement", label: "implement" },
	{ emoji: "📝", value: "track", label: "track" },
];

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

/**
 * A thread exactly as the pre-two-tier build persisted it: a program issue, a
 * branch, a worktree, and no work units at all. Nothing migrates this record, so
 * everything below is measured against it verbatim.
 */
function legacyThread(
	overrides: Partial<PersistedBuzzThread> = {},
): PersistedBuzzThread {
	return {
		channelId: CHANNEL_ID,
		threadRootId: ROOT_ID,
		sessionKey: THREAD_KEY,
		title: OPENING,
		repositoryId: "repo-1",
		branchName: THREAD_BRANCH,
		workspace: THREAD_WORKSPACE,
		phase: "execute",
		openingMessage: OPENING,
		lastResponse: "Rewrote the teardown to await cleanup.",
		agentSessionId: "claude-session-1",
		lastUsedAt: 1_753_400_000_000,
		program: PROGRAM,
		workUnits: [],
		...overrides,
	};
}

/** The unit that thread already is, in full. */
function synthesized(
	overrides: Partial<PersistedBuzzWorkUnit> = {},
): PersistedBuzzWorkUnit {
	return {
		unitId: SESSION_ID,
		unitKey: THREAD_KEY,
		title: OPENING,
		branchName: THREAD_BRANCH,
		workspace: THREAD_WORKSPACE,
		agentSessionId: "claude-session-1",
		issueId: PROGRAM.issueId,
		identifier: PROGRAM.identifier,
		url: PROGRAM.url,
		blockedBy: [],
		state: "finished",
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

function reaction(emoji: string): BuzzWebhookEvent {
	return event({
		eventType: "reaction_added",
		messageId: GATE_ID,
		emoji,
		deliveryId: `reaction_added:${GATE_ID}:${emoji}:${AUTHOR}`,
	});
}

/** Let the un-awaited gate handling chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The compatibility hinge of the two-tier model. Every thread that was live
 * before work units existed carries `workUnits: []`, and there is no state
 * version to migrate it with — a thread that quietly stopped running because it
 * predates the refactor is the failure these tests exist to prevent.
 */
describe("BuzzSessionCoordinator legacy work unit", () => {
	let getEvent: ReturnType<typeof vi.fn>;
	let startBuzzSession: ReturnType<typeof vi.fn>;
	let createBuzzWorkspace: ReturnType<typeof vi.fn>;
	let approvals: BuzzApprovalRegistry;
	let logger: ILogger;
	let coordinator: BuzzSessionCoordinator;

	beforeEach(() => {
		getEvent = vi.fn().mockResolvedValue(record());
		// One agent session per Cyrus session, so a turn that resumed the wrong
		// conversation is visible in the assertions rather than absorbed.
		startBuzzSession = vi.fn(
			async (request: { sessionId: string }) => `agent-${request.sessionId}`,
		);
		createBuzzWorkspace = vi.fn(
			async (
				_repository: RepositoryConfig,
				unitKey: string,
			): Promise<{ path: string; isGitWorktree: boolean }> => ({
				path: `/worktrees/${unitKey}`,
				isGitWorktree: true,
			}),
		);
		logger = createLogger();
		approvals = new BuzzApprovalRegistry(logger);

		const projection: BuzzProjectionHooks = {
			track: vi.fn().mockResolvedValue(PROGRAM.identifier),
			note: vi.fn().mockResolvedValue(undefined),
			setState: vi.fn().mockResolvedValue(undefined),
			get: vi.fn().mockReturnValue(PROGRAM),
			unprojectableReason: vi.fn().mockReturnValue(null),
			restore: vi.fn(),
		};

		coordinator = new BuzzSessionCoordinator({
			logger,
			client: {
				getEvent,
				sendMessage: vi.fn().mockResolvedValue(GATE_ID),
				addReaction: vi.fn().mockResolvedValue(undefined),
			} as unknown as BuzzCliClient,
			agentSessionManager: {
				getSession: vi.fn().mockReturnValue(undefined),
			} as unknown as AgentSessionManager,
			sessionOrchestrator: {
				startBuzzSession,
				createBuzzWorkspace,
			} as unknown as SessionOrchestrator,
			approvals,
			getChannelRoutes: () => [
				{ channelId: CHANNEL_ID, repositoryId: "repo-1" },
			],
			getSelfPubkey: () => SELF,
			getAllowedPubkeys: () => [AUTHOR],
			getRepositoryById: () => REPOSITORY,
			saveState: vi.fn().mockResolvedValue(undefined),
			getActivitySinkForChannel: () => ({}) as IActivitySink,
			projection,
		});
	});

	const hydrate = (overrides: Partial<PersistedBuzzThread> = {}) =>
		coordinator.hydrate({
			threads: { [SESSION_ID]: legacyThread(overrides) },
			repoMru: ["repo-1"],
		});

	const units = () => coordinator.serialize().threads[SESSION_ID]?.workUnits;

	it("synthesizes the one unit a pre-two-tier thread already is", async () => {
		await hydrate();

		expect(units()).toEqual([synthesized()]);
	});

	// A thread parked on its gate has not done the work its program describes, and
	// the unsuffixed first-unit slot is exactly what its first plan slice needs.
	it("synthesizes nothing for a thread the gate has not let out of triage", async () => {
		await hydrate({
			phase: "triage",
			openPrompt: {
				eventId: GATE_ID,
				channelId: CHANNEL_ID,
				kind: "gate",
				options: GATE_OPTIONS,
			},
		});

		expect(units()).toEqual([]);

		// So the first slice of its plan is still the unsuffixed first unit, on the
		// branch and in the worktree already on disk — no `-u2`, no second tree.
		expect(
			await coordinator.createWorkUnit(SESSION_ID, {
				unitId: "slice-await-cleanup",
				title: "Await cleanup in the teardown",
			}),
		).toEqual({
			unitId: "slice-await-cleanup",
			unitKey: THREAD_KEY,
			title: "Await cleanup in the teardown",
			branchName: THREAD_BRANCH,
			workspace: THREAD_WORKSPACE,
			agentSessionId: "claude-session-1",
			blockedBy: [],
			state: "planned",
		});
		expect(createBuzzWorkspace).not.toHaveBeenCalled();
	});

	// 📝 is the human saying "no code changes". It still projects a program issue,
	// so a `program` check cannot tell it apart from an implemented thread: gating
	// on that alone gave a declined thread a runnable, unblocked unit on the next
	// boot — the self-promotion into code changes the gate exists to prevent.
	it("synthesizes nothing for a thread the human declined with 📝", async () => {
		await coordinator.handleEvent(event());
		await coordinator.handleEvent(reaction("📝"));
		await settle();

		const persisted = coordinator.serialize();
		const declined = persisted.threads[SESSION_ID];
		expect([declined?.phase, declined?.program, declined?.workUnits]).toEqual([
			"triage",
			PROGRAM,
			[],
		]);

		// Restart on exactly that record.
		await coordinator.hydrate(persisted);

		expect(units()).toEqual([]);
	});

	// The whole point of the first unit having no `-u1`: the ▶️ runs on the branch
	// and worktree that are already on disk, and mints neither a second unit nor a
	// second worktree. The record for it is derived on the next boot instead, from
	// the phase the gate just wrote — and it describes that same identity, which is
	// what makes running the thread and running its first unit the same act.
	it("runs a released gate on the thread's own branch, and derives that unit on the next boot", async () => {
		await hydrate({
			phase: "triage",
			openPrompt: {
				eventId: GATE_ID,
				channelId: CHANNEL_ID,
				kind: "gate",
				options: GATE_OPTIONS,
			},
		});

		await coordinator.handleEvent(reaction("▶️"));
		await settle();

		const turn = startBuzzSession.mock.calls[0]?.[0];
		expect({
			sessionId: turn.sessionId,
			sessionKey: turn.sessionKey,
			branchName: turn.branchName,
			workspace: turn.workspace,
			threadRootId: turn.threadRootId,
			phase: turn.phase,
			resumeSessionId: turn.resumeSessionId,
			taskInstructions: turn.taskInstructions,
		}).toEqual({
			sessionId: SESSION_ID,
			sessionKey: THREAD_KEY,
			branchName: THREAD_BRANCH,
			workspace: THREAD_WORKSPACE,
			threadRootId: ROOT_ID,
			phase: "execute",
			resumeSessionId: "claude-session-1",
			taskInstructions: `${CYRUS_SCOPE}\n\nThe change above is approved. Implement it now on branch \`${THREAD_BRANCH}\`, then summarise what you changed.`,
		});
		expect(startBuzzSession).toHaveBeenCalledTimes(1);
		expect(createBuzzWorkspace).not.toHaveBeenCalled();
		expect(units()).toEqual([]);

		await coordinator.hydrate(coordinator.serialize());

		// Exactly one unit, finished, on the identity the turn above ran under —
		// and the conversation that turn produced, not the one it resumed.
		expect(units()).toEqual([
			synthesized({ agentSessionId: `agent-${SESSION_ID}` }),
		]);
	});

	// A thread with units has been through the planner. Synthesizing into it would
	// hand the plan's first slice a unit nobody planned.
	it("synthesizes nothing for a thread that already has units", async () => {
		const planned: PersistedBuzzWorkUnit[] = [
			{
				unitId: "unit-await-cleanup",
				unitKey: THREAD_KEY,
				title: "Await cleanup in the teardown",
				branchName: THREAD_BRANCH,
				workspace: THREAD_WORKSPACE,
				blockedBy: [],
				state: "finished",
			},
			{
				unitId: "unit-serialize-setup",
				unitKey: "BUZZ-a1b2c3-u2",
				title: "Serialize worktree setup",
				branchName: "BUZZ-a1b2c3-u2-serialize-worktree-setup",
				workspace: {
					path: "/worktrees/BUZZ-a1b2c3-u2",
					isGitWorktree: true,
				},
				blockedBy: ["unit-await-cleanup"],
				state: "planned",
			},
		];

		await hydrate({ workUnits: planned });

		expect(units()).toEqual(planned);
	});

	// A thread that never left triage has no work to synthesize, and must keep
	// zero units so its first plan slice can still be the unsuffixed first unit.
	it("synthesizes nothing for a thread with no program", async () => {
		await hydrate({ phase: "triage", program: undefined });

		expect(units()).toEqual([]);
	});

	// A thread that has been live all along reaches the unit path with no plan
	// behind it. The shipped one-issue-per-thread behaviour is the one-unit case,
	// so it runs rather than finding nothing to run.
	it("runs the one unit of a live thread that never had a plan", async () => {
		await coordinator.handleEvent(event());
		await coordinator.handleEvent(reaction("▶️"));
		await settle();
		startBuzzSession.mockClear();
		createBuzzWorkspace.mockClear();

		await coordinator.startWorkUnit(
			SESSION_ID,
			SESSION_ID,
			"Implement the approved change.",
		);

		expect(units()).toEqual([
			synthesized({ agentSessionId: `agent-${SESSION_ID}` }),
		]);
		const turn = startBuzzSession.mock.calls[0]?.[0];
		expect({
			sessionId: turn.sessionId,
			sessionKey: turn.sessionKey,
			branchName: turn.branchName,
			workspace: turn.workspace,
			taskInstructions: turn.taskInstructions,
		}).toEqual({
			sessionId: SESSION_ID,
			sessionKey: THREAD_KEY,
			branchName: THREAD_BRANCH,
			workspace: THREAD_WORKSPACE,
			taskInstructions: `${CYRUS_SCOPE}\n\nImplement the approved change.`,
		});
		expect(startBuzzSession).toHaveBeenCalledTimes(1);
		expect(createBuzzWorkspace).not.toHaveBeenCalled();
	});

	// One conversation held in two records. A turn run through the unit is the
	// thread's latest turn too, so the human's next message resumes it — not the
	// session the thread was on before the unit ran.
	it("keeps the thread and the unit it is from drifting apart", async () => {
		await hydrate();
		await coordinator.startWorkUnit(SESSION_ID, SESSION_ID, "Carry on.");
		startBuzzSession.mockClear();

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

		expect(startBuzzSession.mock.calls[0]?.[0].resumeSessionId).toBe(
			`agent-${SESSION_ID}`,
		);
	});
});
