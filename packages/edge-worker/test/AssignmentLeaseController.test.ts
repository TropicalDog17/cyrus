import type { CyrusAgentSession } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import {
	AssignmentLeaseController,
	type PipelineClosurePort,
} from "../src/closure/AssignmentLeaseController.js";

const candidate = {
	repositoryId: "repo-1",
	prNumber: 42,
	runId: "RUN-42",
	headSha: "sha-a",
};

function makeSession(): CyrusAgentSession {
	return {
		id: "session-1",
		type: "comment_thread",
		status: "active",
		context: "comment_thread",
		createdAt: 0,
		updatedAt: 0,
		issueId: "issue-1",
		issue: { id: "issue-1", identifier: "ENG-42", title: "Closure" },
		repositories: [{ repositoryId: "repo-1" }],
		workspace: { path: "/worktree", isGitWorktree: true },
		agentProfileId: "omp",
		runnerSessionId: "omp-session-1",
	};
}

function makePipeline(): PipelineClosurePort {
	return {
		initialize: vi.fn().mockResolvedValue({
			available: true,
			projectPath: "/pipeline",
			dataPath: "/pipeline/data",
		}),
		watch: vi.fn().mockResolvedValue({
			results: [{ run_id: "RUN-42", pr: 42, captured: true }],
			liveness: {},
		}),
		readPrFact: vi.fn().mockResolvedValue({
			run_id: "RUN-42",
			issue_id: "ENG-42",
			repo: "repo-one",
			repo_dir: "/repo-one",
			number: 42,
			head_sha: "sha-a",
			base: "main",
		}),
		review: vi.fn().mockResolvedValue({
			run_id: "RUN-42",
			diff: "/pipeline/data/diffs/RUN-42.diff",
			ledger: [],
			diffscan_warnings: [],
			note: "Judge verdict intentionally withheld until your verdict is recorded.",
		}),
		readHumanFact: vi.fn().mockResolvedValue({
			verdict: "needs-rework",
			head_sha: "sha-a",
			findings: [{ text: "missing test", tag: "recurring" }],
		}),
		integrate: vi.fn().mockResolvedValue({
			result: { run_id: "RUN-42", integrated: true },
			mergeFact: {
				run_id: "RUN-42",
				merged: true,
				pr: 42,
				method: "squash",
				merge_commit: "merge-sha",
				base: "main",
				head_sha: "sha-a",
				at: "2026-08-03T16:00:00.000Z",
			},
		}),
		recordLearning: vi.fn().mockResolvedValue(undefined),
	};
}

function createController(
	session = makeSession(),
	pipeline = makePipeline(),
	currentHeadSha = "sha-a",
) {
	const save = vi.fn();
	const postGate = vi.fn().mockResolvedValue("gate-activity-1");
	const resume = vi.fn().mockResolvedValue(undefined);
	const controller = new AssignmentLeaseController({
		pipeline,
		getSession: (sessionId) => (sessionId === session.id ? session : undefined),
		saveSession: save,
		postGate,
		resume,
		getRepositoryPath: () => "/repo-one",
		getCurrentHeadSha: vi.fn().mockResolvedValue(currentHeadSha),
		now: () => "2026-08-03T16:00:00.000Z",
	});
	return { controller, pipeline, postGate, resume, save, session };
}

describe("AssignmentLeaseController", () => {
	it("acquires an OMP lease and keeps it active after runner success", async () => {
		const { controller, session } = createController();
		await controller.acquire(session.id);
		await controller.onRunnerSucceeded(session.id);

		expect(session.assignmentLease).toMatchObject({
			generation: 1,
			state: "awaiting_pr",
		});
		expect(session.assignmentLease).not.toHaveProperty("releasedAt");
	});

	it("captures the published PR and posts one blind gate per candidate SHA", async () => {
		const { controller, postGate, pipeline, session } = createController();
		await controller.acquire(session.id);
		await controller.onPrPublished({
			sessionId: session.id,
			repositoryId: "repo-1",
			repositoryName: "repo-one",
			repositoryPath: "/repo-one",
			prNumber: 42,
			prUrl: "https://github.test/pr/42",
			headSha: "sha-a",
		});
		await controller.onPrPublished({
			sessionId: session.id,
			repositoryId: "repo-1",
			repositoryName: "repo-one",
			repositoryPath: "/repo-one",
			prNumber: 42,
			prUrl: "https://github.test/pr/42",
			headSha: "sha-a",
		});

		expect(session.assignmentLease).toMatchObject({
			state: "awaiting_gate",
			candidate,
			gateActivityId: "gate-activity-1",
		});
		expect(postGate).toHaveBeenCalledOnce();
		expect(pipeline.review).toHaveBeenCalledWith("RUN-42");
	});

	it("resumes the persisted OMP session for matching needs-rework findings", async () => {
		const { controller, resume, session } = createController();
		await controller.acquire(session.id);
		await controller.onPrPublished({
			sessionId: session.id,
			repositoryId: "repo-1",
			repositoryName: "repo-one",
			repositoryPath: "/repo-one",
			prNumber: 42,
			headSha: "sha-a",
		});

		await controller.reconcile(session.id);

		expect(session.assignmentLease).toMatchObject({
			state: "remediating",
			generation: 1,
			candidate,
		});
		expect(resume).toHaveBeenCalledWith(
			session,
			expect.stringContaining("missing test"),
		);
	});

	it("merges only a SHA-consistent approved candidate and releases on the merge fact", async () => {
		const { controller, pipeline, session } = createController();
		const human = pipeline.readHumanFact as ReturnType<typeof vi.fn>;
		human.mockResolvedValue({
			verdict: "approved",
			head_sha: "sha-a",
			findings: [],
		});
		await controller.acquire(session.id);
		await controller.onPrPublished({
			sessionId: session.id,
			repositoryId: "repo-1",
			repositoryName: "repo-one",
			repositoryPath: "/repo-one",
			prNumber: 42,
			headSha: "sha-a",
		});

		await controller.reconcile(session.id);

		expect(pipeline.integrate).toHaveBeenCalledWith("RUN-42", "/repo-one");
		expect(session.assignmentLease).toMatchObject({
			state: "merged",
			releasedAt: "2026-08-03T16:00:00.000Z",
		});
	});

	it("refuses stale approval before attempting integration", async () => {
		const { controller, pipeline, session } = createController(
			makeSession(),
			makePipeline(),
			"sha-b",
		);
		const human = pipeline.readHumanFact as ReturnType<typeof vi.fn>;
		human.mockResolvedValue({
			verdict: "approved",
			head_sha: "sha-a",
			findings: [],
		});
		await controller.acquire(session.id);
		await controller.onPrPublished({
			sessionId: session.id,
			repositoryId: "repo-1",
			repositoryName: "repo-one",
			repositoryPath: "/repo-one",
			prNumber: 42,
			headSha: "sha-a",
		});

		await controller.reconcile(session.id);

		expect(pipeline.integrate).not.toHaveBeenCalled();
		expect(session.assignmentLease?.state).toBe("awaiting_gate");
	});
});
