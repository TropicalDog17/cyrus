import { beforeEach, describe, expect, it } from "vitest";
import { composeEdgeWorker, type EdgeWorker } from "../src/EdgeWorker";
import type { EdgeWorkerConfig } from "../src/types";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

/**
 * Regression tests for `resolveSkillRepoPaths`, which decides whose
 * `.claude/skills/` directories feed the per-session skill allow-list.
 *
 * The allow-list source MUST match the Agent SDK's cwd (the session worktree),
 * otherwise repo-committed skills load in the worktree but get rejected as
 * "not in this session's skills allowlist". See cyrusagents/cyrus#1336.
 */
describe("EdgeWorker.resolveSkillRepoPaths", () => {
	let edgeWorker: EdgeWorker;

	const repository = {
		id: "test-repo",
		name: "test-repo",
		// Stale base clone — Cyrus only fetches into it, never advances its tree.
		repositoryPath: "/test/repos/test-repo",
		workspaceBaseDir: "/test/workspaces",
		linearWorkspaceId: "test-workspace",
		baseBranch: "main",
	};

	function makeSession(workspace: Record<string, unknown>) {
		return { workspace };
	}

	function resolve(session?: unknown): string[] {
		// resolveSkillRepoPaths is private; probe it directly.
		return (
			edgeWorker as unknown as {
				resolveSkillRepoPaths: (r: unknown, s?: unknown) => string[];
			}
		).resolveSkillRepoPaths(repository, session);
	}

	beforeEach(() => {
		const config: EdgeWorkerConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [repository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		} as unknown as EdgeWorkerConfig;
		edgeWorker = composeEdgeWorker(config);
	});

	it("uses the session worktree (SDK cwd), not the stale base clone, for single-repo sessions", () => {
		const worktreePath = "/test/workspaces/TEST-1";
		const session = makeSession({ path: worktreePath, isGitWorktree: true });
		expect(resolve(session)).toEqual([worktreePath]);
	});

	it("uses every sub-worktree for multi-repo sessions (unchanged)", () => {
		const session = makeSession({
			path: "/test/workspaces/TEST-2",
			isGitWorktree: true,
			repoPaths: {
				"repo-a": "/test/workspaces/TEST-2/repo-a",
				"repo-b": "/test/workspaces/TEST-2/repo-b",
			},
		});
		expect(resolve(session)).toEqual([
			"/test/workspaces/TEST-2/repo-a",
			"/test/workspaces/TEST-2/repo-b",
		]);
	});

	it("falls back to the repository path when there is no session", () => {
		expect(resolve(undefined)).toEqual([repository.repositoryPath]);
	});

	it("falls back to the repository path when the worktree path is empty", () => {
		const session = makeSession({ path: "", isGitWorktree: false });
		expect(resolve(session)).toEqual([repository.repositoryPath]);
	});
});
