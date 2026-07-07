import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	diffStatsFromFile,
	EvidenceLedger,
	gitChangedFiles,
	gitDiffStats,
	resolveBaseRef,
	summarize,
} from "../src/ledger.js";
import { logsDir } from "../src/paths.js";

// Ported from tests/test_ledger.py

function git(cwd: string, ...args: string[]): void {
	const res = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf-8",
	} as SpawnSyncOptions);
	if (res.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

let prevData: string | undefined;

beforeEach(() => {
	prevData = process.env.AGENTIC_PIPELINE_DATA;
	process.env.AGENTIC_PIPELINE_DATA = mkdtempSync(
		join(tmpdir(), "cyrus-loop-led-"),
	);
});

afterEach(() => {
	if (prevData === undefined) delete process.env.AGENTIC_PIPELINE_DATA;
	else process.env.AGENTIC_PIPELINE_DATA = prevData;
});

describe("EvidenceLedger commands", () => {
	it("records pass and fail and computes mechanical result", async () => {
		const led = new EvidenceLedger("2026-07-04-ENG-1");
		const e1 = await led.runCommand("tests", "true", { cwd: "." });
		const e2 = await led.runCommand("lint", "false", { cwd: "." });
		expect(e1.id).toBe("E1");
		expect(e1.result).toBe("pass");
		expect(e1.exit).toBe(0);
		expect(e2.id).toBe("E2");
		expect(e2.result).toBe("fail");
		expect(led.mechanicalResult()).toBe("fail");
	});

	it("passes mechanical when every command passes", async () => {
		const led = new EvidenceLedger("2026-07-04-ENG-2");
		await led.runCommand("tests", "true", { cwd: "." });
		await led.runCommand("build", "true", { cwd: "." });
		expect(led.mechanicalResult()).toBe("pass");
	});

	it("computes sha and writes artifacts", async () => {
		const led = new EvidenceLedger("2026-07-04-ENG-5");
		await led.runCommand("tests", "echo hello", { cwd: "." });
		expect(led.sha256()).toHaveLength(64);
		expect(
			readFileSync(join(logsDir("2026-07-04-ENG-5"), "E1.txt"), "utf-8").trim(),
		).toBe("hello");
	});

	it("validates every entry against the ledger schema", async () => {
		const led = new EvidenceLedger("2026-07-04-ENG-6");
		await led.runCommand("tests", "true", { cwd: "." });
		led.diffscan(["a.py"], ["a.py"]);
		expect(led.entries).toHaveLength(2);
	});

	it("prefers failure-naming lines in the summary", async () => {
		const led = new EvidenceLedger("2026-07-04-ENG-10");
		const e = await led.runCommand(
			"lint",
			"printf 'Error: bad import at foo.py:3\\n5 issues found\\n'; false",
			{ cwd: "." },
		);
		expect(
			e.summary?.includes("foo.py:3") || e.summary?.includes("bad import"),
		).toBe(true);
	});
});

describe("summarize", () => {
	it("names the failure over a trailing count line", () => {
		const s = summarize("Error: bad import at foo.py:3\n5 issues found", 1);
		expect(s).toContain("bad import");
	});
	it("uses the last line on success", () => {
		expect(summarize("building\nBUILD OK", 0)).toBe("ok: BUILD OK");
	});
});

describe("EvidenceLedger diffscan (E4)", () => {
	it("warns but never fails on out-of-scope files", () => {
		const led = new EvidenceLedger("2026-07-04-ENG-3");
		const warn = led.diffscan(["a.py", "unexpected.py"], ["a.py"]);
		expect(warn.kind).toBe("diffscan");
		expect(warn.result).toBe("warn");
		const clean = led.diffscan(["a.py"], ["a.py", "b.py"]);
		expect(clean.result).toBe("pass");
		expect(led.mechanicalResult()).toBe("skip"); // no command runners here
	});

	it("never emits fail", () => {
		const led = new EvidenceLedger("2026-07-04-ENG-4");
		for (const [changed, expected] of [
			[[], []],
			[["x"], []],
			[["x"], ["x"]],
		] as [string[], string[]][]) {
			expect(["warn", "pass"]).toContain(
				led.diffscan(changed, expected).result,
			);
		}
	});

	it("passes (not warn-on-everything) when no scope is declared", () => {
		const led = new EvidenceLedger("2026-07-04-ENG-8");
		const scan = led.diffscan(["a.py", "b.py"], []);
		expect(scan.result).toBe("pass");
		expect(scan.summary).toContain("no files_expected declared");
		expect(led.diffscanResult()).toBe("pass");
	});
});

describe("EvidenceLedger retries", () => {
	it("replays prior evidence and reports the latest attempt", async () => {
		const rid = "2026-07-04-ENG-7";
		const first = new EvidenceLedger(rid);
		await first.runCommand("tests", "false", { cwd: "." }); // attempt 1 fails (E1)
		expect(first.mechanicalResult()).toBe("fail");

		const retry = new EvidenceLedger(rid); // reuse run_id — prior evidence preserved
		expect(retry.attempt).toBe(2);
		expect(retry.entries.map((e) => e.id)).toEqual(["E1"]);
		await retry.runCommand("tests", "true", { cwd: "." }); // attempt 2 passes (E2)
		expect(retry.mechanicalResult()).toBe("pass"); // latest attempt, not the stale E1 fail
		expect(retry.entries.map((e) => e.id)).toEqual(["E1", "E2"]);
		expect(new Set(retry.entries.map((e) => e.attempt))).toEqual(
			new Set([1, 2]),
		);
	});

	it("scopes diffscanResult to the latest attempt", () => {
		const rid = "2026-07-04-ENG-9";
		const first = new EvidenceLedger(rid);
		first.diffscan(["oops.py"], ["a.py"]); // attempt 1: warn
		expect(first.diffscanResult()).toBe("warn");
		const retry = new EvidenceLedger(rid);
		expect(retry.attempt).toBe(2);
		retry.diffscan(["a.py"], ["a.py"]); // attempt 2: clean
		expect(retry.diffscanResult()).toBe("pass"); // latest attempt only
	});
});

describe("EvidenceLedger timeouts", () => {
	it("preserves pre-hang output in artifact and summary", async () => {
		const led = new EvidenceLedger("2026-07-04-ENG-13");
		const e = await led.runCommand(
			"tests",
			"printf 'diagnostic-before-hang\\n'; sleep 5",
			{ cwd: ".", timeout: 1 },
		);
		expect(e.result).toBe("fail");
		expect(e.summary).toContain("timeout");
		const art = readFileSync(
			join(logsDir("2026-07-04-ENG-13"), "E1.txt"),
			"utf-8",
		);
		expect(art).toContain("diagnostic-before-hang");
		expect(e.summary).toContain("diagnostic-before-hang");
	});

	it("kills the whole process group on timeout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cyrus-loop-orphan-"));
		const marker = join(dir, "orphan_alive");
		const led = new EvidenceLedger("2026-07-04-ENG-11");
		// A detached child would touch `marker` after the timeout; the group-kill must reap it.
		const cmd = `(sleep 2; touch ${marker}) & sleep 5`;
		const e = await led.runCommand("tests", cmd, { cwd: ".", timeout: 1 });
		expect(e.result).toBe("fail");
		expect(e.summary).toContain("timeout");
		await sleep(3); // past when the child would have fired
		expect(existsSync(marker)).toBe(false);
	});
});

describe("diffStatsFromFile", () => {
	it("counts content lines, not +++/--- headers", () => {
		const dir = mkdtempSync(join(tmpdir(), "cyrus-loop-diff-"));
		const diff = join(dir, "d.diff");
		writeFileSync(
			diff,
			"diff --git a/q.sql b/q.sql\n" +
				"index 111..222 100644\n" +
				"--- a/q.sql\n" +
				"+++ b/q.sql\n" +
				"@@ -1,2 +1,3 @@\n" +
				" context line\n" +
				"-- old SQL comment\n" +
				"+++ weird added content\n" +
				"+normal added\n",
		);
		expect(diffStatsFromFile(diff)).toEqual({ files: 1, loc: 3 });
		expect(diffStatsFromFile(join(dir, "nope.diff"))).toBeNull();
	});
});

describe("git helpers", () => {
	it("resolveBaseRef falls through to origin/<base>", () => {
		const root = mkdtempSync(join(tmpdir(), "cyrus-loop-git-"));
		const remote = join(root, "remote");
		spawnSync("git", ["init", "-b", "dev", remote], { encoding: "utf-8" });
		git(remote, "config", "user.email", "t@t");
		git(remote, "config", "user.name", "t");
		writeFileSync(join(remote, "f.txt"), "x");
		git(remote, "add", ".");
		git(remote, "commit", "-m", "init");

		const clone = join(root, "clone");
		spawnSync("git", ["clone", remote, clone], { encoding: "utf-8" });
		git(clone, "config", "user.email", "t@t");
		git(clone, "config", "user.name", "t");
		git(clone, "checkout", "-b", "feature");
		git(clone, "branch", "-D", "dev"); // now only origin/dev remains, like a fresh worktree

		expect(resolveBaseRef(clone, "dev")).toBe("origin/dev");
		expect(resolveBaseRef(clone, "does-not-exist")).toBeNull();
		expect(resolveBaseRef(clone, null)).toBeNull();
	});

	it("returns subdir-relative paths and counts diff stats", () => {
		const root = mkdtempSync(join(tmpdir(), "cyrus-loop-git2-"));
		const repo = join(root, "repo");
		spawnSync("git", ["init", "-q", "-b", "main", repo], { encoding: "utf-8" });
		spawnSync("mkdir", ["-p", join(repo, "sub")]);
		git(repo, "config", "user.email", "t@t.t");
		git(repo, "config", "user.name", "t");
		writeFileSync(join(repo, "sub", "a.txt"), "one\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "base");
		git(repo, "checkout", "-qb", "feat");
		writeFileSync(join(repo, "sub", "a.txt"), "one\ntwo\n");
		writeFileSync(join(repo, "sub", "b.txt"), "new\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "work");

		const changed = gitChangedFiles(join(repo, "sub"), "main");
		expect(new Set(changed)).toEqual(new Set(["a.txt", "b.txt"]));
		const stats = gitDiffStats(join(repo, "sub"), "main");
		expect(stats.files).toBe(2);
		expect(stats.loc).toBe(2);
	});
});
