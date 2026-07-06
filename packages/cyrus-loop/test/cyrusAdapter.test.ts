import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearCyrusConfigCache,
	findRepo,
	repositories,
	resolveAllowedTools,
	tierFor,
	worktreePath,
} from "../src/cyrusAdapter.js";

// Ported from tests/test_cyrus_adapter.py
const DAILY_YOU_ID = "73813d77-8878-4090-88ac-401788f5c8b4"; // must match config/repo_tiers.json

const CYRUS_CONFIG = {
	repositories: [
		{
			id: DAILY_YOU_ID,
			name: "Daily_You",
			repositoryPath: "/tmp/repos/Daily_You",
			baseBranch: "develop",
			workspaceBaseDir: "/tmp/worktrees",
			allowedTools: ["Read", "Edit", "Bash(flutter *)"],
			labelPrompts: { scoper: { labels: ["PRD"], allowedTools: "readOnly" } },
		},
		{
			id: "other-id",
			name: "bare-repo",
			repositoryPath: "/tmp/repos/bare",
			workspaceBaseDir: "/tmp/worktrees",
		},
	],
};

let prev: string | undefined;

beforeEach(() => {
	prev = process.env.CYRUS_CONFIG;
	const p = join(mkdtempSync(join(tmpdir(), "cyrus-loop-cfg-")), "cyrus.json");
	writeFileSync(p, JSON.stringify(CYRUS_CONFIG));
	process.env.CYRUS_CONFIG = p;
	clearCyrusConfigCache();
});

afterEach(() => {
	if (prev === undefined) delete process.env.CYRUS_CONFIG;
	else process.env.CYRUS_CONFIG = prev;
	clearCyrusConfigCache();
});

describe("cyrusAdapter", () => {
	it("lists repositories and finds by name or id", () => {
		expect(new Set(repositories().map((r) => r.name))).toEqual(
			new Set(["Daily_You", "bare-repo"]),
		);
		expect(findRepo("Daily_You")?.id).toBe(DAILY_YOU_ID);
		expect(findRepo(DAILY_YOU_ID)?.name).toBe("Daily_You");
		expect(findRepo("ghost")).toBeNull();
	});

	it("resolves tier from the side file with a conservative default", () => {
		expect(tierFor("Daily_You")).toBe("feature");
		expect(tierFor("bare-repo")).toBe("feature"); // conservative default
	});

	it("reports the allowedTools boundary in Cyrus resolution order", () => {
		const role = resolveAllowedTools("Daily_You", "scoper");
		expect(role.source).toBe("labelPrompts.scoper.allowedTools");
		expect(role.allowedTools).toBe("readOnly");
		expect(resolveAllowedTools("Daily_You").source).toBe(
			"repository.allowedTools",
		);
		const bare = resolveAllowedTools("bare-repo");
		expect(bare.source).toBe("cyrus_defaults");
		expect(bare.inherits_cyrus_defaults).toBe(true);
	});

	it("resolves the worktree path", () => {
		expect(worktreePath("Daily_You", "DEV-98")).toBe("/tmp/worktrees/DEV-98");
		expect(worktreePath("ghost", "DEV-1")).toBeNull();
	});
});
