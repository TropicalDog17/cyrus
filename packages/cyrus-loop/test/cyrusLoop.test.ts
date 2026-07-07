import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CaptureDeps,
	type CmdRun,
	CYRUS_PR_MARKER,
} from "../src/capture.js";
import { clearCyrusConfigCache } from "../src/cyrusAdapter.js";
import {
	type BlindGatePoster,
	buildJudgePrompt,
	CyrusLoop,
	formatLedgerForJudge,
	type PrOpenedPayload,
} from "../src/cyrusLoop.js";
import { type ReviewPackage, readHumanVerdict } from "../src/gate.js";
import { readMergeFact } from "../src/integrate.js";
import type { LMBackend } from "../src/judge.js";
import { existingRules } from "../src/learn.js";
import {
	clearLoopConfigCache,
	loadLoopConfig,
	loopActiveForRepo,
	resolveLoopConfig,
} from "../src/loopConfig.js";
import { dataDir, gatesDir, ledgerFile, runsFile } from "../src/paths.js";
import { readRuns } from "../src/runLog.js";

// W4 — the CyrusLoop consumer chains capture → judge → blind gate → verdict → integrate → learn.
// Every external edge (gh, Anthropic, worktree, Linear) is injected, so this runs hermetically.

let prev: string | undefined;
let prevCyrus: string | undefined;
let prevLoop: string | undefined;
beforeEach(() => {
	prev = process.env.AGENTIC_PIPELINE_DATA;
	prevCyrus = process.env.CYRUS_CONFIG;
	prevLoop = process.env.CYRUS_LOOP_CONFIG;
	const dir = mkdtempSync(join(tmpdir(), "cyrus-loop-w4-"));
	process.env.AGENTIC_PIPELINE_DATA = dir;
	// Point CYRUS_CONFIG at a nonexistent file so tierFor/buildBundle never read the real fleet.
	process.env.CYRUS_CONFIG = join(dir, "no-config.json");
	delete process.env.CYRUS_LOOP_CONFIG;
	clearCyrusConfigCache();
	clearLoopConfigCache();
});
afterEach(() => {
	const restore = (k: string, v: string | undefined) => {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	};
	restore("AGENTIC_PIPELINE_DATA", prev);
	restore("CYRUS_CONFIG", prevCyrus);
	restore("CYRUS_LOOP_CONFIG", prevLoop);
	clearCyrusConfigCache();
	clearLoopConfigCache();
});

/** capture deps writing a real E1 ledger + a DIFF, with a live worktree — no gh/git needed. */
function captureStub(): CaptureDeps {
	const wt = mkdtempSync(join(tmpdir(), "cyrus-loop-wt-"));
	return {
		worktreePath: () => wt,
		run: () => ({ status: 0, stdout: "DIFF\n", stderr: "" }),
		resolveBaseRef: (_dir, base) => (base ? `origin/${base}` : null),
		runLedger: (runId) => {
			writeFileSync(
				ledgerFile(runId),
				`${JSON.stringify({ id: "E1", kind: "tests", exit: 0, result: "pass", summary: "42 passed" })}\n`,
			);
			return { mechanical: "pass" };
		},
	};
}

/** A judge that passes citing E1 (grounded in the stub ledger). */
const passJudge: LMBackend = async () =>
	JSON.stringify({
		verdict: "pass",
		claims: [{ claim: "tests pass", evidence: "E1" }],
		concerns: [],
	});

/** Fake `gh`: SHA matches the captured head, merge succeeds (mirrors integrate.test.ts). */
function fakeGh(
	opts: { headSha?: string; mergeStatus?: number; mergeCommit?: string } = {},
): CmdRun {
	const headSha = opts.headSha ?? "abc123";
	const mergeStatus = opts.mergeStatus ?? 0;
	const mergeCommit = opts.mergeCommit ?? "cafe1234";
	return (args) => {
		if (args[0] === "gh" && args[1] === "pr" && args[2] === "view") {
			const field = args[args.indexOf("--json") + 1];
			if (field === "headRefOid")
				return {
					status: 0,
					stdout: JSON.stringify({ headRefOid: headSha }),
					stderr: "",
				};
			if (field === "mergeCommit")
				return {
					status: 0,
					stdout: JSON.stringify({ mergeCommit: { oid: mergeCommit } }),
					stderr: "",
				};
		}
		if (args[0] === "gh" && args[1] === "pr" && args[2] === "merge") {
			return {
				status: mergeStatus,
				stdout: "",
				stderr: mergeStatus === 0 ? "" : "conflict",
			};
		}
		return { status: 1, stdout: "", stderr: `unexpected argv: ${args}` };
	};
}

function prPayload(over: Partial<PrOpenedPayload> = {}): PrOpenedPayload {
	return {
		repoName: "demo",
		repoDir: "/repo",
		prNumber: 7,
		headRefName: "me/dev-123-fix",
		headRefOid: "abc123",
		baseRefName: "main",
		body: CYRUS_PR_MARKER,
		url: "https://example/pr/7",
		createdAt: "2026-07-05T10:00:00Z",
		...over,
	};
}
const RID = "2026-07-05-DEV-123-pr7";

describe("onPrOpened", () => {
	it("captures diff + ledger, runs the judge, and stores its verdict HIDDEN (no runs.jsonl yet)", async () => {
		const loop = new CyrusLoop({
			config: resolveLoopConfig(),
			judgeBackend: passJudge,
			captureDeps: captureStub(),
		});
		const res = await loop.onPrOpened(prPayload());
		expect(res.captured).toBe(true);
		expect(res.runId).toBe(RID);
		expect(res.judged).toBe(true);
		expect(res.judgeVerdict).toBe("pass");

		expect(existsSync(ledgerFile(RID))).toBe(true);
		expect(readFileSync(join(dataDir(), "diffs", `${RID}.diff`), "utf-8")).toBe(
			"DIFF\n",
		);
		// Judge verdict is on disk but the human verdict is not — so it stays hidden (blind gate).
		expect(existsSync(join(gatesDir(), `${RID}.judge.json`))).toBe(true);
		expect(readHumanVerdict(RID)).toBeNull();
		// W4 acceptance: no runs.jsonl write until AFTER the gate.
		expect(existsSync(runsFile())).toBe(false);
	});

	it("skips a repo not on the loop allowlist", async () => {
		const loop = new CyrusLoop({
			config: resolveLoopConfig({ repos: ["other"] }),
			judgeBackend: passJudge,
			captureDeps: captureStub(),
		});
		const res = await loop.onPrOpened(prPayload());
		expect(res.captured).toBe(false);
		expect(res.reason).toContain("inactive");
	});

	it("captures without judging when the judge is disabled", async () => {
		const loop = new CyrusLoop({
			config: resolveLoopConfig({ judge: { enabled: false } }),
			captureDeps: captureStub(),
		});
		const res = await loop.onPrOpened(prPayload());
		expect(res.captured).toBe(true);
		expect(res.judged).toBe(false);
		expect(existsSync(join(gatesDir(), `${RID}.judge.json`))).toBe(false);
	});

	it("swallows a judge failure — capture still succeeds, no verdict stored (advisory only)", async () => {
		const throwing: LMBackend = () => {
			throw new Error("LM down");
		};
		const loop = new CyrusLoop({
			config: resolveLoopConfig(),
			judgeBackend: throwing,
			captureDeps: captureStub(),
		});
		const res = await loop.onPrOpened(prPayload());
		expect(res.captured).toBe(true);
		expect(res.judged).toBe(false);
		expect(existsSync(ledgerFile(RID))).toBe(true);
		expect(existsSync(join(gatesDir(), `${RID}.judge.json`))).toBe(false);
	});
});

describe("onSessionComplete", () => {
	it("posts the BLIND review package (diff + ledger, never the judge) for the captured run", async () => {
		const posted: Array<{
			runId: string;
			issueId: string;
			review: ReviewPackage;
		}> = [];
		const gate: BlindGatePoster = {
			postBlindGate: (i) => {
				posted.push(i);
			},
		};
		const loop = new CyrusLoop({
			config: resolveLoopConfig(),
			judgeBackend: passJudge,
			captureDeps: captureStub(),
			gate,
		});
		await loop.onPrOpened(prPayload());
		const res = await loop.onSessionComplete({
			repoName: "demo",
			issueId: "DEV-123",
			status: "completed",
		});
		expect(res.posted).toBe(true);
		expect(res.runId).toBe(RID);
		expect(posted).toHaveLength(1);
		const review = posted[0]!.review;
		expect(review.ledger).toHaveLength(1);
		expect("judge" in review).toBe(false); // judge cannot leak into the review package
		expect(review.note).toContain("withheld");
	});

	it("reports no run when nothing was captured for the issue", async () => {
		const loop = new CyrusLoop({ config: resolveLoopConfig() });
		const res = await loop.onSessionComplete({
			repoName: "demo",
			issueId: "DEV-999",
			status: "completed",
		});
		expect(res.posted).toBe(false);
		expect(res.reason).toContain("no captured run");
	});
});

describe("onVerdict", () => {
	it("approved → merges, writes a merge fact, and appends one valid runs.jsonl line", async () => {
		const loop = new CyrusLoop({
			config: resolveLoopConfig(),
			judgeBackend: passJudge,
			captureDeps: captureStub(),
			ghRun: fakeGh(),
		});
		const pr = await loop.onPrOpened(prPayload());
		const res = await loop.onVerdict({
			runId: pr.runId!,
			verdict: "approved",
			repoName: "demo",
			repoDir: "/repo",
			headSha: "abc123",
			specText: "## Goal\nx\n",
		});
		expect(res.integrated?.integrated).toBe(true);
		expect(res.integrated?.outcome).toBe("merged");
		expect(res.integrated?.pr).toBe(7);
		expect(readMergeFact(pr.runId!)?.merged).toBe(true);
		expect(res.learned.appended).toBe(pr.runId);

		const runs = readRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0]!.run_id).toBe(pr.runId);
		expect((runs[0] as { outcome: string }).outcome).toBe("merged");
		expect(
			(runs[0] as { diff_gate: { verdict: string } }).diff_gate.verdict,
		).toBe("approved");
		expect(readHumanVerdict(pr.runId!)?.verdict).toBe("approved");
	});

	it("rejected → does NOT merge, records the run as abandoned, and learns a rule", async () => {
		const noGh: CmdRun = () => {
			throw new Error("gh must not run on a rejected verdict");
		};
		const loop = new CyrusLoop({
			config: resolveLoopConfig(),
			judgeBackend: passJudge,
			captureDeps: captureStub(),
			ghRun: noGh,
		});
		const pr = await loop.onPrOpened(prPayload());
		const res = await loop.onVerdict({
			runId: pr.runId!,
			verdict: "rejected",
			repoName: "demo",
			repoDir: "/repo",
			headSha: "abc123",
			findings: [
				{ text: "missed null check", tag: "recurring", rule_ineffective: null },
			],
		});
		expect(res.integrated).toBeUndefined();
		expect(res.learned.appended).toBe(pr.runId);

		const runs = readRuns();
		expect(runs).toHaveLength(1);
		expect((runs[0] as { outcome: string }).outcome).toBe("abandoned");
		expect(
			(runs[0] as { diff_gate: { verdict: string } }).diff_gate.verdict,
		).toBe("rejected");
		// the recurring finding compounded into a durable failure rule
		const rules = existingRules("demo");
		expect(rules).toHaveLength(1);
		expect(rules[0]!.text).toContain("missed null check");
	});

	it("approved but autoMerge disabled → records without merging", async () => {
		const noGh: CmdRun = () => {
			throw new Error("gh must not run when autoMerge is off");
		};
		const loop = new CyrusLoop({
			config: resolveLoopConfig({ autoMerge: false }),
			judgeBackend: passJudge,
			captureDeps: captureStub(),
			ghRun: noGh,
		});
		const pr = await loop.onPrOpened(prPayload());
		const res = await loop.onVerdict({
			runId: pr.runId!,
			verdict: "approved",
			repoName: "demo",
			repoDir: "/repo",
			headSha: "abc123",
		});
		expect(res.integrated).toBeUndefined();
		expect(res.learned.appended).toBe(pr.runId);
		expect(readMergeFact(pr.runId!)).toBeNull();
	});
});

describe("judge prompt assembly", () => {
	it("formatLedgerForJudge renders id/kind/exit/result/summary", () => {
		const out = formatLedgerForJudge([
			{
				id: "E1",
				kind: "tests",
				exit: 0,
				result: "pass",
				summary: "42 passed",
			},
			{
				id: "E4",
				kind: "diffscan",
				result: "warn",
				summary: "1 file outside spec",
			},
		] as never);
		expect(out).toBe(
			'E1 tests exit 0 pass "42 passed"\nE4 diffscan warn "1 file outside spec"',
		);
	});

	it("formatLedgerForJudge notes an empty ledger", () => {
		expect(formatLedgerForJudge([])).toContain("empty ledger");
	});

	it("buildJudgePrompt embeds the template, the diff, and the ledger", () => {
		mkdirSync(join(dataDir(), "diffs"), { recursive: true });
		const diffPath = join(dataDir(), "diffs", "sample.diff");
		writeFileSync(diffPath, "DIFF_UNDER_REVIEW\n");
		const review: ReviewPackage = {
			run_id: "2026-07-05-DEV-1",
			diff: diffPath,
			ledger: [
				{ id: "E1", kind: "tests", exit: 0, result: "pass", summary: "ok" },
			] as never,
			diffscan_warnings: [],
			note: "",
		};
		const prompt = buildJudgePrompt(review);
		expect(prompt).toContain("release gate"); // from judge-v1.md
		expect(prompt).toContain("DIFF_UNDER_REVIEW");
		expect(prompt).toContain('E1 tests exit 0 pass "ok"');
	});
});

describe("loop config", () => {
	it("resolves defaults", () => {
		const c = resolveLoopConfig();
		expect(c.enabled).toBe(true);
		expect(c.judge).toEqual({
			enabled: true,
			model: "claude-opus-4-8",
			maxTokens: 2048,
		});
		expect(c.mergeMethod).toBe("squash");
		expect(c.autoMerge).toBe(true);
		expect(c.deleteBranch).toBe(false);
	});

	it("loopActiveForRepo: empty allowlist ⇒ all repos, else membership, and disabled ⇒ none", () => {
		expect(loopActiveForRepo(resolveLoopConfig(), "any")).toBe(true);
		expect(loopActiveForRepo(resolveLoopConfig({ repos: ["a"] }), "a")).toBe(
			true,
		);
		expect(loopActiveForRepo(resolveLoopConfig({ repos: ["a"] }), "b")).toBe(
			false,
		);
		expect(loopActiveForRepo(resolveLoopConfig({ enabled: false }), "a")).toBe(
			false,
		);
	});

	it("loads (and merges defaults) from CYRUS_LOOP_CONFIG", () => {
		const p = join(dataDir(), "loop.json");
		writeFileSync(
			p,
			JSON.stringify({ mergeMethod: "rebase", judge: { enabled: false } }),
		);
		process.env.CYRUS_LOOP_CONFIG = p;
		clearLoopConfigCache();
		const c = loadLoopConfig();
		expect(c.mergeMethod).toBe("rebase");
		expect(c.judge.enabled).toBe(false);
		expect(c.judge.model).toBe("claude-opus-4-8"); // default preserved
		expect(c.autoMerge).toBe(true); // default preserved
	});
});
