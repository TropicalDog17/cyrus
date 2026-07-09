import type { EdgeWorkerConfig, ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../src/ConfigManager.js";

/**
 * Tests for CYPACK-1273: ensure the `prReviewTrigger` flag participates in
 * the config hot-reload pipeline. Rewritten onto the schema-driven
 * `reconcile(prev, disk)` (Phase A decomposition) — the old
 * `loadConfigSafely` / `detectGlobalConfigChanges` internals it used to poke
 * were replaced by `reconcile`, which owns merge + diff.
 */
describe("ConfigManager - prReviewTrigger hot-reload (CYPACK-1273)", () => {
	let logger: ILogger;

	const baseConfig: EdgeWorkerConfig = {
		proxyUrl: "http://localhost:3000",
		cyrusHome: "/tmp/cyrus-home",
		repositories: [
			{
				id: "repo-1",
				name: "Repo 1",
				repositoryPath: "/test/repo",
				baseBranch: "main",
				workspaceBaseDir: "/test/workspaces",
			},
		],
	} as unknown as EdgeWorkerConfig;

	function makeManager(config: EdgeWorkerConfig): ConfigManager {
		return new ConfigManager(
			config,
			logger,
			"/tmp/cyrus-home/config.json",
			new Map(config.repositories.map((r) => [r.id, r])),
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as unknown as ILogger;
	});

	it("merges prReviewTrigger:false from the reloaded config file", () => {
		const manager = makeManager(baseConfig);

		const result = manager.reconcile(baseConfig, {
			repositories: baseConfig.repositories,
			prReviewTrigger: false,
		});

		expect(result.merged.prReviewTrigger).toBe(false);
	});

	it("detects a prReviewTrigger change via changedKeys", () => {
		const manager = makeManager(baseConfig);

		const result = manager.reconcile(baseConfig, {
			...baseConfig,
			prReviewTrigger: false,
		});

		expect(result.changedKeys.has("prReviewTrigger")).toBe(true);
	});

	it("preserves an existing prReviewTrigger value when the file omits it", () => {
		const prev = { ...baseConfig, prReviewTrigger: false };
		const manager = makeManager(prev);

		const result = manager.reconcile(prev, {
			repositories: baseConfig.repositories,
		});

		expect(result.merged.prReviewTrigger).toBe(false);
	});
});
