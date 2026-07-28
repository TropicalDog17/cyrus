import type {
	ILogger,
	PersistedBuzzThread,
	PersistedBuzzWorkUnit,
	RepositoryConfig,
} from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionManager } from "../src/AgentSessionManager.js";
import { BuzzApprovalRegistry } from "../src/buzz/BuzzApprovalRegistry.js";
import type { BuzzCliClient } from "../src/buzz/BuzzCliClient.js";
import type { BuzzProjectionHooks } from "../src/buzz/BuzzSessionCoordinator.js";
import { BuzzSessionCoordinator } from "../src/buzz/BuzzSessionCoordinator.js";
import type { SessionOrchestrator } from "../src/SessionOrchestrator.js";
import type { IActivitySink } from "../src/sinks/IActivitySink.js";

const CHANNEL_ID = "6f1a2b3c-0000-4000-8000-000000000001";
const ROOT_ID = `a1b2c3${"0".repeat(58)}`;
const SESSION_ID = `buzz-${ROOT_ID}`;
const SELF = "5".repeat(64);
const OPENING = "Please look at the flaky worktree test";

const THREAD_KEY = "BUZZ-a1b2c3";
const THREAD_BRANCH = "BUZZ-a1b2c3-please-look-at-the-flaky-workt";
const THREAD_WORKSPACE = {
	path: "/worktrees/BUZZ-a1b2c3",
	isGitWorktree: true,
};

const SECOND_KEY = "BUZZ-a1b2c3-u2";
const SECOND_BRANCH = "BUZZ-a1b2c3-u2-serialize-worktree-setup";
const SECOND_WORKSPACE = {
	path: "/worktrees/BUZZ-a1b2c3-u2",
	isGitWorktree: true,
};

const PROGRAM = {
	issueId: "issue-77",
	identifier: "DEV-77",
	url: "https://linear.app/cyrus/issue/DEV-77",
};

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

/** What the EdgeWorker hands over: the review, already framed as a turn. */
const REVIEW_PROMPT =
	"A reviewer has responded to the pull request for the work in this thread.\n\nPlease widen the mutex to cover the setup script too.";

/** The one activity sink the thread's channel resolves to. */
const SINK = {} as IActivitySink;

/** Epoch ms the routed turn runs at, so `lastUsedAt` is assertable. */
const RAN_AT = 1_753_900_000_000;

function unit(
	overrides: Partial<PersistedBuzzWorkUnit> = {},
): PersistedBuzzWorkUnit {
	return {
		unitId: "unit-await-cleanup",
		unitKey: THREAD_KEY,
		title: OPENING,
		branchName: THREAD_BRANCH,
		workspace: THREAD_WORKSPACE,
		agentSessionId: "claude-session-1",
		blockedBy: [],
		state: "finished",
		...overrides,
	};
}

const SECOND_UNIT = unit({
	unitId: "unit-serialize-setup",
	unitKey: SECOND_KEY,
	title: "Serialize worktree setup",
	branchName: SECOND_BRANCH,
	workspace: SECOND_WORKSPACE,
	agentSessionId: "claude-session-u2",
	blockedBy: ["unit-await-cleanup"],
	state: "running",
});

function thread(
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
		agentSessionId: "claude-session-1",
		lastUsedAt: 1_753_400_000_000,
		program: PROGRAM,
		workUnits: [unit(), SECOND_UNIT],
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

/**
 * Where a review of a Buzz branch goes.
 *
 * Git will not check one branch out into two worktrees, and Cyrus does not fail
 * on that: it hands the second session the first's tree. So a `PR-<n>` session
 * for a branch a Buzz work unit holds is two agents in one worktree — silently.
 * These tests pin the routing that makes it impossible.
 */
describe("BuzzSessionCoordinator pull request review routing", () => {
	let startBuzzSession: ReturnType<typeof vi.fn>;
	let createBuzzWorkspace: ReturnType<typeof vi.fn>;
	let sendMessage: ReturnType<typeof vi.fn>;
	let saveState: ReturnType<typeof vi.fn>;
	let logger: ILogger;
	let coordinator: BuzzSessionCoordinator;

	beforeEach(() => {
		// One agent session per Cyrus session, so a turn that resumed the wrong
		// conversation is visible in the assertions rather than absorbed.
		startBuzzSession = vi.fn(
			async (request: { sessionId: string }) => `agent-${request.sessionId}`,
		);
		createBuzzWorkspace = vi.fn();
		sendMessage = vi.fn().mockResolvedValue("c".repeat(64));
		saveState = vi.fn().mockResolvedValue(undefined);
		logger = createLogger();

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
				getEvent: vi.fn(),
				sendMessage,
				addReaction: vi.fn().mockResolvedValue(undefined),
			} as unknown as BuzzCliClient,
			agentSessionManager: {
				getSession: vi.fn().mockReturnValue(undefined),
			} as unknown as AgentSessionManager,
			sessionOrchestrator: {
				startBuzzSession,
				createBuzzWorkspace,
			} as unknown as SessionOrchestrator,
			approvals: new BuzzApprovalRegistry(logger),
			getChannelRoutes: () => [
				{ channelId: CHANNEL_ID, repositoryId: "repo-1" },
			],
			getSelfPubkey: () => SELF,
			getRepositoryById: () => REPOSITORY,
			saveState,
			getActivitySinkForChannel: () => SINK,
			projection,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const hydrate = (overrides: Partial<PersistedBuzzThread> = {}) =>
		coordinator.hydrate({
			threads: { [SESSION_ID]: thread(overrides) },
			repoMru: ["repo-1"],
		});

	const route = (branchName: string) =>
		coordinator.routePullRequestReview({
			repositoryId: "repo-1",
			branchName,
			prompt: REVIEW_PROMPT,
		});

	it("runs the review as the unit whose branch the PR is on", async () => {
		await hydrate();

		await expect(route(SECOND_BRANCH)).resolves.toBe(true);

		expect(startBuzzSession.mock.calls).toEqual([
			[
				{
					repository: REPOSITORY,
					workspace: SECOND_WORKSPACE,
					sessionId: `${SESSION_ID}-u2`,
					sessionKey: SECOND_KEY,
					threadRootId: ROOT_ID,
					branchName: SECOND_BRANCH,
					title: "Serialize worktree setup",
					taskInstructions: `${CYRUS_SCOPE}\n\n${REVIEW_PROMPT}`,
					activitySink: SINK,
					phase: "execute",
					resumeSessionId: "claude-session-u2",
				},
			],
		]);
		// The unit already has a branch and a tree; asking for another is the bug.
		expect(createBuzzWorkspace.mock.calls).toEqual([]);
	});

	// The gate is enforced by the tool set `startBuzzSession` derives from the
	// phase it is given. A resume would re-derive it from the repository config
	// instead, so a PR would be a way to hand a triage thread write access.
	it("runs the review in the thread's phase, not one derived afresh", async () => {
		await hydrate({ phase: "triage" });

		await route(SECOND_BRANCH);

		expect(startBuzzSession.mock.calls[0]?.[0].phase).toBe("triage");
	});

	// A unit's turn is also the thread's when the unit *is* the thread, and the
	// review's conversation has to be the one the next message resumes.
	it("keeps the review's turn as the thread's own conversation", async () => {
		await hydrate();
		vi.spyOn(Date, "now").mockReturnValue(RAN_AT);

		await route(THREAD_BRANCH);

		expect(startBuzzSession.mock.calls[0]?.[0].sessionId).toBe(SESSION_ID);
		expect(coordinator.serialize().threads[SESSION_ID]).toEqual(
			thread({
				agentSessionId: `agent-${SESSION_ID}`,
				lastUsedAt: RAN_AT,
				workUnits: [
					unit({ agentSessionId: `agent-${SESSION_ID}` }),
					SECOND_UNIT,
				],
			}),
		);
	});

	// A repository the projection cannot reach never gets a program, so its
	// thread has no unit to synthesize — and still holds a branch and a worktree.
	it("takes a review of a program-less thread's own branch", async () => {
		await hydrate({ program: undefined, workUnits: [] });

		await expect(route(THREAD_BRANCH)).resolves.toBe(true);

		expect(startBuzzSession.mock.calls).toEqual([
			[
				{
					repository: REPOSITORY,
					workspace: THREAD_WORKSPACE,
					sessionId: SESSION_ID,
					sessionKey: THREAD_KEY,
					threadRootId: ROOT_ID,
					branchName: THREAD_BRANCH,
					title: OPENING,
					taskInstructions: `${CYRUS_SCOPE}\n\n${REVIEW_PROMPT}`,
					activitySink: SINK,
					phase: "execute",
					resumeSessionId: "claude-session-1",
				},
			],
		]);
		expect(createBuzzWorkspace.mock.calls).toEqual([]);
		// Still no units: a thread with no program has nothing planned, and its
		// first plan slice must still be able to mint the unsuffixed first unit.
		expect(coordinator.serialize().threads[SESSION_ID]?.workUnits).toEqual([]);
	});

	it("leaves a PR on a branch no thread holds to the PR path", async () => {
		await hydrate();

		await expect(route("dependabot/npm_and_yarn/vite-5.4.20")).resolves.toBe(
			false,
		);

		expect(startBuzzSession.mock.calls).toEqual([]);
	});

	// Branch names are unique within a repository and nowhere else, and two
	// repositories routed to the same Buzz channel is the ordinary case.
	it("ignores a matching branch in another repository", async () => {
		await hydrate();

		await expect(
			coordinator.routePullRequestReview({
				repositoryId: "repo-2",
				branchName: SECOND_BRANCH,
				prompt: REVIEW_PROMPT,
			}),
		).resolves.toBe(false);

		expect(startBuzzSession.mock.calls).toEqual([]);
	});
});
