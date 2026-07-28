import type { EdgeWorkerConfig, RepositoryConfig } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Mirrors the mock set the other EdgeWorker webhook suites use, plus the two
// Buzz collaborators that reach outside the process.
vi.mock("fs/promises");
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-mcp-tools", () => ({
	createCyrusToolsServer: vi.fn().mockReturnValue({ server: {} }),
}));
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js", () => ({
	SharedApplicationServer: vi.fn().mockImplementation(function () {
		return {
			initializeFastify: vi.fn(),
			getFastifyInstance: vi
				.fn()
				.mockReturnValue({ get: vi.fn(), post: vi.fn() }),
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
			getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
			registerOAuthCallbackHandler: vi.fn(),
		};
	}),
}));
vi.mock("../src/buzz/BuzzCliClient.js", () => ({
	BuzzCliClient: vi.fn().mockImplementation(function () {
		return { checkAvailable: vi.fn().mockResolvedValue(true) };
	}),
}));
vi.mock("../src/buzz/BuzzPollingSource.js", () => ({
	BuzzPollingSource: vi.fn().mockImplementation(function () {
		return { start: vi.fn(), stop: vi.fn() };
	}),
}));
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});

const { composeEdgeWorker } = await import("../src/EdgeWorker.js");
const { BuzzActivitySink } = await import("../src/sinks/BuzzActivitySink.js");

const CHANNEL_ID = "6f1a2b3c-0000-4000-8000-000000000001";
const ROOT_ID = `a1b2c3${"0".repeat(58)}`;
const SESSION_ID = `buzz-${ROOT_ID}`;

const THREAD_KEY = "BUZZ-a1b2c3";
const THREAD_BRANCH = "BUZZ-a1b2c3-serialize-worktree-setup";
const THREAD_WORKSPACE = {
	path: "/worktrees/BUZZ-a1b2c3",
	isGitWorktree: true,
};
const OPENING = "Serialize worktree setup";

const REPOSITORY: RepositoryConfig = {
	id: "repo-1",
	name: "cyrus",
	repositoryPath: "/repos/cyrus",
	workspaceBaseDir: "/worktrees",
	baseBranch: "main",
	linearWorkspaceId: "test-workspace",
	isActive: true,
	allowedTools: ["Read", "Edit"],
	labelPrompts: {},
	teamKeys: ["DEV"],
} as RepositoryConfig;

/** The scope block every Buzz turn is prefixed with, spelled out in full. */
const CYRUS_SCOPE = [
	"<session_scope>",
	"This thread works on the `cyrus` repository, checked out in the worktree you are running in. Nothing outside it is in scope.",
	"",
	"Linear scope for this repository: team DEV. Constrain every Linear lookup to it — do not search the workspace at large.",
	"An issue outside that scope belongs to a different repository. Do not read it, plan it, or act on it here: say which scope it falls in and stop.",
	"</session_scope>",
].join("\n");

/** The review turn, in full, as the thread receives it. */
const REVIEW_TURN = `A reviewer has responded to the pull request for the work in this thread.

## Context
- **Repository**: testorg/my-repo
- **PR**: #42 - Serialize worktree setup
- **Branch**: ${THREAD_BRANCH}, already checked out in the worktree you are running in
- **Reviewer**: @reviewer
- **Review URL**: https://github.com/testorg/my-repo/pull/42#pullrequestreview-777

## Reviewer feedback
Please widen the mutex to cover the setup script too.

## Instructions
- Address the feedback on \`${THREAD_BRANCH}\` — do not create another branch or worktree
- Commit and push to that branch when you are done
- Summarise what you changed; your reply goes back into this chat thread`;

/** A `pull_request_review` requesting changes on the given head branch. */
function reviewEvent(headRef: string): Record<string, unknown> {
	return {
		eventType: "pull_request_review",
		deliveryId: "delivery-pr-review-001",
		payload: {
			action: "submitted",
			review: {
				id: 777,
				body: "Please widen the mutex to cover the setup script too.",
				state: "changes_requested",
				html_url:
					"https://github.com/testorg/my-repo/pull/42#pullrequestreview-777",
				user: { login: "reviewer" },
				submitted_at: "2026-07-27T10:30:00Z",
				commit_id: "abc123",
			},
			pull_request: {
				number: 42,
				title: "Serialize worktree setup",
				head: { ref: headRef },
				base: { ref: "main" },
			},
			repository: {
				full_name: "testorg/my-repo",
				name: "my-repo",
				owner: { login: "testorg" },
			},
			sender: { login: "reviewer" },
			installation: { id: 55555, node_id: "MDIzOk" },
		},
	};
}

function buildConfig(): EdgeWorkerConfig {
	return {
		proxyUrl: "http://localhost:3000",
		cyrusHome: TEST_CYRUS_HOME,
		repositories: [REPOSITORY],
		linearWorkspaces: {
			"test-workspace": { linearToken: "test-token" },
		},
		buzz: {
			cliPath: "/usr/local/bin/buzz",
			relayUrl: "https://relay.example.com",
			channels: [{ channelId: CHANNEL_ID, repositoryId: "repo-1" }],
		},
	} as EdgeWorkerConfig;
}

/**
 * A PR whose head branch a Buzz thread already holds must not become a session
 * of its own. Git will not check one branch out twice and Cyrus does not fail
 * on that — it shares the first session's worktree — so the only visible
 * evidence of the collision is two agents overwriting each other's edits. This
 * asserts the routing that prevents it at the one place both paths are chosen.
 */
describe("EdgeWorker routes a PR review into its Buzz thread", () => {
	let worker: any;
	let startBuzzSession: ReturnType<typeof vi.fn>;
	let startGitHubSession: ReturnType<typeof vi.fn>;
	let createGitHubWorkspace: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.BUZZ_PRIVATE_KEY = "nsec-test";
		delete process.env.GITHUB_BOT_USERNAME;

		worker = composeEdgeWorker(buildConfig());
		worker.registerBuzzEventTransport();

		startBuzzSession = vi.fn().mockResolvedValue("claude-session-2");
		startGitHubSession = vi.fn().mockResolvedValue(undefined);
		createGitHubWorkspace = vi
			.fn()
			.mockResolvedValue({ path: "/worktrees/PR-42", isGitWorktree: true });
		worker.sessionOrchestrator.startBuzzSession = startBuzzSession;
		worker.sessionOrchestrator.startGitHubSession = startGitHubSession;
		worker.createGitHubWorkspace = createGitHubWorkspace;
		worker.resolveGitHubToken = vi.fn().mockResolvedValue(undefined);
		worker.findRepositoryByGitHubUrl = vi.fn().mockReturnValue(REPOSITORY);
		worker.agentSessionManager.getActiveMultiRepoSessionForRepository = vi
			.fn()
			.mockReturnValue(null);

		await worker.buzzSessionCoordinator.hydrate({
			threads: {
				[SESSION_ID]: {
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
					workUnits: [
						{
							unitId: "unit-serialize-setup",
							unitKey: THREAD_KEY,
							title: OPENING,
							branchName: THREAD_BRANCH,
							workspace: THREAD_WORKSPACE,
							agentSessionId: "claude-session-1",
							blockedBy: [],
							state: "running",
						},
					],
				},
			},
			repoMru: ["repo-1"],
		});
	});

	afterEach(() => {
		delete process.env.BUZZ_PRIVATE_KEY;
		vi.restoreAllMocks();
	});

	it("takes the review into the thread instead of opening a PR session", async () => {
		await worker.handleGitHubWebhook(reviewEvent(THREAD_BRANCH));

		// The whole point: no second workspace is even asked for.
		expect(createGitHubWorkspace.mock.calls).toEqual([]);
		expect(startGitHubSession.mock.calls).toEqual([]);
		expect(startBuzzSession).toHaveBeenCalledTimes(1);

		const { activitySink, repository, ...turn } =
			startBuzzSession.mock.calls[0][0];
		expect(turn).toEqual({
			workspace: THREAD_WORKSPACE,
			sessionId: SESSION_ID,
			sessionKey: THREAD_KEY,
			threadRootId: ROOT_ID,
			branchName: THREAD_BRANCH,
			title: OPENING,
			taskInstructions: `${CYRUS_SCOPE}\n\n${REVIEW_TURN}`,
			// The thread's phase, not a tool set derived afresh from the repository:
			// a resume would hand a triage thread write access.
			phase: "execute",
			resumeSessionId: "claude-session-1",
		});
		// The routed repository, not a re-resolution: the config object EdgeWorker
		// registered, normalized (its optional path fields present as `undefined`).
		expect(repository).toEqual(REPOSITORY);
		expect(activitySink).toBeInstanceOf(BuzzActivitySink);
	});

	it("leaves a PR on any other branch to the PR path", async () => {
		await worker.handleGitHubWebhook(reviewEvent("dependabot/npm/vite-5.4.20"));

		expect(startBuzzSession.mock.calls).toEqual([]);
		expect(createGitHubWorkspace.mock.calls).toEqual([
			[REPOSITORY, "dependabot/npm/vite-5.4.20", 42],
		]);
		expect(startGitHubSession).toHaveBeenCalledTimes(1);
	});
});
