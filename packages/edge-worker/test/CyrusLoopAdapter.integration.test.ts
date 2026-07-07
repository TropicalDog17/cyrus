import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IIssueTrackerService } from "cyrus-core";
import {
	type CaptureDeps,
	type CmdRun,
	clearLoopConfigCache,
	cyrusAdapter,
	existingRules,
	gatesDir,
	type LMBackend,
	ledgerFile,
	readHumanVerdict,
	readMergeFact,
	readRuns,
	resolveLoopConfig,
	runsFile,
} from "cyrus-loop";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	attachCyrusLoop,
	type CyrusLoopHost,
} from "../src/CyrusLoopAdapter.js";
import type {
	LoopVerdictInput,
	PrOpenedEventPayload,
	SessionCompleteEventPayload,
} from "../src/types.js";

// W6 — full compounding loop through the adapter: prOpened → capture+hidden judge →
// sessionComplete → blind gate posted to the (fake) tracker → verdict → integrate + learn +
// runs.jsonl. Every external edge (gh, Anthropic, worktree, Linear) is injected, so it is
// deterministic. This is the rigorous e2e proof; F1's in-memory repo cannot run real `gh`.

/** Minimal Linear stand-in recording the comments the gate posts. */
class FakeTracker {
	comments: Array<{ issueId: string; body: string }> = [];
	createComment(issueId: string, input: { body: string }): Promise<unknown> {
		this.comments.push({ issueId, body: input.body });
		return Promise.resolve({});
	}
}

/** Minimal EdgeWorker stand-in implementing exactly what the adapter consumes. */
class FakeHost {
	private listeners = new Map<string, Array<(payload: unknown) => unknown>>();
	interceptor?: (input: LoopVerdictInput) => boolean | Promise<boolean>;
	emitted: Array<{ event: string; payload: unknown }> = [];
	constructor(private readonly tracker: FakeTracker) {}
	on(event: string, listener: (payload: unknown) => unknown): this {
		const arr = this.listeners.get(event) ?? [];
		arr.push(listener);
		this.listeners.set(event, arr);
		return this;
	}
	emit(event: string, payload: unknown): boolean {
		this.emitted.push({ event, payload });
		for (const l of this.listeners.get(event) ?? []) l(payload);
		return true;
	}
	/** Test helper: fire an event and await the adapter's async handling. */
	async emitAsync(event: string, payload: unknown): Promise<void> {
		this.emitted.push({ event, payload });
		for (const l of this.listeners.get(event) ?? []) await l(payload);
	}
	getIssueTrackerForRepository(): IIssueTrackerService | undefined {
		return this.tracker as unknown as IIssueTrackerService;
	}
	setLoopVerdictInterceptor(
		fn: (input: LoopVerdictInput) => boolean | Promise<boolean>,
	): void {
		this.interceptor = fn;
	}
}

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

const passJudge: LMBackend = async () =>
	JSON.stringify({
		verdict: "pass",
		claims: [{ claim: "tests pass", evidence: "E1" }],
		concerns: [],
	});

function fakeGh(): CmdRun {
	return (args) => {
		if (args[0] === "gh" && args[1] === "pr" && args[2] === "view") {
			const field = args[args.indexOf("--json") + 1];
			if (field === "headRefOid")
				return {
					status: 0,
					stdout: JSON.stringify({ headRefOid: "abc123" }),
					stderr: "",
				};
			if (field === "mergeCommit")
				return {
					status: 0,
					stdout: JSON.stringify({ mergeCommit: { oid: "cafe1234" } }),
					stderr: "",
				};
		}
		if (args[0] === "gh" && args[1] === "pr" && args[2] === "merge") {
			return { status: 0, stdout: "", stderr: "" };
		}
		return { status: 1, stdout: "", stderr: `unexpected argv: ${args}` };
	};
}

function prPayload(
	over: Partial<PrOpenedEventPayload> = {},
): PrOpenedEventPayload {
	return {
		provider: "github",
		issueId: "issue-1",
		issueIdentifier: "DEV-123",
		repositoryId: "repo-1",
		repositoryName: "demo",
		repoDir: "/repo",
		worktree: "/wt",
		prNumber: 7,
		headBranch: "me/dev-123-fix",
		headSha: "abc123",
		baseBranch: "main",
		prCreatedAt: "2026-07-05T10:00:00Z",
		prUrl: "https://example/pr/7",
		...over,
	};
}
const RID = "2026-07-05-DEV-123-pr7";

function sessionDone(
	over: Partial<SessionCompleteEventPayload> = {},
): SessionCompleteEventPayload {
	return {
		issueId: "issue-1",
		issueIdentifier: "DEV-123",
		repositoryId: "repo-1",
		repositoryName: "demo",
		worktree: "/wt",
		status: "complete",
		...over,
	};
}

let prev: string | undefined;
let prevCyrus: string | undefined;
let prevLoop: string | undefined;
beforeEach(() => {
	prev = process.env.AGENTIC_PIPELINE_DATA;
	prevCyrus = process.env.CYRUS_CONFIG;
	prevLoop = process.env.CYRUS_LOOP_CONFIG;
	const dir = mkdtempSync(join(tmpdir(), "cyrus-loop-w6-"));
	process.env.AGENTIC_PIPELINE_DATA = dir;
	process.env.CYRUS_CONFIG = join(dir, "no-config.json");
	delete process.env.CYRUS_LOOP_CONFIG;
	cyrusAdapter.clearCyrusConfigCache();
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
	cyrusAdapter.clearCyrusConfigCache();
	clearLoopConfigCache();
});

function wire(): { host: FakeHost; tracker: FakeTracker } {
	const tracker = new FakeTracker();
	const host = new FakeHost(tracker);
	attachCyrusLoop({
		host: host as unknown as CyrusLoopHost,
		config: resolveLoopConfig(),
		captureDeps: captureStub(),
		ghRun: fakeGh(),
		judgeBackend: passJudge,
	});
	return { host, tracker };
}

describe("CyrusLoopAdapter — full loop through the bus", () => {
	it("approved path: capture (hidden judge) → blind gate → verdict → merge + runs.jsonl", async () => {
		const { host, tracker } = wire();

		// 1. PR opened → capture + hidden judge; nothing posted, nothing recorded yet.
		await host.emitAsync("prOpened", prPayload());
		expect(existsSync(ledgerFile(RID))).toBe(true);
		expect(existsSync(join(gatesDir(), `${RID}.judge.json`))).toBe(true);
		expect(readHumanVerdict(RID)).toBeNull();
		expect(existsSync(runsFile())).toBe(false);
		expect(tracker.comments).toHaveLength(0);

		// 2. Session done → blind gate posted (diff+ledger, never the judge).
		await host.emitAsync("sessionComplete", sessionDone());
		expect(tracker.comments).toHaveLength(1);
		const gate = tracker.comments[0]!;
		expect(gate.issueId).toBe("issue-1");
		expect(gate.body).toContain("Diff gate");
		expect(gate.body).toContain("`E1`"); // ledger surfaced
		expect(gate.body).toContain("/approve");
		expect(gate.body.toLowerCase()).not.toContain("cannot-verify");
		expect(gate.body).not.toContain("claims"); // no judge structure leaks

		// 3. Human approves via a prompt → intercepted, merged, learned, recorded.
		const handled = await host.interceptor!({
			issueId: "issue-1",
			text: "/approve",
			agentSessionId: "s-1",
		});
		expect(handled).toBe(true);
		expect(readMergeFact(RID)?.merged).toBe(true);
		const runs = readRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0]!.run_id).toBe(RID);
		expect((runs[0] as { outcome: string }).outcome).toBe("merged");
		expect(
			(runs[0] as { diff_gate: { verdict: string } }).diff_gate.verdict,
		).toBe("approved");
		expect(readHumanVerdict(RID)?.verdict).toBe("approved");
		// verdictReached announced on the bus + a confirmation comment posted.
		expect(host.emitted.some((e) => e.event === "verdictReached")).toBe(true);
		expect(tracker.comments).toHaveLength(2);
		expect(tracker.comments[1]!.body).toContain("approved");
	});

	it("rejected path: no merge, run recorded as abandoned, and a rule is learned", async () => {
		const { host } = wire();
		await host.emitAsync("prOpened", prPayload());
		await host.emitAsync("sessionComplete", sessionDone());

		const handled = await host.interceptor!({
			issueId: "issue-1",
			text: "/reject\n- missed null check :: recurring",
			agentSessionId: "s-1",
		});
		expect(handled).toBe(true);
		expect(readMergeFact(RID)).toBeNull();
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

	it("ignores a non-verdict prompt (returns false so a normal session runs)", async () => {
		const { host } = wire();
		await host.emitAsync("prOpened", prPayload());
		await host.emitAsync("sessionComplete", sessionDone());
		const handled = await host.interceptor!({
			issueId: "issue-1",
			text: "hey can you also add logging?",
			agentSessionId: "s-1",
		});
		expect(handled).toBe(false);
		expect(existsSync(runsFile())).toBe(false); // no verdict recorded
	});

	it("ignores a verdict for an issue with no pending gate", async () => {
		const { host } = wire();
		const handled = await host.interceptor!({
			issueId: "issue-unknown",
			text: "/approve",
			agentSessionId: "s-1",
		});
		expect(handled).toBe(false);
	});

	it("does not capture a non-GitHub PR", async () => {
		const { host, tracker } = wire();
		await host.emitAsync("prOpened", prPayload({ provider: "gitlab" }));
		expect(existsSync(ledgerFile(RID))).toBe(false);
		await host.emitAsync("sessionComplete", sessionDone());
		expect(tracker.comments).toHaveLength(0); // no gate — nothing was captured
	});
});
