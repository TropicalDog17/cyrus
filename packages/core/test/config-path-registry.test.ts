import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EdgeConfigSchema,
	RepositoryConfigSchema,
} from "../src/config-schemas.js";
import type { EdgeWorkerConfig } from "../src/config-types.js";
import { normalizeConfigPaths, pathRegistry } from "../src/config-types.js";

/** Enumerate the field names of a schema whose `.shape` entry is path-tagged. */
function taggedShapeKeys(schema: { shape: Record<string, unknown> }): string[] {
	return Object.entries(schema.shape)
		.filter(([, value]) => pathRegistry.has(value as never))
		.map(([key]) => key);
}

describe("config path registry", () => {
	it("tags exactly the 2 top-level path fields", () => {
		expect(taggedShapeKeys(EdgeConfigSchema).sort()).toEqual([
			"githubMcpConfigs",
			"linearMcpConfigs",
		]);
	});

	it("tags exactly the 4 repository path fields", () => {
		expect(taggedShapeKeys(RepositoryConfigSchema).sort()).toEqual([
			"mcpConfigPath",
			"promptTemplatePath",
			"repositoryPath",
			"workspaceBaseDir",
		]);
	});

	it("does NOT tag global_setup_script (deliberately unnormalized today)", () => {
		expect(taggedShapeKeys(EdgeConfigSchema)).not.toContain(
			"global_setup_script",
		);
	});
});

describe("normalizeConfigPaths", () => {
	const home = homedir();

	const baseConfig = (): EdgeWorkerConfig =>
		({
			cyrusHome: "/home/user/.cyrus",
			repositories: [
				{
					id: "r1",
					name: "Repo 1",
					repositoryPath: "~/repo",
					baseBranch: "main",
					workspaceBaseDir: "~/workspaces",
					mcpConfigPath: "~/.cyrus/mcp.json",
					promptTemplatePath: "~/.cyrus/prompt.md",
				},
			],
			linearMcpConfigs: ["~/.cyrus/linear.json"],
			githubMcpConfigs: ["~/.cyrus/github.json"],
			global_setup_script: "~/.cyrus/setup.sh",
		}) as unknown as EdgeWorkerConfig;

	it("expands ~/ for all tagged top-level string[] fields", () => {
		const result = normalizeConfigPaths(baseConfig());
		expect(result.linearMcpConfigs).toEqual([
			resolve(home, ".cyrus/linear.json"),
		]);
		expect(result.githubMcpConfigs).toEqual([
			resolve(home, ".cyrus/github.json"),
		]);
	});

	it("expands ~/ for all tagged repository fields (string + string[])", () => {
		const result = normalizeConfigPaths(baseConfig());
		const repo = result.repositories[0];
		expect(repo.repositoryPath).toBe(resolve(home, "repo"));
		expect(repo.workspaceBaseDir).toBe(resolve(home, "workspaces"));
		expect(repo.mcpConfigPath).toBe(resolve(home, ".cyrus/mcp.json"));
		expect(repo.promptTemplatePath).toBe(resolve(home, ".cyrus/prompt.md"));
	});

	it("expands ~/ for a repository mcpConfigPath supplied as an array", () => {
		const config = baseConfig();
		config.repositories[0].mcpConfigPath = ["~/a.json", "~/b.json"];
		const result = normalizeConfigPaths(config);
		expect(result.repositories[0].mcpConfigPath).toEqual([
			resolve(home, "a.json"),
			resolve(home, "b.json"),
		]);
	});

	it("leaves non-path fields (e.g. global_setup_script) untouched", () => {
		const result = normalizeConfigPaths(baseConfig());
		expect(result.global_setup_script).toBe("~/.cyrus/setup.sh");
	});

	it("does not mutate the input config", () => {
		const config = baseConfig();
		normalizeConfigPaths(config);
		expect(config.repositories[0].repositoryPath).toBe("~/repo");
		expect(config.linearMcpConfigs).toEqual(["~/.cyrus/linear.json"]);
	});
});

describe("json-schema export guard", () => {
	it("path registration does not alter EdgeConfig JSON Schema output", () => {
		// Guard for json-schema-export.test.ts: a dedicated registry must NOT
		// inject the tag into toJSONSchema properties.
		const schema = EdgeConfigSchema.toJSONSchema({
			target: "draft-2020-12",
		}) as { properties: Record<string, Record<string, unknown>> };
		for (const field of ["linearMcpConfigs", "githubMcpConfigs"]) {
			expect(schema.properties[field]).not.toHaveProperty("path");
		}
	});
});
