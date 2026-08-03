import type {
	AssignmentLease,
	AssignmentLeaseCandidate,
	EscalationFact,
	MergeFact,
	NeedsInputFact,
} from "cyrus-core";

export type { AssignmentLease, AssignmentLeaseCandidate } from "cyrus-core";

export interface AssignmentLeaseOwner {
	issueId: string;
	repositoryId: string;
	lease?: AssignmentLease;
}

export type AssignmentLeaseFact =
	| { type: "runner_succeeded"; at: string }
	| { type: "captured"; at: string; candidate: AssignmentLeaseCandidate }
	| { type: "head_advanced"; at: string; candidate: AssignmentLeaseCandidate }
	| {
			type: "human_verdict";
			at: string;
			verdict: "approved" | "needs-rework" | "rejected";
			candidate: AssignmentLeaseCandidate;
			gateActivityId?: string;
	  }
	| NeedsInputFact
	| EscalationFact
	| MergeFact;

export type AssignmentLeaseRefusal =
	| "lease_released"
	| "requires_candidate"
	| "candidate_mismatch"
	| "invalid_state";

export type AssignmentLeaseTransition =
	| { outcome: "applied"; lease: AssignmentLease }
	| { outcome: "ignored"; lease: AssignmentLease }
	| {
			outcome: "refused";
			reason: AssignmentLeaseRefusal;
			lease: AssignmentLease;
	  };

export interface ApprovalObservation {
	pipelinePr: AssignmentLeaseCandidate;
	humanVerdict: { verdict: "approved"; headSha?: string };
	githubHeadSha: string;
}

export function acquireAssignmentLease(
	at: string,
	previous?: AssignmentLease,
): AssignmentLease {
	if (!previous) {
		return {
			generation: 1,
			state: "working",
			acquiredAt: at,
			updatedAt: at,
		};
	}

	if (previous.state !== "needs_input" || !previous.releasedAt) {
		throw new Error("Only a released needs-input lease can be reacquired");
	}

	return {
		generation: previous.generation + 1,
		state: "working",
		acquiredAt: at,
		updatedAt: at,
	};
}

export function canAcquireAssignmentLease(
	leases: readonly AssignmentLeaseOwner[],
	issueId: string,
	repositoryId: string,
): boolean {
	return !leases.some(
		(owner) =>
			owner.issueId === issueId &&
			owner.repositoryId === repositoryId &&
			owner.lease &&
			!owner.lease.releasedAt,
	);
}

export function isApprovalActionable(
	lease: AssignmentLease,
	observation: ApprovalObservation,
): boolean {
	return (
		lease.state === "awaiting_gate" &&
		lease.candidate !== undefined &&
		sameCandidate(lease.candidate, observation.pipelinePr) &&
		observation.humanVerdict.verdict === "approved" &&
		observation.humanVerdict.headSha === lease.candidate.headSha &&
		observation.githubHeadSha === lease.candidate.headSha
	);
}

export function applyAssignmentLeaseFact(
	lease: AssignmentLease,
	fact: AssignmentLeaseFact,
): AssignmentLeaseTransition {
	if (lease.releasedAt) return ignored(lease);

	switch (fact.type) {
		case "runner_succeeded":
			return lease.state === "working"
				? applied(lease, { state: "awaiting_pr", updatedAt: fact.at })
				: lease.state === "awaiting_pr" ||
						lease.state === "awaiting_gate" ||
						lease.state === "remediating"
					? ignored(lease)
					: refused(lease, "invalid_state");

		case "captured":
			if (
				lease.state !== "working" &&
				lease.state !== "awaiting_pr" &&
				lease.state !== "remediating"
			) {
				return sameCandidate(lease.candidate, fact.candidate)
					? ignored(lease)
					: refused(lease, "invalid_state");
			}
			return applied(lease, {
				state: "awaiting_gate",
				updatedAt: fact.at,
				candidate: fact.candidate,
				gateActivityId: undefined,
			});

		case "head_advanced":
			if (!lease.candidate) return ignored(lease);
			if (!samePr(lease.candidate, fact.candidate)) {
				return refused(lease, "candidate_mismatch");
			}
			if (lease.candidate.headSha === fact.candidate.headSha)
				return ignored(lease);
			return applied(lease, {
				state: "awaiting_pr",
				updatedAt: fact.at,
				candidate: undefined,
				gateActivityId: undefined,
			});

		case "human_verdict":
			if (!lease.candidate) return refused(lease, "requires_candidate");
			if (!sameCandidate(lease.candidate, fact.candidate)) {
				return refused(lease, "candidate_mismatch");
			}
			if (lease.state !== "awaiting_gate")
				return refused(lease, "invalid_state");
			if (fact.verdict === "needs-rework") {
				return applied(lease, {
					state: "remediating",
					updatedAt: fact.at,
					gateActivityId: fact.gateActivityId,
				});
			}
			if (fact.verdict === "approved") {
				return applied(lease, {
					updatedAt: fact.at,
					gateActivityId: fact.gateActivityId,
				});
			}
			return release(lease, {
				type: "escalated",
				at: fact.at,
				reason: "Human rejected the candidate.",
			});

		case "needs_input":
			return release(lease, fact);

		case "escalated":
			return release(lease, fact);

		case "merged":
			if (!lease.candidate) return refused(lease, "requires_candidate");
			if (!sameCandidate(lease.candidate, fact.candidate)) {
				return refused(lease, "candidate_mismatch");
			}
			if (lease.state !== "awaiting_gate")
				return refused(lease, "invalid_state");
			return release(lease, fact);
	}
}

function applied(
	lease: AssignmentLease,
	update: Partial<AssignmentLease>,
): AssignmentLeaseTransition {
	return { outcome: "applied", lease: { ...lease, ...update } };
}

function ignored(lease: AssignmentLease): AssignmentLeaseTransition {
	return { outcome: "ignored", lease };
}

function refused(
	lease: AssignmentLease,
	reason: AssignmentLeaseRefusal,
): AssignmentLeaseTransition {
	return { outcome: "refused", reason, lease };
}

function release(
	lease: AssignmentLease,
	fact: NeedsInputFact | EscalationFact | MergeFact,
): AssignmentLeaseTransition {
	return applied(lease, {
		state: fact.type,
		updatedAt: fact.at,
		releasedAt: fact.at,
		releaseFact: fact,
	});
}

function sameCandidate(
	left: AssignmentLeaseCandidate | undefined,
	right: AssignmentLeaseCandidate,
): boolean {
	return (
		left !== undefined &&
		left.repositoryId === right.repositoryId &&
		left.prNumber === right.prNumber &&
		left.runId === right.runId &&
		left.headSha === right.headSha
	);
}

function samePr(
	left: AssignmentLeaseCandidate,
	right: AssignmentLeaseCandidate,
): boolean {
	return (
		left.repositoryId === right.repositoryId &&
		left.prNumber === right.prNumber &&
		left.runId === right.runId
	);
}
