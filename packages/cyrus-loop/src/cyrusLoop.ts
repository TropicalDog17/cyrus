/**
 * CyrusLoop — the event-driven brain that turns Cyrus events into the compounding
 * Verify → blind-gate → Learn loop (Lane C / W4 in docs/CYRUS_LOOP_PLAN.md).
 *
 * There is no Python analogue to port: `agentic-pipeline` drove each stage as a separate CLI
 * command; nothing chained capture → judge → gate → integrate → learn. This class is that
 * orchestrator, wired to Cyrus's EdgeWorker bus by a thin adapter (W2/W3) that simply forwards
 * `prOpened` / `sessionComplete` / verdict events to the handler methods below.
 *
 * Design notes:
 *  - Deliberately decoupled from `edge-worker`: it depends only on `cyrus-loop`'s own modules plus
 *    injected transports (`gate`, `ghRun`, `captureDeps`, `judgeBackend`), so the trim lane's
 *    churn on EdgeWorker cannot break it and it is unit-testable without real gh/Anthropic/Linear.
 *  - The judge is ADVISORY. Its verdict is stored hidden and never authorizes a merge; a judge
 *    failure is logged and swallowed so it can never block the human gate.
 *  - Only an `approved` HUMAN verdict authorizes Integrate. Every gated run — approved OR not — is
 *    recorded to runs.jsonl; the rejected/needs-rework runs are the valuable labeled negatives.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CaptureDeps,
	type CmdRun,
	captureEvidence,
	type PullRequest,
} from "./capture.js";
import {
	type Finding,
	type ReviewPackage,
	recordHumanVerdict,
	reviewPackage,
	storeJudgeVerdict,
} from "./gate.js";
import { type IntegrateStatus, integrateRun } from "./integrate.js";
import {
	createAnthropicJudgeBackend,
	type LMBackend,
	runJudge,
} from "./judge.js";
import { assembleRecord, type RecordResult, record } from "./learn.js";
import {
	loadLoopConfig,
	loopActiveForRepo,
	type ResolvedLoopConfig,
} from "./loopConfig.js";
import { parseRunId, promptsDir } from "./paths.js";
import { JUDGE_PROMPT_FILE } from "./promptVersion.js";
import type { LedgerEntry } from "./schemas.js";

/** Emitted by Cyrus when a Cyrus-authored PR is opened (W2). Maps onto capture's PullRequest. */
export interface PrOpenedPayload {
	/** Cyrus repo `name` or `id` — drives tierFor / worktreePath / the loop allowlist. */
	repoName: string;
	/** Absolute path to the git repo (the primary checkout, not the worktree). */
	repoDir: string;
	prNumber: number;
	headRefName: string;
	headRefOid?: string | null;
	baseRefName?: string | null;
	body?: string | null;
	url?: string | null;
	/** ISO-8601 PR creation timestamp — folds into the run_id (`<date>-<ISSUE>-pr<N>`). */
	createdAt: string;
}

/** Emitted when an agent session finishes (W3). Triggers the blind gate for the captured run. */
export interface SessionCompletePayload {
	repoName: string;
	/** Linear issue identifier, e.g. `DEV-123`. */
	issueId: string;
	worktree?: string | null;
	status: string;
	prNumber?: number | null;
}

/** A human diff-gate verdict arriving from Linear (W5) — the ONLY thing that authorizes a merge. */
export interface VerdictPayload {
	runId: string;
	verdict: string; // approved | rejected | needs-rework
	findings?: Finding[];
	headSha?: string | null;
	/** Cyrus repo name/id — for tier + learn context. */
	repoName: string;
	/** Repo dir for `gh pr merge` (defaults to the dir stored in the PR metadata). */
	repoDir?: string | null;
	specText?: string | null;
	tier?: string | null;
	/**
	 * Final disposition for the run record. Defaults to `abandoned` for any non-approved verdict;
	 * for an approved verdict it is left unset so assembleRecord sources it from the merge fact.
	 */
	outcome?: "merged" | "rework" | "abandoned";
	force?: boolean;
}

/** W5 transport: posts the blind review package to Linear. Injected so the loop stays decoupled. */
export interface BlindGatePoster {
	postBlindGate(input: {
		runId: string;
		issueId: string;
		review: ReviewPackage;
	}): void | Promise<void>;
}

export interface CyrusLoopDeps {
	/** Pre-resolved config; when omitted the loop reads `~/.cyrus/loop.json`. */
	config?: ResolvedLoopConfig;
	/** Override the judge LM backend (tests pass a deterministic stub). */
	judgeBackend?: LMBackend;
	/** Injected capture plumbing (run/worktreePath/runLedger/resolveBaseRef) for testability. */
	captureDeps?: CaptureDeps;
	/** Injected `gh` runner for Integrate. */
	ghRun?: CmdRun;
	/** Blind-gate transport (W5). Absent ⇒ onSessionComplete resolves the run but posts nothing. */
	gate?: BlindGatePoster;
	logger?: (msg: string) => void;
}

export interface PrOpenedResult {
	captured: boolean;
	runId?: string;
	reason?: string;
	judged: boolean;
	judgeVerdict?: string;
}

export interface SessionCompleteResult {
	posted: boolean;
	runId?: string;
	reason?: string;
}

export interface VerdictResult {
	runId: string;
	verdict: string;
	integrated?: IntegrateStatus;
	learned: RecordResult;
}

interface PendingRun {
	runId: string;
	headSha: string | null;
	repoName: string;
	repoDir: string;
	prNumber: number;
}

/** Format the evidence ledger for the judge prompt, e.g. `E1 tests exit 0 pass "42 passed"`. */
export function formatLedgerForJudge(entries: LedgerEntry[]): string {
	if (entries.length === 0) {
		return "(empty ledger — no deterministic evidence)";
	}
	return entries
		.map((e) => {
			const parts: string[] = [e.id, e.kind];
			if (e.exit !== null && e.exit !== undefined) parts.push(`exit ${e.exit}`);
			if (e.result) parts.push(e.result);
			const summary = e.summary ? ` "${e.summary}"` : "";
			return `${parts.join(" ")}${summary}`;
		})
		.join("\n");
}

/**
 * Assemble the judge prompt: the versioned `judge-v1.md` template + the DIFF (context only) + the
 * EVIDENCE LEDGER (the judge's ONLY admissible source). The deterministic validator still runs
 * afterwards, so a prompt that over- or under-specifies can't defeat the citation lock.
 */
export function buildJudgePrompt(review: ReviewPackage): string {
	const template = readFileSync(join(promptsDir(), JUDGE_PROMPT_FILE), "utf-8");
	const diffText = existsSync(review.diff)
		? readFileSync(review.diff, "utf-8")
		: "(diff unavailable)";
	const ledgerText = formatLedgerForJudge(review.ledger);
	return `${template}\n\n# DIFF\n\n\`\`\`diff\n${diffText}\n\`\`\`\n\n# EVIDENCE LEDGER\n\n${ledgerText}\n`;
}

export class CyrusLoop {
	private readonly cfg: ResolvedLoopConfig;
	private readonly deps: CyrusLoopDeps;
	/** issueId → the most recently captured run for that issue, so sessionComplete can gate it. */
	private readonly pending = new Map<string, PendingRun>();

	constructor(deps: CyrusLoopDeps = {}) {
		this.cfg = deps.config ?? loadLoopConfig();
		this.deps = deps;
	}

	/** The resolved loop config in effect (for callers that need to inspect it). */
	get config(): ResolvedLoopConfig {
		return this.cfg;
	}

	private log(msg: string): void {
		(this.deps.logger ?? (() => {}))(`[cyrus-loop] ${msg}`);
	}

	/**
	 * PR opened → capture the diff + run the mechanical ledger, then (advisory) run the citation-
	 * locked judge and store its verdict HIDDEN. Idempotent via capture.shouldCapture.
	 */
	async onPrOpened(payload: PrOpenedPayload): Promise<PrOpenedResult> {
		if (!loopActiveForRepo(this.cfg, payload.repoName)) {
			return {
				captured: false,
				reason: "loop inactive for repo",
				judged: false,
			};
		}
		const pr: PullRequest = {
			number: payload.prNumber,
			headRefName: payload.headRefName,
			createdAt: payload.createdAt,
			headRefOid: payload.headRefOid ?? undefined,
			baseRefName: payload.baseRefName ?? undefined,
			url: payload.url ?? undefined,
			body: payload.body ?? undefined,
		};
		const cap = await captureEvidence(
			payload.repoName,
			payload.repoDir,
			pr,
			this.deps.captureDeps ?? {},
		);
		if (!cap.captured || !cap.run_id) {
			this.log(
				`capture skipped for PR #${payload.prNumber}: ${cap.reason ?? "unknown"}`,
			);
			return { captured: false, reason: cap.reason, judged: false };
		}
		const runId = cap.run_id;
		const issueId = parseRunId(runId).issueId;
		this.pending.set(issueId, {
			runId,
			headSha: payload.headRefOid ?? null,
			repoName: payload.repoName,
			repoDir: payload.repoDir,
			prNumber: payload.prNumber,
		});

		let judged = false;
		let judgeVerdict: string | undefined;
		if (this.cfg.judge.enabled) {
			try {
				const review = reviewPackage(runId);
				const prompt = buildJudgePrompt(review);
				const backend =
					this.deps.judgeBackend ??
					createAnthropicJudgeBackend({
						model: this.cfg.judge.model,
						maxTokens: this.cfg.judge.maxTokens,
					});
				const validated = await runJudge(prompt, review.ledger, { backend });
				storeJudgeVerdict(runId, validated); // re-validates against this run's ledger
				judged = true;
				judgeVerdict = validated.verdict;
			} catch (err) {
				// Advisory only — a judge failure must NEVER block the human gate.
				this.log(`judge failed for ${runId}: ${(err as Error).message}`);
			}
		}
		return { captured: true, runId, judged, judgeVerdict };
	}

	/**
	 * Session finished → post the BLIND review package (diff + ledger, never the judge) to Linear
	 * for the captured run. The verdict comes back later via onVerdict.
	 */
	async onSessionComplete(
		payload: SessionCompletePayload,
	): Promise<SessionCompleteResult> {
		if (!loopActiveForRepo(this.cfg, payload.repoName)) {
			return { posted: false, reason: "loop inactive for repo" };
		}
		const pend = this.pending.get(payload.issueId);
		if (!pend) {
			return { posted: false, reason: "no captured run for issue" };
		}
		const review = reviewPackage(pend.runId);
		if (this.deps.gate) {
			await this.deps.gate.postBlindGate({
				runId: pend.runId,
				issueId: payload.issueId,
				review,
			});
		}
		return { posted: true, runId: pend.runId };
	}

	/**
	 * Human verdict recorded → (if approved & autoMerge) Integrate, then Learn: assemble the run
	 * record from the revealed gate, route findings into failure rules, and append runs.jsonl.
	 */
	async onVerdict(payload: VerdictPayload): Promise<VerdictResult> {
		recordHumanVerdict(payload.runId, payload.verdict, payload.findings ?? [], {
			headSha: payload.headSha ?? null,
			force: payload.force,
		});

		let integrated: IntegrateStatus | undefined;
		if (payload.verdict === "approved" && this.cfg.autoMerge) {
			integrated = integrateRun(payload.runId, payload.repoDir ?? null, {
				method: this.cfg.mergeMethod,
				deleteBranch: this.cfg.deleteBranch,
				ghRun: this.deps.ghRun,
			});
		}

		// Record every gated run — the rejected/needs-rework ones are the valuable labeled
		// negatives. For an approved verdict, leave `outcome` unset so assembleRecord sources it
		// from the durable merge fact written just above (→ `merged`); otherwise the diff did not
		// land, so record it as `abandoned` unless the caller specified a disposition (e.g. rework).
		const outcome =
			payload.outcome ??
			(payload.verdict === "approved" ? undefined : "abandoned");
		const rec = assembleRecord(payload.runId, payload.repoName, {
			specText: payload.specText ?? null,
			tier: payload.tier ?? null,
			outcome,
		});
		const learned = record(rec, { runId: payload.runId });

		this.pending.delete(parseRunId(payload.runId).issueId);
		return {
			runId: payload.runId,
			verdict: payload.verdict,
			integrated,
			learned,
		};
	}
}
