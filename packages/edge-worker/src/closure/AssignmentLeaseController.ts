import type { AssignmentLeaseCandidate, CyrusAgentSession } from "cyrus-core";
import {
	acquireAssignmentLease,
	applyAssignmentLeaseFact,
	isApprovalActionable,
} from "./AssignmentLease.js";
import type {
	PipelineHumanFact,
	PipelineIntegrateResult,
	PipelineMergeFact,
	PipelinePrFact,
	PipelineReview,
	PipelineWatch,
} from "./pipelineSchemas.js";

export interface PipelineClosurePort {
	initialize(): Promise<
		| { available: true; projectPath: string; dataPath: string }
		| { available: false; reason: string }
	>;
	watch(repositoryName: string): Promise<PipelineWatch>;
	readPrFact(runId: string): Promise<PipelinePrFact>;
	review(runId: string): Promise<PipelineReview>;
	readHumanFact(runId: string): Promise<PipelineHumanFact>;
	integrate(
		runId: string,
		repositoryPath: string,
	): Promise<{
		result: PipelineIntegrateResult;
		mergeFact?: PipelineMergeFact;
	}>;
	recordLearning(runId: string, repositoryName: string): Promise<void>;
}

export interface PrPublication {
	sessionId: string;
	repositoryId: string;
	repositoryName: string;
	repositoryPath: string;
	prNumber: number;
	prUrl?: string;
	baseBranch?: string;
	headBranch?: string;
	headSha: string;
}

export interface AssignmentLeaseControllerDeps {
	pipeline: PipelineClosurePort;
	getSession(sessionId: string): CyrusAgentSession | undefined;
	saveSession(session: CyrusAgentSession): Promise<void> | void;
	postGate(input: {
		session: CyrusAgentSession;
		publication: PrPublication;
		candidate: AssignmentLeaseCandidate;
		review: PipelineReview;
	}): Promise<string | undefined>;
	getRepositoryPath(
		session: CyrusAgentSession,
		candidate: AssignmentLeaseCandidate,
	): string;
	resume(session: CyrusAgentSession, prompt: string): Promise<void>;
	getCurrentHeadSha(publication: PrPublication): Promise<string | undefined>;
	onLearningError?(error: Error, session: CyrusAgentSession): void;
	now(): string;
}

/**
 * Reconciles a Cyrus-owned assignment lease from agentic-pipeline facts. The
 * pipeline remains authoritative for evidence and integration; this controller
 * owns only session state, Linear-facing gate publication, and runner resume.
 */
export class AssignmentLeaseController {
	constructor(readonly deps: AssignmentLeaseControllerDeps) {}

	async acquire(sessionId: string): Promise<void> {
		const session = this.requireOmpSession(sessionId);
		const availability = await this.deps.pipeline.initialize();
		if (!availability.available) {
			throw new Error(
				`Deterministic closure unavailable: ${availability.reason}`,
			);
		}
		if (session.assignmentLease && !session.assignmentLease.releasedAt) return;
		session.assignmentLease = acquireAssignmentLease(
			this.deps.now(),
			session.assignmentLease,
		);
		await this.deps.saveSession(session);
	}

	async onRunnerSucceeded(sessionId: string): Promise<void> {
		const session = this.requireOmpSession(sessionId);
		const lease = session.assignmentLease;
		if (!lease) return;
		const transition = applyAssignmentLeaseFact(lease, {
			type: "runner_succeeded",
			at: this.deps.now(),
		});
		if (transition.outcome !== "applied") return;
		session.assignmentLease = transition.lease;
		await this.deps.saveSession(session);
	}

	async onPrPublished(publication: PrPublication): Promise<void> {
		const session = this.requireOmpSession(publication.sessionId);
		if (!session.assignmentLease || session.assignmentLease.releasedAt) return;

		const watch = await this.deps.pipeline.watch(publication.repositoryName);
		const runId = runIdForPr(watch, publication.prNumber);
		if (!runId) {
			throw new Error(`Pipeline did not capture PR #${publication.prNumber}`);
		}
		const fact = await this.deps.pipeline.readPrFact(runId);
		if (
			fact.number !== publication.prNumber ||
			fact.head_sha !== publication.headSha ||
			fact.repo !== publication.repositoryName
		) {
			throw new Error(
				`Pipeline PR fact ${runId} does not match the published candidate`,
			);
		}
		const candidate: AssignmentLeaseCandidate = {
			repositoryId: publication.repositoryId,
			prNumber: fact.number,
			runId: fact.run_id,
			headSha: fact.head_sha,
		};
		const existing = session.assignmentLease;
		if (
			existing.candidate?.runId === candidate.runId &&
			existing.candidate.headSha === candidate.headSha &&
			existing.gateActivityId
		) {
			return;
		}
		const transition = applyAssignmentLeaseFact(existing, {
			type: "captured",
			at: this.deps.now(),
			candidate,
		});
		if (transition.outcome === "refused") {
			throw new Error(`Cannot capture candidate: ${transition.reason}`);
		}
		if (transition.outcome === "applied") {
			session.assignmentLease = transition.lease;
			await this.deps.saveSession(session);
		}

		const review = await this.deps.pipeline.review(candidate.runId);
		const gateActivityId = await this.deps.postGate({
			session,
			publication,
			candidate,
			review,
		});
		if (gateActivityId) {
			session.assignmentLease = {
				...session.assignmentLease!,
				gateActivityId,
				updatedAt: this.deps.now(),
			};
			await this.deps.saveSession(session);
		}
	}

	async reconcile(sessionId: string): Promise<void> {
		const session = this.requireOmpSession(sessionId);
		const lease = session.assignmentLease;
		const candidate = lease?.candidate;
		if (
			!lease ||
			lease.releasedAt ||
			!candidate ||
			lease.state !== "awaiting_gate"
		) {
			return;
		}
		const human = await this.deps.pipeline.readHumanFact(candidate.runId);
		if (human.head_sha !== candidate.headSha) return;

		if (human.verdict === "needs-rework" || human.verdict === "rejected") {
			const transition = applyAssignmentLeaseFact(lease, {
				type: "human_verdict",
				at: this.deps.now(),
				verdict: human.verdict,
				candidate,
				gateActivityId: lease.gateActivityId,
			});
			if (transition.outcome !== "applied") return;
			session.assignmentLease = transition.lease;
			await this.deps.saveSession(session);
			if (human.verdict === "needs-rework") {
				await this.deps.resume(session, remediationPrompt(candidate, human));
			}
			return;
		}

		const repositoryPath = this.deps.getRepositoryPath(session, candidate);
		const currentHeadSha = await this.deps.getCurrentHeadSha({
			sessionId,
			repositoryId: candidate.repositoryId,
			repositoryName: "",
			repositoryPath,
			prNumber: candidate.prNumber,
			headSha: candidate.headSha,
		});
		if (
			!currentHeadSha ||
			!isApprovalActionable(lease, {
				pipelinePr: candidate,
				humanVerdict: { verdict: "approved", headSha: human.head_sha },
				githubHeadSha: currentHeadSha,
			})
		) {
			return;
		}
		const repository = session.repositories.find(
			(entry) => entry.repositoryId === candidate.repositoryId,
		);
		const integration = await this.deps.pipeline.integrate(
			candidate.runId,
			repositoryPath,
		);
		const merge = integration.mergeFact;
		if (
			!integration.result.integrated ||
			!merge ||
			merge.run_id !== candidate.runId ||
			merge.pr !== candidate.prNumber ||
			merge.head_sha !== candidate.headSha
		) {
			return;
		}
		const transition = applyAssignmentLeaseFact(lease, {
			type: "merged",
			at: merge.at,
			candidate,
		});
		if (transition.outcome !== "applied") return;
		session.assignmentLease = transition.lease;
		await this.deps.saveSession(session);
		this.deps.pipeline
			.recordLearning(
				candidate.runId,
				repository?.repositoryId ?? candidate.repositoryId,
			)
			.catch((error: unknown) => {
				this.deps.onLearningError?.(
					error instanceof Error ? error : new Error(String(error)),
					session,
				);
			});
	}

	private requireOmpSession(sessionId: string): CyrusAgentSession {
		const session = this.deps.getSession(sessionId);
		if (!session) throw new Error(`Unknown Cyrus session ${sessionId}`);
		if (session.agentProfileId !== "omp") {
			throw new Error(`Deterministic closure only supports the OMP profile`);
		}
		return session;
	}
}

function runIdForPr(
	watch: PipelineWatch,
	prNumber: number,
): string | undefined {
	for (const result of watch.results) {
		if (!result || typeof result !== "object") continue;
		const record = result as Record<string, unknown>;
		if (record.pr === prNumber && typeof record.run_id === "string") {
			return record.run_id;
		}
	}
	return undefined;
}

function remediationPrompt(
	candidate: AssignmentLeaseCandidate,
	human: PipelineHumanFact,
): string {
	const findings = human.findings
		.map((finding) => `- [${finding.tag}] ${finding.text}`)
		.join("\n");
	return [
		"The human gate requested changes on the current candidate.",
		`Run ID: ${candidate.runId}`,
		`Candidate SHA: ${candidate.headSha}`,
		"Address the tagged findings, run the relevant verification, and push a new commit.",
		"Findings:",
		findings || "- No textual finding was recorded; inspect the gate evidence.",
	].join("\n");
}
