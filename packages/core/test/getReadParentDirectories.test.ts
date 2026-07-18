import { describe, expect, it } from "vitest";
import {
	getReadParentDirectories,
	type RepositoryConfig,
} from "../src/config-schemas.js";

/**
 * `getReadParentDirectories` is the single source of truth for the opt-in
 * per-repo read expansion. All session paths (new, resumed, pre-warmed) route
 * through it, so its behavior defines the feature's read scope.
 */

function repo(
	overrides: Partial<RepositoryConfig> & { repositoryPath: string },
): RepositoryConfig {
	return {
		id: "repo",
		name: "repo",
		baseBranch: "main",
		workspaceBaseDir: "/home/dev/.cyrus/workspaces",
		...overrides,
	} as RepositoryConfig;
}

describe("getReadParentDirectories", () => {
	it("returns the parent directory for a repo with readParentDirectory set", () => {
		expect(
			getReadParentDirectories([
				repo({
					repositoryPath: "/home/dev/projects/life-wallet-backend",
					readParentDirectory: true,
				}),
			]),
		).toEqual(["/home/dev/projects"]);
	});

	it("returns nothing for a repo without the flag", () => {
		expect(
			getReadParentDirectories([
				repo({ repositoryPath: "/home/dev/other/service-api" }),
			]),
		).toEqual([]);
	});

	it("treats readParentDirectory: false the same as unset", () => {
		expect(
			getReadParentDirectories([
				repo({
					repositoryPath: "/home/dev/other/service-api",
					readParentDirectory: false,
				}),
			]),
		).toEqual([]);
	});

	it("includes only the flagged repos in a mixed multi-repo set", () => {
		expect(
			getReadParentDirectories([
				repo({
					repositoryPath: "/home/dev/projects/life-wallet-backend",
					readParentDirectory: true,
				}),
				repo({ repositoryPath: "/home/dev/other/service-api" }),
			]),
		).toEqual(["/home/dev/projects"]);
	});

	it("deduplicates when several flagged repos share a parent", () => {
		expect(
			getReadParentDirectories([
				repo({
					repositoryPath: "/home/dev/projects/backend",
					readParentDirectory: true,
				}),
				repo({
					repositoryPath: "/home/dev/projects/frontend",
					readParentDirectory: true,
				}),
			]),
		).toEqual(["/home/dev/projects"]);
	});

	it("returns an empty list for no repositories", () => {
		expect(getReadParentDirectories([])).toEqual([]);
	});
});
