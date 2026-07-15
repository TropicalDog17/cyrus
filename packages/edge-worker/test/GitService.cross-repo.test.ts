import { execSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Issue, RepositoryConfig } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CROSS_REPO_DIR, GitService } from "../src/GitService.js";

// Real-filesystem, real-git integration test for cross-repo sibling symlinks.
// The behavior under test (symlink creation + git-exclude) is inherently
// filesystem-heavy, so this file intentionally does NOT mock node:fs or git —
// unlike the mock-driven GitService.test.ts.

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

function initRepo(path: string, markerFile: string): void {
	mkdirSync(path, { recursive: true });
	execSync("git init -b main", { cwd: path, stdio: "ignore", env: gitEnv });
	writeFileSync(join(path, markerFile), `marker for ${markerFile}\n`);
	execSync("git add -A", { cwd: path, stdio: "ignore", env: gitEnv });
	execSync("git commit -m init", { cwd: path, stdio: "ignore", env: gitEnv });
}

function makeIssue(identifier: string): Issue {
	return {
		id: `id-${identifier}`,
		identifier,
		title: "Cross repo test",
		branchName: `${identifier.toLowerCase()}-cross-repo`,
		labels: async () => ({ nodes: [] }),
		parent: Promise.resolve(undefined),
		inverseRelations: async () => ({ nodes: [] }),
	} as unknown as Issue;
}

function makeRepo(
	root: string,
	name: string,
	worktreesDir: string,
	overrides: Partial<RepositoryConfig> = {},
): RepositoryConfig {
	return {
		id: name,
		name,
		repositoryPath: join(root, name),
		baseBranch: "main",
		workspaceBaseDir: join(worktreesDir, name),
		readParentDirectory: true,
		...overrides,
	} as RepositoryConfig;
}

describe("GitService cross-repo sibling symlinks", () => {
	let base: string;
	let reposDir: string;
	let worktreesDir: string;
	let gitService: GitService;

	beforeEach(() => {
		base = mkdtempSync(join(tmpdir(), "cyrus-cross-repo-"));
		reposDir = join(base, "repos");
		worktreesDir = join(base, "worktrees");
		mkdirSync(reposDir, { recursive: true });
		mkdirSync(worktreesDir, { recursive: true });
		gitService = new GitService({ cyrusHome: join(base, "cyrus-home") });
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it("links sibling repos sharing the readable parent, excluding self", async () => {
		initRepo(join(reposDir, "backend"), "BACKEND.md");
		initRepo(join(reposDir, "indexer"), "INDEXER.md");

		const backend = makeRepo(reposDir, "backend", worktreesDir);
		const indexer = makeRepo(reposDir, "indexer", worktreesDir);

		const workspace = await gitService.createGitWorktree(
			makeIssue("DEV-1"),
			[backend],
			{ crossRepoSiblingRepositories: [backend, indexer] },
		);

		expect(workspace.isGitWorktree).toBe(true);

		const linkDir = join(workspace.path, CROSS_REPO_DIR);
		const indexerLink = join(linkDir, "indexer");
		expect(lstatSync(indexerLink).isSymbolicLink()).toBe(true);
		expect(realpathSync(indexerLink)).toBe(
			realpathSync(indexer.repositoryPath),
		);
		// The sibling checkout is readable through the link.
		expect(readFileSync(join(indexerLink, "INDEXER.md"), "utf-8")).toContain(
			"marker",
		);
		// The routed repo never links to itself.
		expect(existsSync(join(linkDir, "backend"))).toBe(false);
	});

	it("keeps the link directory out of git status via the worktree exclude", async () => {
		initRepo(join(reposDir, "backend"), "BACKEND.md");
		initRepo(join(reposDir, "indexer"), "INDEXER.md");

		const backend = makeRepo(reposDir, "backend", worktreesDir);
		const indexer = makeRepo(reposDir, "indexer", worktreesDir);

		const workspace = await gitService.createGitWorktree(
			makeIssue("DEV-2"),
			[backend],
			{ crossRepoSiblingRepositories: [backend, indexer] },
		);

		const status = execSync("git status --porcelain", {
			cwd: workspace.path,
			encoding: "utf-8",
			env: gitEnv,
		});
		expect(status).not.toContain(CROSS_REPO_DIR);
	});

	it("does not link when the routed repo lacks readParentDirectory", async () => {
		initRepo(join(reposDir, "backend"), "BACKEND.md");
		initRepo(join(reposDir, "indexer"), "INDEXER.md");

		const backend = makeRepo(reposDir, "backend", worktreesDir, {
			readParentDirectory: false,
		});
		const indexer = makeRepo(reposDir, "indexer", worktreesDir);

		const workspace = await gitService.createGitWorktree(
			makeIssue("DEV-3"),
			[backend],
			{ crossRepoSiblingRepositories: [backend, indexer] },
		);

		expect(existsSync(join(workspace.path, CROSS_REPO_DIR))).toBe(false);
	});

	it("does not link repos that live under a different parent directory", async () => {
		initRepo(join(reposDir, "backend"), "BACKEND.md");
		const otherDir = join(base, "other-org");
		mkdirSync(otherDir, { recursive: true });
		initRepo(join(otherDir, "unrelated"), "UNRELATED.md");

		const backend = makeRepo(reposDir, "backend", worktreesDir);
		const unrelated = makeRepo(otherDir, "unrelated", worktreesDir);

		const workspace = await gitService.createGitWorktree(
			makeIssue("DEV-4"),
			[backend],
			{ crossRepoSiblingRepositories: [backend, unrelated] },
		);

		expect(existsSync(join(workspace.path, CROSS_REPO_DIR))).toBe(false);
	});

	it("skips linking entirely when no sibling list is provided", async () => {
		initRepo(join(reposDir, "backend"), "BACKEND.md");
		const backend = makeRepo(reposDir, "backend", worktreesDir);

		const workspace = await gitService.createGitWorktree(makeIssue("DEV-5"), [
			backend,
		]);

		expect(existsSync(join(workspace.path, CROSS_REPO_DIR))).toBe(false);
	});
});
