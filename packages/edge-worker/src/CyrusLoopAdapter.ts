/**
 * CyrusLoopAdapter — wires the decoupled `cyrus-loop` orchestrator (Lane C / W4-core) to the
 * EdgeWorker bus and to Linear (W4-adapter + W5).
 *
 * Flow:
 *   prOpened (bus)        → loop.onPrOpened        → capture diff+ledger, run hidden judge
 *   sessionComplete (bus) → loop.onSessionComplete → post the BLIND gate to Linear (this adapter)
 *   user prompt (verdict) → loop.onVerdict         → integrate (gh pr merge) + learn + runs.jsonl
 *
 * The adapter is the single owner of cross-event gate state (keyed by internal issue id, which
 * every event reliably carries) and of the Linear transport. `cyrus-loop` stays forge/tracker-
 * agnostic; EdgeWorker stays loop-agnostic (it only exposes an events bus, a repo→tracker accessor,
 * and an optional verdict interceptor).
 */

import type { IIssueTrackerService, ILogger } from "cyrus-core";
import {
	type CaptureDeps,
	type CmdRun,
	CyrusLoop,
	type Finding,
	type LMBackend,
	loadLoopConfig,
	parseRunId,
	type ResolvedLoopConfig,
	type ReviewPackage,
} from "cyrus-loop";
import type {
	EdgeWorkerEvents,
	LoopVerdictInput,
	PrOpenedEventPayload,
	SessionCompleteEventPayload,
} from "./types.js";

/** The slice of EdgeWorker the adapter depends on — keeps it decoupled from the concrete class. */
export interface CyrusLoopHost {
	on<K extends keyof EdgeWorkerEvents>(
		event: K,
		listener: EdgeWorkerEvents[K],
	): unknown;
	emit<K extends keyof EdgeWorkerEvents>(
		event: K,
		...args: Parameters<EdgeWorkerEvents[K]>
	): boolean;
	getIssueTrackerForRepository(
		repoId: string,
	): IIssueTrackerService | undefined;
	setLoopVerdictInterceptor(
		fn: (input: LoopVerdictInput) => boolean | Promise<boolean>,
	): void;
}

export interface CyrusLoopAdapterDeps {
	host: CyrusLoopHost;
	/** Resolved loop config; when omitted the adapter reads `~/.cyrus/loop.json`. */
	config?: ResolvedLoopConfig;
	/** Inject a pre-built loop (tests). When set, the adapter does NOT attach its own gate poster. */
	loop?: CyrusLoop;
	/** Inject capture plumbing (gh/worktree/ledger) — tests + F1. */
	captureDeps?: CaptureDeps;
	/** Inject the `gh` runner used by Integrate — tests + F1. */
	ghRun?: CmdRun;
	/** Inject the judge LM backend — tests. */
	judgeBackend?: LMBackend;
	logger?: ILogger;
}

/** Per-issue gate state carried between prOpened → sessionComplete → verdict. */
interface GateContext {
	runId: string;
	/** Issue identifier the run_id is keyed on (e.g. `DEV-123`). */
	issueIdentifier: string;
	/** Internal issue id (what the tracker's createComment takes). */
	internalIssueId: string;
	repositoryId: string;
	repoName: string;
	repoDir: string;
	headSha?: string;
	prNumber: number;
}

export interface ParsedVerdict {
	verdict: "approved" | "rejected" | "needs-rework";
	findings: Finding[];
}

const _VERDICT_TAGS = new Set(["recurring", "one-off"]);

/**
 * Parse a diff-gate verdict from a Linear prompt. The first non-empty line must be a verdict
 * command (`/approve`, `/reject`|`/request-changes`, `/rework`|`/needs-rework`); subsequent lines
 * of the form `- <text> :: <recurring|one-off>` become findings. Returns null when the text is not
 * a verdict command, so EdgeWorker's normal prompt flow proceeds unchanged.
 */
export function parseVerdictCommand(text: string): ParsedVerdict | null {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	if (lines.length === 0) return null;
	const head = lines[0]!.toLowerCase();
	let verdict: ParsedVerdict["verdict"];
	if (/^\/approve\b/.test(head)) verdict = "approved";
	else if (/^\/(reject|request-changes)\b/.test(head)) verdict = "rejected";
	else if (/^\/(rework|needs-rework)\b/.test(head)) verdict = "needs-rework";
	else return null;

	const findings: Finding[] = [];
	for (const line of lines.slice(1)) {
		const body = line.replace(/^[-*]\s+/, "");
		const idx = body.lastIndexOf("::");
		if (idx === -1) continue; // prose, not a tagged finding
		const fText = body.slice(0, idx).trim();
		const tag = body.slice(idx + 2).trim();
		if (fText.length === 0 || !_VERDICT_TAGS.has(tag)) continue;
		findings.push({ text: fText, tag, rule_ineffective: null });
	}
	return { verdict, findings };
}

/** Render the mechanical ledger lines the human sees at the gate (never the judge). */
function renderLedger(review: ReviewPackage): string {
	if (review.ledger.length === 0) {
		return "_(no deterministic evidence — the mechanical ledger is empty)_";
	}
	return review.ledger
		.map((e) => {
			const icon =
				e.result === "pass"
					? "✅"
					: e.result === "fail"
						? "❌"
						: e.result === "warn"
							? "⚠️"
							: "•";
			const summary = e.summary ? ` — ${e.summary}` : "";
			return `- ${icon} \`${e.id}\` ${e.kind} (${e.result ?? "skip"})${summary}`;
		})
		.join("\n");
}

export class CyrusLoopAdapter {
	private readonly host: CyrusLoopHost;
	private readonly cfg: ResolvedLoopConfig;
	private readonly loop: CyrusLoop;
	private readonly log?: ILogger;
	private readonly byIssue = new Map<string, GateContext>();
	private readonly byRunId = new Map<string, GateContext>();

	constructor(deps: CyrusLoopAdapterDeps) {
		this.host = deps.host;
		this.cfg = deps.config ?? loadLoopConfig();
		this.log = deps.logger;
		this.loop =
			deps.loop ??
			new CyrusLoop({
				config: this.cfg,
				captureDeps: deps.captureDeps,
				ghRun: deps.ghRun,
				judgeBackend: deps.judgeBackend,
				gate: { postBlindGate: (i) => this.postBlindGate(i) },
			});
	}

	/** Subscribe to the bus + register the verdict interceptor. Call once, before `edgeWorker.start()`. */
	attach(): void {
		// The handlers are internally try/caught (never reject), so returning their promise is safe:
		// EventEmitter ignores it in production, while a test host can await it. Promise<void> is
		// assignable to the void-returning listener signature.
		this.host.on("prOpened", (p) => this.handlePrOpened(p));
		this.host.on("sessionComplete", (p) => this.handleSessionComplete(p));
		this.host.setLoopVerdictInterceptor((input) => this.handleVerdict(input));
		this.log?.info("[cyrus-loop] adapter attached to EdgeWorker bus");
	}

	private async handlePrOpened(p: PrOpenedEventPayload): Promise<void> {
		if (p.provider !== "github") return; // the loop is GitHub-only in this fork
		try {
			const res = await this.loop.onPrOpened({
				repoName: p.repositoryName,
				repoDir: p.repoDir,
				prNumber: p.prNumber,
				headRefName: p.headBranch,
				headRefOid: p.headSha ?? null,
				baseRefName: p.baseBranch ?? null,
				url: p.prUrl ?? null,
				createdAt: p.prCreatedAt ?? "",
			});
			if (res.captured && res.runId) {
				const ctx: GateContext = {
					runId: res.runId,
					issueIdentifier: parseRunId(res.runId).issueId,
					internalIssueId: p.issueId,
					repositoryId: p.repositoryId,
					repoName: p.repositoryName,
					repoDir: p.repoDir,
					headSha: p.headSha,
					prNumber: p.prNumber,
				};
				this.byIssue.set(p.issueId, ctx);
				this.byRunId.set(res.runId, ctx);
				this.log?.info(
					`[cyrus-loop] captured ${res.runId} (judged=${res.judged}${
						res.judgeVerdict ? `, verdict hidden` : ""
					})`,
				);
			} else {
				this.log?.debug?.(
					`[cyrus-loop] PR #${p.prNumber} not captured: ${res.reason ?? "unknown"}`,
				);
			}
		} catch (err) {
			this.log?.error(
				`[cyrus-loop] onPrOpened failed: ${(err as Error).message}`,
			);
		}
	}

	private async handleSessionComplete(
		p: SessionCompleteEventPayload,
	): Promise<void> {
		const ctx = this.byIssue.get(p.issueId);
		if (!ctx) return; // no captured run for this issue — nothing to gate
		try {
			await this.loop.onSessionComplete({
				repoName: ctx.repoName,
				issueId: ctx.issueIdentifier,
				worktree: p.worktree,
				status: p.status,
				prNumber: ctx.prNumber,
			});
		} catch (err) {
			this.log?.error(
				`[cyrus-loop] onSessionComplete failed: ${(err as Error).message}`,
			);
		}
	}

	/** BlindGatePoster wired into the loop: posts the review (diff link + ledger) to Linear. */
	private async postBlindGate(input: {
		runId: string;
		issueId: string;
		review: ReviewPackage;
	}): Promise<void> {
		const ctx = this.byRunId.get(input.runId);
		if (!ctx) {
			this.log?.warn(`[cyrus-loop] no gate context for ${input.runId}`);
			return;
		}
		const tracker = this.host.getIssueTrackerForRepository(ctx.repositoryId);
		if (!tracker) {
			this.log?.warn(
				`[cyrus-loop] no issue tracker for repo ${ctx.repositoryId}; cannot post gate for ${input.runId}`,
			);
			return;
		}
		const body = [
			`## 🔍 Diff gate — \`${input.runId}\` (PR #${ctx.prNumber})`,
			"",
			"Review the diff in the PR, then record your verdict. The automated judge's opinion stays **hidden** until you do (blind gate).",
			"",
			"**Mechanical evidence (ledger):**",
			renderLedger(input.review),
			"",
			"**Record your verdict** by replying with one of:",
			"- `/approve` — merge the PR",
			"- `/reject` — do not merge",
			"- `/rework` — needs a follow-up",
			"",
			"Optionally add findings on their own lines, e.g.:",
			"```",
			"/reject",
			"- missed null check :: recurring",
			"```",
		].join("\n");
		await tracker.createComment(ctx.internalIssueId, { body });
		this.log?.info(
			`[cyrus-loop] posted blind gate for ${input.runId} to issue ${ctx.issueIdentifier}`,
		);
	}

	private async handleVerdict(input: LoopVerdictInput): Promise<boolean> {
		const ctx = this.byIssue.get(input.issueId);
		if (!ctx) return false; // no pending gate for this issue → not ours
		const parsed = parseVerdictCommand(input.text);
		if (!parsed) return false; // not a verdict command → let the normal prompt flow run

		const tracker = this.host.getIssueTrackerForRepository(ctx.repositoryId);
		try {
			const res = await this.loop.onVerdict({
				runId: ctx.runId,
				verdict: parsed.verdict,
				findings: parsed.findings,
				headSha: ctx.headSha ?? null,
				repoName: ctx.repoName,
				repoDir: ctx.repoDir,
			});
			this.byIssue.delete(input.issueId);
			this.byRunId.delete(ctx.runId);
			this.host.emit("verdictReached", {
				runId: ctx.runId,
				verdict: parsed.verdict,
			});
			const merged = res.integrated?.integrated
				? ` — merged PR #${res.integrated.pr} (${res.integrated.merge_commit ?? "?"})`
				: "";
			this.log?.info(
				`[cyrus-loop] recorded ${parsed.verdict} for ${ctx.runId}${merged}`,
			);
			if (tracker) {
				await tracker.createComment(ctx.internalIssueId, {
					body: `✅ Verdict **${parsed.verdict}** recorded for \`${ctx.runId}\`${merged}. Appended to the run ledger.`,
				});
			}
		} catch (err) {
			this.log?.error(
				`[cyrus-loop] onVerdict failed for ${ctx.runId}: ${(err as Error).message}`,
			);
			if (tracker) {
				await tracker.createComment(ctx.internalIssueId, {
					body: `⚠️ Diff gate: failed to record the **${parsed.verdict}** verdict for \`${ctx.runId}\`: ${(err as Error).message}`,
				});
			}
		}
		// Either way it WAS a verdict command — consume it so no Claude session starts.
		return true;
	}
}

/** Construct + attach the loop adapter in one call (used by the app entry points). */
export function attachCyrusLoop(deps: CyrusLoopAdapterDeps): CyrusLoopAdapter {
	const adapter = new CyrusLoopAdapter(deps);
	adapter.attach();
	return adapter;
}
