import type { BuzzWebhookEvent } from "cyrus-buzz-event-transport";
import type { ILogger, RepositoryConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionManager } from "../src/AgentSessionManager.js";
import { BuzzApprovalRegistry } from "../src/buzz/BuzzApprovalRegistry.js";
import type {
	BuzzCliClient,
	BuzzEventRecord,
} from "../src/buzz/BuzzCliClient.js";
import { BuzzQuestionHandler } from "../src/buzz/BuzzQuestionHandler.js";
import { BuzzSessionCoordinator } from "../src/buzz/BuzzSessionCoordinator.js";
import {
	threadSessionIdOf,
	unitBranchNameFor,
	unitKeyFor,
	unitSessionIdFor,
} from "../src/buzz/buzz-unit-identity.js";
import type { SessionOrchestrator } from "../src/SessionOrchestrator.js";
import type { IActivitySink } from "../src/sinks/IActivitySink.js";

const CHANNEL_ID = "6f1a2b3c-0000-4000-8000-000000000001";
const ROOT_ID = `a1b2c3${"0".repeat(58)}`;
const GATE_ID = "c".repeat(64);
const QUESTION_ID = "e".repeat(64);
const AUTHOR = "9".repeat(64);
const SESSION_ID = `buzz-${ROOT_ID}`;
const UNIT_2_SESSION_ID = `buzz-${ROOT_ID}-u2`;

/** The thread's own key and branch, as the single-unit path mints them today. */
const THREAD_KEY = "BUZZ-a1b2c3";
const THREAD_BRANCH = "BUZZ-a1b2c3-please-look-at-the-flaky-workt";
const THREAD_WORKSPACE = {
	path: "/worktrees/BUZZ-a1b2c3",
	isGitWorktree: true,
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

/**
 * The naming rule itself, isolated from the coordinator. The first unit having
 * no suffix is the no-migration guarantee: it is what a thread already live on
 * disk keeps, so tidying it into `-u1` would rename a worktree somebody has
 * checked out.
 */
describe("buzz work unit identity", () => {
	it("gives the first unit the thread's own key and later units a suffix", () => {
		expect([1, 2, 3, 11].map((index) => unitKeyFor(THREAD_KEY, index))).toEqual(
			["BUZZ-a1b2c3", "BUZZ-a1b2c3-u2", "BUZZ-a1b2c3-u3", "BUZZ-a1b2c3-u11"],
		);
	});

	it("names a branch after the unit's key and its own title", () => {
		expect(
			unitBranchNameFor("BUZZ-a1b2c3-u2", "Serialize worktree setup"),
		).toBe("BUZZ-a1b2c3-u2-serialize-worktree-setup");
	});

	// The first unit runs *as* the thread's session, which is what lets a thread
	// that pre-dates work units resume the conversation it already had.
	it("maps a unit key to a session id and back", () => {
		expect(
			["BUZZ-a1b2c3", "BUZZ-a1b2c3-u2", "BUZZ-a1b2c3-u11"].map((unitKey) =>
				unitSessionIdFor(SESSION_ID, unitKey),
			),
		).toEqual([SESSION_ID, `${SESSION_ID}-u2`, `${SESSION_ID}-u11`]);

		expect(
			[SESSION_ID, `${SESSION_ID}-u2`, `${SESSION_ID}-u11`].map(
				threadSessionIdOf,
			),
		).toEqual([SESSION_ID, SESSION_ID, SESSION_ID]);
	});
});

describe("BuzzSessionCoordinator work units", () => {
	let sendMessage: ReturnType<typeof vi.fn>;
	let addReaction: ReturnType<typeof vi.fn>;
	let startBuzzSession: ReturnType<typeof vi.fn>;
	let createBuzzWorkspace: ReturnType<typeof vi.fn>;
	let saveState: ReturnType<typeof vi.fn>;
	let approvals: BuzzApprovalRegistry;
	let logger: ILogger;
	let coordinator: BuzzSessionCoordinator;

	beforeEach(() => {
		sendMessage = vi.fn().mockResolvedValue(GATE_ID);
		addReaction = vi.fn().mockResolvedValue(undefined);
		// One agent session per Cyrus session, so a run that resumed the wrong
		// one is visible in the assertions rather than absorbed by a constant.
		startBuzzSession = vi.fn(
			async (req: { sessionId: string }) => `agent-${req.sessionId}`,
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
		saveState = vi.fn().mockResolvedValue(undefined);
		logger = createLogger();
		approvals = new BuzzApprovalRegistry(logger);

		coordinator = new BuzzSessionCoordinator({
			logger,
			client: {
				getEvent: vi.fn().mockResolvedValue(record()),
				sendMessage,
				addReaction,
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
			getSelfPubkey: () => undefined,
			getRepositoryById: () => REPOSITORY,
			saveState,
			getActivitySinkForChannel: () => ({}) as IActivitySink,
		});
	});

	/**
	 * A thread as it exists today: one message, one gate, one ▶️ — the whole
	 * single-unit path, whose identity every assertion below is measured
	 * against.
	 */
	async function openThreadAndReleaseGate(): Promise<void> {
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
	}

	async function createTwoUnits() {
		return [
			await coordinator.createWorkUnit(SESSION_ID, {
				unitId: "unit-await-cleanup",
				title: "Await cleanup in the teardown",
			}),
			await coordinator.createWorkUnit(SESSION_ID, {
				unitId: "unit-serialize-setup",
				title: "Serialize worktree setup",
				blockedBy: ["unit-await-cleanup"],
			}),
		];
	}

	it("mints one key, branch and worktree per unit, reusing the thread's for the first", async () => {
		await openThreadAndReleaseGate();

		expect(await createTwoUnits()).toEqual([
			{
				unitId: "unit-await-cleanup",
				unitKey: THREAD_KEY,
				title: "Await cleanup in the teardown",
				branchName: THREAD_BRANCH,
				workspace: THREAD_WORKSPACE,
				// Inherited along with the branch and the worktree: unit 1 is the
				// thread, so it carries the conversation the thread already had.
				agentSessionId: `agent-${SESSION_ID}`,
				blockedBy: [],
				state: "planned",
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
		]);

		// Two worktrees, and the first is the thread's own — minted when the
		// thread opened, not re-minted for the unit that inherits it.
		expect(
			createBuzzWorkspace.mock.calls.map((call) => [call[1], call[2], call[3]]),
		).toEqual([
			[THREAD_KEY, THREAD_BRANCH, "Please look at the flaky worktree test"],
			[
				"BUZZ-a1b2c3-u2",
				"BUZZ-a1b2c3-u2-serialize-worktree-setup",
				"Serialize worktree setup",
			],
		]);
	});

	// A minted unit owns a worktree on disk from the moment it exists; a record
	// that only lived in memory would leave that worktree belonging to nobody.
	it("records each minted unit on the thread it belongs to", async () => {
		await openThreadAndReleaseGate();
		await createTwoUnits();
		saveState.mockClear();

		await coordinator.createWorkUnit(SESSION_ID, {
			unitId: "unit-third",
			title: "Write the gotcha",
		});

		expect(saveState).toHaveBeenCalledTimes(1);
		expect(
			coordinator
				.serialize()
				.threads[SESSION_ID]?.workUnits.map((unit) => [
					unit.unitId,
					unit.unitKey,
					unit.branchName,
				]),
		).toEqual([
			["unit-await-cleanup", THREAD_KEY, THREAD_BRANCH],
			[
				"unit-serialize-setup",
				"BUZZ-a1b2c3-u2",
				"BUZZ-a1b2c3-u2-serialize-worktree-setup",
			],
			["unit-third", "BUZZ-a1b2c3-u3", "BUZZ-a1b2c3-u3-write-the-gotcha"],
		]);
	});

	// Committing a program is a series of non-atomic writes; a retry must find
	// the units it already minted rather than mint a second branch for each.
	it("returns the existing unit when the same unitId is created twice", async () => {
		await openThreadAndReleaseGate();
		const [first] = await createTwoUnits();
		createBuzzWorkspace.mockClear();

		const again = await coordinator.createWorkUnit(SESSION_ID, {
			unitId: "unit-await-cleanup",
			title: "A title the retry made up",
		});

		expect(again).toBe(first);
		expect(createBuzzWorkspace).not.toHaveBeenCalled();
	});

	// The no-migration guarantee: unit 1 runs on exactly the session, key,
	// branch and worktree the pre-program path produced for this thread. If
	// somebody "tidies" the first unit into `-u1`, this fails.
	it("runs the first unit on the identity the single-unit path already produced", async () => {
		await openThreadAndReleaseGate();
		await createTwoUnits();
		const threadTurn = startBuzzSession.mock.calls[0]?.[0];

		await coordinator.startWorkUnit(
			SESSION_ID,
			"unit-await-cleanup",
			"Implement the first unit.",
		);

		const unitTurn = startBuzzSession.mock.calls.at(-1)?.[0];
		expect({
			sessionId: unitTurn.sessionId,
			sessionKey: unitTurn.sessionKey,
			branchName: unitTurn.branchName,
			workspace: unitTurn.workspace,
		}).toEqual({
			sessionId: threadTurn.sessionId,
			sessionKey: threadTurn.sessionKey,
			branchName: threadTurn.branchName,
			workspace: threadTurn.workspace,
		});
		expect(unitTurn.taskInstructions).toBe(
			`${CYRUS_SCOPE}\n\nImplement the first unit.`,
		);
		// Identity includes the conversation: unit 1 continues the thread's rather
		// than starting a second transcript on the thread's own session id.
		expect(unitTurn.resumeSessionId).toBe(`agent-${SESSION_ID}`);
	});

	// The assertion above cannot see a restarted conversation on its own: the
	// mock mints one agent id per Cyrus session, and unit 1 shares the thread's.
	// This one gives every run a distinct id, so the turn that is allowed to
	// write code has to name the transcript triage actually left behind.
	it("runs the first unit as a continuation of the thread's own conversation", async () => {
		let run = 0;
		startBuzzSession.mockImplementation(async () => `agent-run-${++run}`);

		await openThreadAndReleaseGate();
		await createTwoUnits();
		const afterTriage = `agent-run-${run}`;

		await coordinator.startWorkUnit(
			SESSION_ID,
			"unit-await-cleanup",
			"Implement the first unit.",
		);

		expect(startBuzzSession.mock.calls.at(-1)?.[0].resumeSessionId).toBe(
			afterTriage,
		);
		// And the run's own id follows back onto both records, so the human's next
		// message in the thread resumes what the unit just ran.
		const thread = coordinator.serialize().threads[SESSION_ID];
		expect([
			thread?.agentSessionId,
			thread?.workUnits[0]?.agentSessionId,
		]).toEqual([`agent-run-${run}`, `agent-run-${run}`]);
	});

	it("runs a later unit on its own session, key, branch and worktree", async () => {
		await openThreadAndReleaseGate();
		await createTwoUnits();
		startBuzzSession.mockClear();

		await coordinator.startWorkUnit(
			SESSION_ID,
			"unit-serialize-setup",
			"Implement the second unit.",
		);

		expect(startBuzzSession).toHaveBeenCalledTimes(1);
		const turn = startBuzzSession.mock.calls[0]?.[0];
		expect({
			sessionId: turn.sessionId,
			sessionKey: turn.sessionKey,
			branchName: turn.branchName,
			workspace: turn.workspace,
			title: turn.title,
			phase: turn.phase,
			taskInstructions: turn.taskInstructions,
			resumeSessionId: turn.resumeSessionId,
		}).toEqual({
			sessionId: UNIT_2_SESSION_ID,
			sessionKey: "BUZZ-a1b2c3-u2",
			branchName: "BUZZ-a1b2c3-u2-serialize-worktree-setup",
			workspace: { path: "/worktrees/BUZZ-a1b2c3-u2", isGitWorktree: true },
			title: "Serialize worktree setup",
			// The gate is the thread's, not the unit's — a unit inherits it and
			// cannot promote itself.
			phase: "execute",
			taskInstructions: `${CYRUS_SCOPE}\n\nImplement the second unit.`,
			// A unit that has not run yet has no conversation to resume.
			resumeSessionId: undefined,
		});
	});

	// Unit-keyed execution, thread-keyed conversation: the session id diverges
	// per unit while the thread root every activity is posted under does not.
	it("posts every unit's activity into the one thread", async () => {
		await openThreadAndReleaseGate();
		await createTwoUnits();
		await coordinator.startWorkUnit(SESSION_ID, "unit-await-cleanup", "First.");
		await coordinator.startWorkUnit(
			SESSION_ID,
			"unit-serialize-setup",
			"Second.",
		);

		expect(
			startBuzzSession.mock.calls.map((call) => [
				call[0].sessionId,
				call[0].threadRootId,
			]),
		).toEqual([
			[SESSION_ID, ROOT_ID],
			[SESSION_ID, ROOT_ID],
			[SESSION_ID, ROOT_ID],
			[UNIT_2_SESSION_ID, ROOT_ID],
		]);
	});

	it("resumes a unit's own agent session on its next turn", async () => {
		await openThreadAndReleaseGate();
		await createTwoUnits();

		await coordinator.startWorkUnit(
			SESSION_ID,
			"unit-serialize-setup",
			"Implement it.",
		);
		await coordinator.startWorkUnit(
			SESSION_ID,
			"unit-serialize-setup",
			"Now address the review.",
		);

		expect(startBuzzSession.mock.calls.at(-1)?.[0].resumeSessionId).toBe(
			`agent-${UNIT_2_SESSION_ID}`,
		);
		// Nothing else writes a unit's agent session, so it has to be saved here
		// or a restart loses the conversation the next turn would resume.
		expect(saveState).toHaveBeenCalled();
	});

	it("does nothing for a unit the thread does not have", async () => {
		await openThreadAndReleaseGate();
		startBuzzSession.mockClear();

		await coordinator.startWorkUnit(SESSION_ID, "unit-nobody-planned", "Go.");

		expect(startBuzzSession).not.toHaveBeenCalled();
	});

	describe("a question raised inside a later unit", () => {
		let handler: BuzzQuestionHandler;

		beforeEach(() => {
			handler = new BuzzQuestionHandler({
				logger,
				client: {
					sendMessage: vi.fn().mockResolvedValue(QUESTION_ID),
					addReaction,
				} as unknown as BuzzCliClient,
				approvals,
				getThread: (sessionId) => coordinator.getThread(sessionId),
				getTimeoutMs: () => 0,
			});
		});

		const question = {
			questions: [
				{
					question: "Squash the fixups first?",
					options: [
						{ label: "Squash them", description: "One commit per unit" },
						{ label: "Leave them", description: "Keep the history" },
					],
				},
			],
		};

		it("is asked in the thread and answered by a reaction there", async () => {
			await openThreadAndReleaseGate();
			await createTwoUnits();

			const asked = handler.ask(
				question,
				UNIT_2_SESSION_ID,
				new AbortController().signal,
			);
			await settle();
			approvals.resolveByReaction(QUESTION_ID, "1⃣", AUTHOR);

			expect(await asked).toEqual({
				answered: true,
				answers: { "Squash the fixups first?": "Squash them" },
			});
			expect(coordinator.getThread(UNIT_2_SESSION_ID)).toEqual({
				channelId: CHANNEL_ID,
				threadRootId: ROOT_ID,
			});
		});

		// The human replies in the thread — they have no way to address a unit —
		// so the reply has to reach the prompt the unit's session is holding.
		it("is answered by a threaded reply", async () => {
			await openThreadAndReleaseGate();
			await createTwoUnits();

			const asked = handler.ask(
				question,
				UNIT_2_SESSION_ID,
				new AbortController().signal,
			);
			await settle();
			await coordinator.handleEvent(
				event({
					messageId: "b".repeat(64),
					deliveryId: `message_posted:${"b".repeat(64)}:`,
				}),
			);

			expect(await asked).toEqual({
				answered: true,
				answers: {
					"Squash the fixups first?": "Please look at the flaky worktree test",
				},
			});
		});

		// A question dies with the process, and stage 1's guarantee is that it
		// dies out loud. A prompt held by a unit's session must therefore still
		// reach the thread's record, or the announcement never happens.
		it("is persisted against the thread it was asked in", async () => {
			await openThreadAndReleaseGate();
			await createTwoUnits();

			void handler.ask(
				question,
				UNIT_2_SESSION_ID,
				new AbortController().signal,
			);
			await settle();

			expect(coordinator.serialize().threads[SESSION_ID]?.openPrompt).toEqual({
				eventId: QUESTION_ID,
				channelId: CHANNEL_ID,
				kind: "question",
				options: [
					{ emoji: "1⃣", value: "Squash them", label: "Squash them" },
					{ emoji: "2⃣", value: "Leave them", label: "Leave them" },
				],
			});
		});
	});
});
