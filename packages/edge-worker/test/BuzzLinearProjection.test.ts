import type {
	IIssueTrackerService,
	ILogger,
	RepositoryConfig,
} from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuzzLinearProjection } from "../src/buzz/BuzzLinearProjection.js";
import type { BuzzTrackRequest } from "../src/buzz/BuzzSessionCoordinator.js";

const SESSION_ID = "buzz-abc";
const THREAD_ROOT = "d".repeat(64);
const CHANNEL_ID = "6f1a2b3c-0000-4000-8000-000000000001";

const REPOSITORY = {
	id: "repo-1",
	name: "cyrus",
	repositoryPath: "/repos/cyrus",
	baseBranch: "main",
	workspaceBaseDir: "/worktrees",
	linearWorkspaceId: "ws-1",
	teamKeys: ["DEV"],
} as RepositoryConfig;

function request(overrides: Partial<BuzzTrackRequest> = {}): BuzzTrackRequest {
	return {
		sessionId: SESSION_ID,
		sessionKey: "BUZZ-abc123",
		channelId: CHANNEL_ID,
		threadRootId: THREAD_ROOT,
		title: "Fix the flaky worktree test",
		summary: "Fix the flaky worktree test, it fails about 1 run in 5",
		repository: REPOSITORY,
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

describe("BuzzLinearProjection", () => {
	let createIssue: ReturnType<typeof vi.fn>;
	let createComment: ReturnType<typeof vi.fn>;
	let updateIssue: ReturnType<typeof vi.fn>;
	let fetchIssue: ReturnType<typeof vi.fn>;
	let fetchWorkflowStates: ReturnType<typeof vi.fn>;
	let tracker: IIssueTrackerService | null;
	let logger: ILogger;
	let projection: BuzzLinearProjection;

	beforeEach(() => {
		createIssue = vi.fn().mockResolvedValue({
			id: "issue-uuid",
			identifier: "DEV-42",
			url: "https://linear.app/devtrop/issue/DEV-42",
		});
		createComment = vi.fn().mockResolvedValue({ id: "comment-1" });
		updateIssue = vi.fn().mockResolvedValue({ id: "issue-uuid" });
		fetchIssue = vi.fn().mockResolvedValue({
			id: "issue-uuid",
			team: Promise.resolve({ id: "team-1" }),
		});
		fetchWorkflowStates = vi.fn().mockResolvedValue({
			nodes: [
				{ id: "state-todo", name: "Todo" },
				{ id: "state-progress", name: "In Progress" },
			],
			pageInfo: {},
		});
		logger = createLogger();
		tracker = {
			createIssue,
			createComment,
			updateIssue,
			fetchIssue,
			fetchWorkflowStates,
		} as unknown as IIssueTrackerService;

		projection = new BuzzLinearProjection({
			logger,
			getIssueTracker: () => tracker,
			buildThreadUrl: (channelId, root) =>
				`https://buzz.example.com/${channelId}/${root}`,
		});
	});

	// Load-bearing: assignment is what makes Linear open an agent session, so an
	// assigned projection would race a second session against the same branch.
	it("creates the issue unassigned", async () => {
		await projection.track(request());

		expect(createIssue).toHaveBeenCalledTimes(1);
		const input = createIssue.mock.calls[0]?.[0];
		expect(input.assigneeId).toBeUndefined();
		expect(input).toEqual(
			expect.objectContaining({
				teamId: "DEV",
				title: "Fix the flaky worktree test",
			}),
		);
	});

	it("carries the Buzz thread reference into the description", async () => {
		await projection.track(request());

		const description = createIssue.mock.calls[0]?.[0].description as string;
		expect(description).toContain(THREAD_ROOT);
		expect(description).toContain(CHANNEL_ID);
		expect(description).toContain(
			`https://buzz.example.com/${CHANNEL_ID}/${THREAD_ROOT}`,
		);
		expect(description).toContain("fails about 1 run in 5");
		// The reason it is unassigned must survive contact with a future reader.
		expect(description).toContain("intentionally unassigned");
	});

	it("returns the identifier and only creates once per session", async () => {
		expect(await projection.track(request())).toBe("DEV-42");
		expect(await projection.track(request())).toBe("DEV-42");

		expect(createIssue).toHaveBeenCalledTimes(1);
	});

	it("does nothing when the repository has no Linear team", async () => {
		const identifier = await projection.track(
			request({
				repository: { ...REPOSITORY, teamKeys: [] } as RepositoryConfig,
			}),
		);

		expect(identifier).toBeNull();
		expect(createIssue).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalled();
	});

	it("does nothing when there is no issue tracker", async () => {
		tracker = null;

		expect(await projection.track(request())).toBeNull();
		expect(createIssue).not.toHaveBeenCalled();
	});

	it("comments on the projected issue", async () => {
		await projection.track(request());
		await projection.note(SESSION_ID, "Working on branch `BUZZ-abc123-fix`.");

		expect(createComment).toHaveBeenCalledWith("issue-uuid", {
			body: "Working on branch `BUZZ-abc123-fix`.",
		});
	});

	it("ignores notes for a thread that was never projected", async () => {
		await projection.note("buzz-never-tracked", "hello");

		expect(createComment).not.toHaveBeenCalled();
	});

	it("moves the issue to a named workflow state", async () => {
		await projection.track(request());
		await projection.setState(SESSION_ID, "In Progress");

		expect(fetchWorkflowStates).toHaveBeenCalledWith("team-1");
		expect(updateIssue).toHaveBeenCalledWith("issue-uuid", {
			stateId: "state-progress",
		});
	});

	// A renamed or missing state is a config mismatch, not a transient failure.
	it("does not retry an unknown workflow state", async () => {
		await projection.track(request());
		await projection.setState(SESSION_ID, "Nonexistent");

		expect(fetchWorkflowStates).toHaveBeenCalledTimes(1);
		expect(updateIssue).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalled();
	});

	it("retries a transient failure", async () => {
		vi.useFakeTimers();
		try {
			createIssue.mockRejectedValueOnce(new Error("503")).mockResolvedValue({
				id: "issue-uuid",
				identifier: "DEV-42",
				url: "u",
			});

			const pending = projection.track(request());
			await vi.advanceTimersByTimeAsync(5_000);

			expect(await pending).toBe("DEV-42");
			expect(createIssue).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	// A Linear outage must never stall or fail the Buzz session — the session is
	// the work, the issue is only its shadow.
	it("gives up quietly after exhausting its attempts", async () => {
		vi.useFakeTimers();
		try {
			createIssue.mockRejectedValue(new Error("Linear is down"));

			const pending = projection.track(request());
			await vi.advanceTimersByTimeAsync(30_000);

			expect(await pending).toBeNull();
			expect(createIssue).toHaveBeenCalledTimes(3);
			expect(logger.warn).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
