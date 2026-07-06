import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CaptureDeps,
	CYRUS_PR_MARKER,
	captureEvidence,
	isCyrusPr,
	issueIdFromBranch,
	type PullRequest,
	prMetaPath,
	readPrMeta,
	runIdForPr,
	shouldCapture,
} from "../src/capture.js";
import { recordHumanVerdict } from "../src/gate.js";
import { dataDir, ledgerFile } from "../src/paths.js";

// Ported from tests/test_pr_watch.py (poll functions dropped — event-driven)

let prev: string | undefined;
beforeEach(() => {
	prev = process.env.AGENTIC_PIPELINE_DATA;
	process.env.AGENTIC_PIPELINE_DATA = mkdtempSync(
		join(tmpdir(), "cyrus-loop-cap-"),
	);
});
afterEach(() => {
	if (prev === undefined) delete process.env.AGENTIC_PIPELINE_DATA;
	else process.env.AGENTIC_PIPELINE_DATA = prev;
});

function diffPath(rid: string): string {
	return join(dataDir(), "diffs", `${rid}.diff`);
}
function seedCaptured(rid: string, headSha: string): void {
	mkdirSync(join(dataDir(), "diffs"), { recursive: true });
	writeFileSync(diffPath(rid), "DIFF\n");
	writeFileSync(ledgerFile(rid), "{}\n");
	writeFileSync(prMetaPath(rid), JSON.stringify({ head_sha: headSha }));
}
function cyrusPr(opts: { number?: number; sha?: string } = {}): PullRequest {
	return {
		number: opts.number ?? 7,
		headRefName: "me/dev-123-fix",
		createdAt: "2026-07-05T10:00:00Z",
		headRefOid: opts.sha ?? "abc123",
		baseRefName: "main",
		url: "https://example/pr/7",
		body: CYRUS_PR_MARKER,
	};
}

describe("pure mapping helpers", () => {
	it.each([
		["me/dev-123-fix-the-thing", "DEV-123"],
		["DEV-123-add-thing", "DEV-123"],
		["user/sub/eng-9-x", "ENG-9"],
		["john-5smith/dev-12-x", "DEV-12"],
		["feature/JIRA-100", "JIRA-100"],
		["main", null],
		["feature/no-ident-here", null],
		["", null],
	])("issueIdFromBranch(%s) → %s", (branch, expected) => {
		expect(issueIdFromBranch(branch as string)).toBe(expected);
	});

	it("runIdForPr folds in the created date and PR number", () => {
		expect(
			runIdForPr({
				headRefName: "me/dev-123-x",
				createdAt: "2026-07-05T10:11:12Z",
				number: 482,
			}),
		).toEqual(["2026-07-05-DEV-123-pr482", "DEV-123"]);
	});

	it("runIdForPr returns null when underivable", () => {
		expect(
			runIdForPr({
				headRefName: "main",
				createdAt: "2026-07-05T00:00:00Z",
				number: 1,
			}),
		).toBeNull();
		expect(
			runIdForPr({ headRefName: "me/dev-1-x", createdAt: "", number: 1 }),
		).toBeNull();
		expect(
			runIdForPr({
				headRefName: "me/dev-1-x",
				createdAt: "2026-07-05T00:00:00Z",
			}),
		).toBeNull();
	});

	it("isCyrusPr detects the marker", () => {
		expect(isCyrusPr({ body: `summary\n\n${CYRUS_PR_MARKER}` })).toBe(true);
		expect(isCyrusPr({ body: "no marker here" })).toBe(false);
		expect(isCyrusPr({ body: undefined })).toBe(false);
	});
});

describe("shouldCapture", () => {
	it("captures a new PR", () => {
		const { capture, reason } = shouldCapture("2026-07-05-DEV-1", "abc");
		expect(capture).toBe(true);
		expect(reason).toBe("new");
	});

	it("skips the same head SHA", () => {
		seedCaptured("2026-07-05-DEV-2", "abc");
		const { capture, reason } = shouldCapture("2026-07-05-DEV-2", "abc");
		expect(capture).toBe(false);
		expect(reason).toContain("already captured");
	});

	it("recaptures on head advance", () => {
		seedCaptured("2026-07-05-DEV-3", "abc");
		const { capture, reason } = shouldCapture("2026-07-05-DEV-3", "def");
		expect(capture).toBe(true);
		expect(reason).toContain("head advanced");
	});

	it("locks after a human verdict with no bound SHA", () => {
		const rid = "2026-07-05-DEV-4";
		seedCaptured(rid, "abc");
		recordHumanVerdict(rid, "approved", []); // no head_sha → locks conservatively
		const { capture, reason } = shouldCapture(rid, "def");
		expect(capture).toBe(false);
		expect(reason).toContain("locked");
	});

	it("locks when the verdict SHA matches", () => {
		const rid = "2026-07-05-DEV-40";
		seedCaptured(rid, "abc");
		recordHumanVerdict(rid, "approved", [], { headSha: "abc" });
		const { capture, reason } = shouldCapture(rid, "abc");
		expect(capture).toBe(false);
		expect(reason).toContain("locked");
	});

	it("supersedes when the verdict SHA differs (deadlock fix)", () => {
		const rid = "2026-07-05-DEV-41";
		seedCaptured(rid, "abc");
		recordHumanVerdict(rid, "approved", [], { headSha: "abc" });
		const { capture, reason } = shouldCapture(rid, "def");
		expect(capture).toBe(true);
		expect(reason).toContain("superseded");
	});

	it("skips the same head SHA even without a ledger (gh-pr-diff fallback)", () => {
		const rid = "2026-07-05-DEV-8";
		mkdirSync(join(dataDir(), "diffs"), { recursive: true });
		writeFileSync(diffPath(rid), "DIFF\n");
		writeFileSync(prMetaPath(rid), JSON.stringify({ head_sha: "abc" }));
		const { capture, reason } = shouldCapture(rid, "abc");
		expect(capture).toBe(false);
		expect(reason).toContain("already captured");
	});
});

describe("captureEvidence", () => {
	function stubDeps(): { deps: CaptureDeps; wt: string } {
		const wt = mkdtempSync(join(tmpdir(), "cyrus-loop-wt-"));
		const deps: CaptureDeps = {
			worktreePath: () => wt,
			run: () => ({ status: 0, stdout: "DIFF\n", stderr: "" }),
			resolveBaseRef: (_repoDir, base) => (base ? `origin/${base}` : null),
			runLedger: (runId) => {
				writeFileSync(ledgerFile(runId), "{}\n");
				return { mechanical: "pass" };
			},
		};
		return { deps, wt };
	}

	it("writes diff + ledger + meta", async () => {
		const { deps } = stubDeps();
		const res = await captureEvidence("Daily_You", "/repo", cyrusPr(), deps);
		const rid = "2026-07-05-DEV-123-pr7";
		expect(res.captured).toBe(true);
		expect(res.run_id).toBe(rid);
		expect(res.ran_ledger).toBe(true);
		expect(readFileSync(diffPath(rid), "utf-8")).toBe("DIFF\n");
		const meta = readPrMeta(rid)!;
		expect(meta.number).toBe(7);
		expect(meta.head_sha).toBe("abc123");
		expect(meta.base).toBe("main");
		expect(meta.repo).toBe("Daily_You");
	});

	it("is idempotent at the same head SHA", async () => {
		const { deps } = stubDeps();
		await captureEvidence(
			"Daily_You",
			"/repo",
			cyrusPr({ sha: "abc123" }),
			deps,
		);
		const res2 = await captureEvidence(
			"Daily_You",
			"/repo",
			cyrusPr({ sha: "abc123" }),
			deps,
		);
		expect(res2.captured).toBe(false);
		expect(res2.reason).toContain("already captured");
	});

	it("builds an ephemeral worktree and runs the ledger when there is no live worktree", async () => {
		let ran = false;
		const deps: CaptureDeps = {
			worktreePath: () => null,
			run: () => ({ status: 0, stdout: "DIFF\n", stderr: "" }),
			resolveBaseRef: () => "origin/main",
			runLedger: () => {
				ran = true;
			},
		};
		const r1 = await captureEvidence(
			"Daily_You",
			"/repo",
			cyrusPr({ sha: "abc123" }),
			deps,
		);
		expect(r1.captured).toBe(true);
		expect(r1.ran_ledger).toBe(true);
		expect(ran).toBe(true);
		const r2 = await captureEvidence(
			"Daily_You",
			"/repo",
			cyrusPr({ sha: "abc123" }),
			deps,
		);
		expect(r2.captured).toBe(false);
		expect(r2.reason).toContain("already captured");
	});

	it("falls back to gh pr diff (no ledger) when the ephemeral checkout fails", async () => {
		const deps: CaptureDeps = {
			worktreePath: () => null,
			run: (args) =>
				args[0] === "git"
					? { status: 1, stdout: "", stderr: "network down" }
					: { status: 0, stdout: "DIFF\n", stderr: "" },
		};
		const res = await captureEvidence(
			"Daily_You",
			"/repo",
			cyrusPr({ sha: "abc123" }),
			deps,
		);
		expect(res.captured).toBe(true);
		expect(res.ran_ledger).toBe(false);
	});

	it("uses gh pr diff (not an empty worktree diff) when the base is unresolvable", async () => {
		const wt = mkdtempSync(join(tmpdir(), "cyrus-loop-wt-"));
		let ran = false;
		const calls: string[][] = [];
		const deps: CaptureDeps = {
			worktreePath: () => wt,
			resolveBaseRef: () => null, // base declared but unresolvable
			runLedger: () => {
				ran = true;
			},
			run: (args) => {
				calls.push(args);
				if (args[0] === "gh" && args[1] === "pr" && args[2] === "diff") {
					return { status: 0, stdout: "REAL_PR_DIFF\n", stderr: "" };
				}
				return { status: 0, stdout: "", stderr: "" };
			},
		};
		const res = await captureEvidence(
			"Daily_You",
			"/repo",
			cyrusPr({ sha: "abc123" }),
			deps,
		);
		const rid = "2026-07-05-DEV-123-pr7";
		expect(res.captured).toBe(true);
		expect(ran).toBe(true); // ledger still ran in the worktree
		expect(readFileSync(diffPath(rid), "utf-8")).toBe("REAL_PR_DIFF\n");
		expect(
			calls.some((a) => a[0] === "gh" && a[1] === "pr" && a[2] === "diff"),
		).toBe(true);
		// no worktree `git diff` was written (the empty-diff trap is gone)
		expect(calls.some((a) => a[0] === "git" && a.includes("diff"))).toBe(false);
	});

	it("skips a PR with no issue id in its branch", async () => {
		const { deps } = stubDeps();
		const pr = { ...cyrusPr(), headRefName: "just-a-branch" };
		const res = await captureEvidence("Daily_You", "/repo", pr, deps);
		expect(res.captured).toBe(false);
		expect(res.reason).toContain("no issue id");
	});

	it("supersedes a stale verdict when the head advances", async () => {
		const deps: CaptureDeps = {
			worktreePath: () => null,
			run: () => ({ status: 0, stdout: "DIFF\n", stderr: "" }),
			resolveBaseRef: () => "origin/main",
			runLedger: () => null,
		};
		const rid = "2026-07-05-DEV-123-pr7";
		await captureEvidence(
			"Daily_You",
			"/repo",
			cyrusPr({ sha: "abc123" }),
			deps,
		);
		recordHumanVerdict(rid, "approved", [], { headSha: "abc123" });
		const res = await captureEvidence(
			"Daily_You",
			"/repo",
			cyrusPr({ sha: "def456" }),
			deps,
		);
		expect(res.captured).toBe(true);
		expect(res.superseded).not.toBeNull();
		expect(res.superseded?.archived.human).toBeTruthy();
		expect(readPrMeta(rid)).not.toBeNull();
	});
});
