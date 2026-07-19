import { homedir } from "node:os";
import { resolve } from "node:path";
import type { EdgeWorkerConfig, ILogger, RepositoryConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../src/ConfigManager.js";

/**
 * Phase A decomposition: `ConfigManager.reconcile(prev, disk)` replaces the
 * 19-field merge whitelist (`loadConfigSafely`) and the hardcoded `globalKeys`
 * diff array (`detectGlobalConfigChanges`) with a uniform, schema-driven
 * nullish merge + generic diff + registry-driven path normalization.
 */
describe("ConfigManager.reconcile", () => {
	const home = homedir();
	let logger: ILogger;

	const repo = (overrides: Partial<RepositoryConfig> = {}): RepositoryConfig =>
		({
			id: "repo-1",
			name: "Repo 1",
			repositoryPath: "/test/repo",
			baseBranch: "main",
			workspaceBaseDir: "/test/workspaces",
			...overrides,
		}) as RepositoryConfig;

	const prevConfig = (
		overrides: Partial<EdgeWorkerConfig> = {},
	): EdgeWorkerConfig =>
		({
			proxyUrl: "http://localhost:3000",
			cyrusHome: "/tmp/cyrus-home",
			repositories: [repo()],
			...overrides,
		}) as unknown as EdgeWorkerConfig;

	function makeManager(config: EdgeWorkerConfig): ConfigManager {
		return new ConfigManager(
			config,
			logger,
			"/tmp/cyrus-home/config.json",
			new Map((config.repositories ?? []).map((r) => [r.id, r])),
		);
	}

	beforeEach(() => {
		logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as unknown as ILogger;
	});

	// (1) uniform merge picks up fields the old whitelist never merged.
	it("merges previously-undetected fields (userAccessControl, global_setup_script) and reports them in changedKeys", () => {
		const prev = prevConfig();
		const manager = makeManager(prev);

		const result = manager.reconcile(prev, {
			repositories: prev.repositories,
			userAccessControl: { blockedUsers: ["usr_bad"] },
			global_setup_script: "/opt/setup.sh",
		});

		expect(result.merged.userAccessControl).toEqual({
			blockedUsers: ["usr_bad"],
		});
		expect(result.merged.global_setup_script).toBe("/opt/setup.sh");
		expect(result.changedKeys.has("userAccessControl")).toBe(true);
		expect(result.changedKeys.has("global_setup_script")).toBe(true);
	});

	it("merges claudeSessionKeepAliveMinutes, honoring a disk 0 as an opt-out", () => {
		const prev = prevConfig({
			claudeSessionKeepAliveMinutes: 50,
		} as Partial<EdgeWorkerConfig>);
		const manager = makeManager(prev);

		const result = manager.reconcile(prev, {
			repositories: prev.repositories,
			claudeSessionKeepAliveMinutes: 0,
		});

		// `0` disables keep-alive; a `||` merge would have silently kept 50.
		expect(result.merged.claudeSessionKeepAliveMinutes).toBe(0);
		expect(result.changedKeys.has("claudeSessionKeepAliveMinutes")).toBe(true);
	});

	it("merges claudeMaxWarmIdleSessions and flags it as a changed key", () => {
		const prev = prevConfig({
			claudeMaxWarmIdleSessions: 0,
		} as Partial<EdgeWorkerConfig>);
		const manager = makeManager(prev);

		const result = manager.reconcile(prev, {
			repositories: prev.repositories,
			claudeMaxWarmIdleSessions: 10,
		});

		expect(result.merged.claudeMaxWarmIdleSessions).toBe(10);
		expect(result.changedKeys.has("claudeMaxWarmIdleSessions")).toBe(true);
	});

	// (2) nullish semantics — falsy disk values are honored, not overwritten.
	it("honors falsy disk values (false, empty array) via ?? not ||", () => {
		const prev = prevConfig({
			prReviewTrigger: true,
			issueUpdateTrigger: true,
			linearAllowedTools: ["Read", "Edit"],
		} as Partial<EdgeWorkerConfig>);
		const manager = makeManager(prev);

		const result = manager.reconcile(prev, {
			repositories: prev.repositories,
			prReviewTrigger: false,
			issueUpdateTrigger: false,
			linearAllowedTools: [],
		});

		expect(result.merged.prReviewTrigger).toBe(false);
		expect(result.merged.issueUpdateTrigger).toBe(false);
		// [] clears the allowlist (would have inherited old under `||`).
		expect(result.merged.linearAllowedTools).toEqual([]);
		expect(result.changedKeys.has("linearAllowedTools")).toBe(true);
	});

	// (3) omitted field preserves prev value.
	it("preserves a prev value when disk omits the field", () => {
		const prev = prevConfig({
			claudeDefaultModel: "opus",
		} as Partial<EdgeWorkerConfig>);
		const manager = makeManager(prev);

		const result = manager.reconcile(prev, {
			repositories: prev.repositories,
		});

		expect(result.merged.claudeDefaultModel).toBe("opus");
		expect(result.changedKeys.has("claudeDefaultModel")).toBe(false);
	});

	// (4) legacy rename map + migrateEdgeConfig fold.
	it("applies the legacy defaultModel -> claudeDefaultModel rename", () => {
		const prev = prevConfig();
		const manager = makeManager(prev);

		const result = manager.reconcile(prev, {
			repositories: prev.repositories,
			defaultModel: "opus",
		});

		expect(result.merged.claudeDefaultModel).toBe("opus");
	});

	it("folds defaultAllowedTools into linearAllowedTools via migrateEdgeConfig", () => {
		const prev = prevConfig();
		const manager = makeManager(prev);

		const result = manager.reconcile(prev, {
			repositories: prev.repositories,
			defaultAllowedTools: ["Read", "Bash"],
		});

		expect(result.merged.linearAllowedTools).toEqual(["Read", "Bash"]);
	});

	// (5) path normalization — top-level + per-repo, string + array.
	it("normalizes tilde paths at top level and per repo", () => {
		const prev = prevConfig();
		const manager = makeManager(prev);

		const result = manager.reconcile(prev, {
			repositories: [
				repo({
					repositoryPath: "~/repo",
					workspaceBaseDir: "~/workspaces",
					mcpConfigPath: ["~/a.json", "~/b.json"],
					promptTemplatePath: "~/prompt.md",
				}),
			],
			linearMcpConfigs: ["~/.cyrus/x.json"],
		});

		expect(result.merged.linearMcpConfigs).toEqual([
			resolve(home, ".cyrus/x.json"),
		]);
		const mergedRepo = result.merged.repositories[0];
		expect(mergedRepo.repositoryPath).toBe(resolve(home, "repo"));
		expect(mergedRepo.workspaceBaseDir).toBe(resolve(home, "workspaces"));
		expect(mergedRepo.mcpConfigPath).toEqual([
			resolve(home, "a.json"),
			resolve(home, "b.json"),
		]);
		expect(mergedRepo.promptTemplatePath).toBe(resolve(home, "prompt.md"));
	});

	// (6) idempotent — disk equals prev yields no changes.
	it("reports no changedKeys and no repo changes when disk equals prev", () => {
		const prev = prevConfig({
			claudeDefaultModel: "opus",
		} as Partial<EdgeWorkerConfig>);
		const manager = makeManager(prev);

		const result = manager.reconcile(prev, {
			repositories: prev.repositories,
			claudeDefaultModel: "opus",
		});

		expect(result.changedKeys.size).toBe(0);
		expect(result.repositoryChanges.added).toHaveLength(0);
		expect(result.repositoryChanges.modified).toHaveLength(0);
		expect(result.repositoryChanges.removed).toHaveLength(0);
	});

	// (7) repository add / modify / remove diff against the live map.
	it("detects repository add/modify/remove against the live repositories map", () => {
		const prev = prevConfig({
			repositories: [repo({ id: "keep" }), repo({ id: "drop" })],
		});
		const manager = makeManager(prev);

		const result = manager.reconcile(prev, {
			repositories: [
				repo({ id: "keep", baseBranch: "develop" }), // modified
				repo({ id: "new" }), // added
				// "drop" removed
			],
		});

		expect(result.repositoryChanges.added.map((r) => r.id)).toEqual(["new"]);
		expect(result.repositoryChanges.modified.map((r) => r.id)).toEqual([
			"keep",
		]);
		expect(result.repositoryChanges.removed.map((r) => r.id)).toEqual(["drop"]);
	});

	// (8) invalid repo throws.
	it("throws when a repository is missing required fields", () => {
		const prev = prevConfig();
		const manager = makeManager(prev);

		expect(() =>
			manager.reconcile(prev, {
				repositories: [{ id: "bad", name: "Bad", repositoryPath: "/x" }],
			}),
		).toThrow(/missing required fields/);
	});

	it("throws when repositories is present but not an array", () => {
		const prev = prevConfig();
		const manager = makeManager(prev);

		expect(() => manager.reconcile(prev, { repositories: "nope" })).toThrow(
			/repositories must be an array/,
		);
	});

	it("preserves prev repositories when disk omits the key entirely", () => {
		const prev = prevConfig();
		const manager = makeManager(prev);

		const result = manager.reconcile(prev, { prReviewTrigger: false });

		expect(result.merged.repositories).toHaveLength(1);
		expect(result.repositoryChanges.removed).toHaveLength(0);
	});
});

/**
 * Phase A A7 decomposition: ConfigManager also *applies* repository-config
 * diffs (add/modify/remove) to the shared repositories map and computes
 * workspace-token diffs. EdgeWorker retains only the live-object wiring
 * (issue trackers, activity sinks, sessions).
 */
describe("ConfigManager apply* methods", () => {
	let logger: ILogger;

	const repo = (overrides: Partial<RepositoryConfig> = {}): RepositoryConfig =>
		({
			id: "repo-1",
			name: "Repo 1",
			repositoryPath: "/test/repo",
			baseBranch: "main",
			workspaceBaseDir: "/test/workspaces",
			...overrides,
		}) as RepositoryConfig;

	beforeEach(() => {
		logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as unknown as ILogger;
	});

	function makeManager(
		repositories: Map<string, RepositoryConfig>,
		config: EdgeWorkerConfig = {
			repositories: [],
		} as unknown as EdgeWorkerConfig,
	): ConfigManager {
		return new ConfigManager(config, logger, undefined, repositories);
	}

	describe("applyAddedRepositories", () => {
		it("adds active repositories to the map", () => {
			const repositories = new Map<string, RepositoryConfig>();
			const manager = makeManager(repositories);

			manager.applyAddedRepositories([repo({ id: "new-1" })]);

			expect(repositories.get("new-1")).toBeDefined();
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Adding repository"),
			);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("added successfully"),
			);
		});

		it("skips inactive repositories with a log, leaving the map untouched", () => {
			const repositories = new Map<string, RepositoryConfig>();
			const manager = makeManager(repositories);

			manager.applyAddedRepositories([
				repo({ id: "inactive-1", isActive: false }),
			]);

			expect(repositories.has("inactive-1")).toBe(false);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Skipping inactive repository"),
			);
		});
	});

	describe("applyModifiedRepositories", () => {
		it("replaces an existing entry in the map", () => {
			const existing = repo({ id: "repo-1", baseBranch: "main" });
			const repositories = new Map<string, RepositoryConfig>([
				["repo-1", existing],
			]);
			const manager = makeManager(repositories);
			const updated = repo({ id: "repo-1", baseBranch: "develop" });

			manager.applyModifiedRepositories([updated]);

			expect(repositories.get("repo-1")).toEqual(updated);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("updated successfully"),
			);
		});

		it("warns and skips when the repo id is not already in the map", () => {
			const repositories = new Map<string, RepositoryConfig>();
			const manager = makeManager(repositories);

			manager.applyModifiedRepositories([repo({ id: "missing" })]);

			expect(repositories.has("missing")).toBe(false);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("not found for update"),
			);
		});

		it("logs the active-status transition when isActive changes", () => {
			const existing = repo({ id: "repo-1", isActive: true });
			const repositories = new Map<string, RepositoryConfig>([
				["repo-1", existing],
			]);
			const manager = makeManager(repositories);

			manager.applyModifiedRepositories([
				repo({ id: "repo-1", isActive: false }),
			]);

			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Repository set to inactive"),
			);
		});
	});

	describe("applyRemovedRepositories", () => {
		it("deletes the repository from the map", () => {
			const existing = repo({ id: "repo-1" });
			const repositories = new Map<string, RepositoryConfig>([
				["repo-1", existing],
			]);
			const manager = makeManager(repositories);

			manager.applyRemovedRepositories([existing]);

			expect(repositories.has("repo-1")).toBe(false);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Removing repository"),
			);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("removed successfully"),
			);
		});
	});

	describe("computeWorkspaceTokenChanges", () => {
		it("returns an entry for each workspace whose token changed", () => {
			const config = {
				repositories: [],
				linearWorkspaces: {
					"workspace-1": { linearToken: "old-token" },
					"workspace-2": { linearToken: "unchanged-token" },
				},
			} as unknown as EdgeWorkerConfig;
			const manager = makeManager(new Map(), config);

			const newConfig = {
				repositories: [],
				linearWorkspaces: {
					"workspace-1": { linearToken: "new-token" },
					"workspace-2": { linearToken: "unchanged-token" },
				},
			} as unknown as EdgeWorkerConfig;

			const changes = manager.computeWorkspaceTokenChanges(newConfig);

			expect(changes).toEqual([
				{ workspaceId: "workspace-1", newToken: "new-token" },
			]);
		});

		it("returns an empty array when no tokens changed", () => {
			const config = {
				repositories: [],
				linearWorkspaces: {
					"workspace-1": { linearToken: "same-token" },
				},
			} as unknown as EdgeWorkerConfig;
			const manager = makeManager(new Map(), config);

			const changes = manager.computeWorkspaceTokenChanges({
				...config,
			});

			expect(changes).toEqual([]);
		});

		it("reads the OLD config held by ConfigManager, not the new config passed in", () => {
			const config = {
				repositories: [],
				linearWorkspaces: {
					"workspace-1": { linearToken: "old-token" },
				},
			} as unknown as EdgeWorkerConfig;
			const manager = makeManager(new Map(), config);

			// Simulate the pre-reconcile invariant: computeWorkspaceTokenChanges
			// must be called BEFORE setConfig(newConfig) to see a real diff.
			const newConfig = {
				repositories: [],
				linearWorkspaces: {
					"workspace-1": { linearToken: "new-token" },
				},
			} as unknown as EdgeWorkerConfig;

			const beforeSetConfig = manager.computeWorkspaceTokenChanges(newConfig);
			manager.setConfig(newConfig);
			const afterSetConfig = manager.computeWorkspaceTokenChanges(newConfig);

			expect(beforeSetConfig).toEqual([
				{ workspaceId: "workspace-1", newToken: "new-token" },
			]);
			expect(afterSetConfig).toEqual([]);
		});
	});
});
