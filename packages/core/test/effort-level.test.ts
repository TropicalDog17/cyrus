/**
 * Tests for the reasoning-effort config surface (DEV-174): the shared
 * `EffortLevelSchema` enum and the `effort` / `claudeDefaultEffort` fields it
 * gates on repository, label-prompt, and edge configs.
 */

import { describe, expect, it } from "vitest";
import {
	EdgeConfigSchema,
	EffortLevelSchema,
	RepositoryConfigSchema,
} from "../src/config-schemas.js";

const baseRepo = {
	id: "repo-1",
	name: "My Repo",
	repositoryPath: "/path/to/repo",
	baseBranch: "main",
	workspaceBaseDir: "/ws",
};

describe("EffortLevelSchema", () => {
	it("accepts every supported level", () => {
		for (const level of ["low", "medium", "high", "xhigh", "max"]) {
			expect(EffortLevelSchema.parse(level)).toBe(level);
		}
	});

	it("rejects an unsupported level", () => {
		expect(EffortLevelSchema.safeParse("ultra").success).toBe(false);
	});
});

describe("RepositoryConfigSchema.effort", () => {
	it("accepts a valid effort level", () => {
		const parsed = RepositoryConfigSchema.parse({ ...baseRepo, effort: "max" });
		expect(parsed.effort).toBe("max");
	});

	it("treats effort as optional", () => {
		const parsed = RepositoryConfigSchema.parse(baseRepo);
		expect(parsed.effort).toBeUndefined();
	});

	it("rejects an invalid effort level", () => {
		expect(
			RepositoryConfigSchema.safeParse({ ...baseRepo, effort: "ultra" })
				.success,
		).toBe(false);
	});
});

describe("labelPrompts complex form", () => {
	it("accepts model and effort on a label prompt", () => {
		const parsed = RepositoryConfigSchema.parse({
			...baseRepo,
			labelPrompts: {
				debugger: { labels: ["Bug"], model: "opus", effort: "high" },
			},
		});
		const debuggerConfig = parsed.labelPrompts?.debugger;
		expect(debuggerConfig).toEqual({
			labels: ["Bug"],
			model: "opus",
			effort: "high",
		});
	});

	it("rejects an invalid effort on a label prompt", () => {
		expect(
			RepositoryConfigSchema.safeParse({
				...baseRepo,
				labelPrompts: { debugger: { labels: ["Bug"], effort: "ultra" } },
			}).success,
		).toBe(false);
	});
});

describe("EdgeConfigSchema.claudeDefaultEffort", () => {
	it("accepts a valid default effort", () => {
		const parsed = EdgeConfigSchema.parse({
			repositories: [],
			claudeDefaultEffort: "low",
		});
		expect(parsed.claudeDefaultEffort).toBe("low");
	});

	it("rejects an invalid default effort", () => {
		expect(
			EdgeConfigSchema.safeParse({
				repositories: [],
				claudeDefaultEffort: "ultra",
			}).success,
		).toBe(false);
	});
});
