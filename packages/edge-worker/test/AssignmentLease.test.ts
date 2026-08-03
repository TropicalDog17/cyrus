import { describe, expect, it } from "vitest";
import {
	type AssignmentLease,
	type AssignmentLeaseCandidate,
	acquireAssignmentLease,
	applyAssignmentLeaseFact,
	canAcquireAssignmentLease,
	isApprovalActionable,
} from "../src/closure/AssignmentLease.js";

const at = "2026-08-03T16:00:00.000Z";
const candidateA: AssignmentLeaseCandidate = {
	repositoryId: "repo-1",
	prNumber: 42,
	runId: "RUN-42",
	headSha: "sha-a",
};
const candidateB: AssignmentLeaseCandidate = {
	...candidateA,
	headSha: "sha-b",
};

const working = () => acquireAssignmentLease(at);
const captured = (): AssignmentLease => {
	const transition = applyAssignmentLeaseFact(working(), {
		type: "runner_succeeded",
		at,
	});
	return applyAssignmentLeaseFact(transition.lease, {
		type: "captured",
		at,
		candidate: candidateA,
	}).lease;
};

describe("AssignmentLease", () => {
	it("allows only one unreleased lease per issue and repository", () => {
		const lease = working();
		expect(
			canAcquireAssignmentLease(
				[
					{ issueId: "issue-1", repositoryId: "repo-1", lease },
					{ issueId: "issue-2", repositoryId: "repo-1", lease },
				],
				"issue-1",
				"repo-1",
			),
		).toBe(false);
		expect(
			canAcquireAssignmentLease(
				[{ issueId: "issue-1", repositoryId: "repo-1", lease }],
				"issue-1",
				"repo-2",
			),
		).toBe(true);
	});

	it("keeps a successful runner assignment active while awaiting PR publication", () => {
		const lease = working();
		const transition = applyAssignmentLeaseFact(lease, {
			type: "runner_succeeded",
			at,
		});

		expect(transition).toMatchObject({ outcome: "applied" });
		expect(transition.lease).toMatchObject({
			state: "awaiting_pr",
			generation: 1,
		});
		expect(transition.lease).not.toHaveProperty("releasedAt");
	});

	it("ignores a late runner success after publication was already captured", () => {
		const lease = captured();
		const transition = applyAssignmentLeaseFact(lease, {
			type: "runner_succeeded",
			at: "2026-08-03T16:01:00.000Z",
		});

		expect(transition).toMatchObject({ outcome: "ignored", lease });
	});

	it("captures a candidate at its observed head SHA", () => {
		const transition = applyAssignmentLeaseFact(working(), {
			type: "captured",
			at,
			candidate: candidateA,
		});

		expect(transition.lease).toMatchObject({
			state: "awaiting_gate",
			candidate: candidateA,
		});
	});

	it("retains the lease when a matching review needs rework", () => {
		const lease = captured();
		const transition = applyAssignmentLeaseFact(lease, {
			type: "human_verdict",
			at,
			verdict: "needs-rework",
			candidate: candidateA,
			gateActivityId: "activity-1",
		});

		expect(transition.lease).toMatchObject({
			state: "remediating",
			generation: lease.generation,
			candidate: candidateA,
			gateActivityId: "activity-1",
		});
		expect(transition.lease).not.toHaveProperty("releasedAt");
	});

	it("invalidates SHA-A gate activity when the candidate head advances", () => {
		const lease = {
			...captured(),
			gateActivityId: "activity-a",
		};
		const advanced = applyAssignmentLeaseFact(lease, {
			type: "head_advanced",
			at,
			candidate: candidateB,
		});

		expect(advanced.lease).toMatchObject({
			state: "awaiting_pr",
			candidate: undefined,
			gateActivityId: undefined,
		});
		expect(
			applyAssignmentLeaseFact(advanced.lease, {
				type: "captured",
				at,
				candidate: candidateB,
			}).lease,
		).toMatchObject({ state: "awaiting_gate", candidate: candidateB });
	});

	it("makes approval actionable only when every observed head is identical", () => {
		const lease = captured();
		expect(
			isApprovalActionable(lease, {
				pipelinePr: candidateA,
				humanVerdict: { verdict: "approved", headSha: "sha-a" },
				githubHeadSha: "sha-a",
			}),
		).toBe(true);
		expect(
			isApprovalActionable(lease, {
				pipelinePr: candidateA,
				humanVerdict: { verdict: "approved", headSha: "sha-a" },
				githubHeadSha: "sha-b",
			}),
		).toBe(false);
	});

	it("releases only from needs-input, escalation, or a matching merge", () => {
		for (const fact of [
			{ type: "needs_input", at, reason: "Need a product choice." } as const,
			{ type: "escalated", at, reason: "Human rejected the work." } as const,
			{ type: "merged", at, candidate: candidateA } as const,
		]) {
			const transition = applyAssignmentLeaseFact(
				fact.type === "merged" ? captured() : working(),
				fact,
			);
			expect(transition.lease.releasedAt).toBe(at);
			expect(["needs_input", "escalated", "merged"]).toContain(
				transition.lease.state,
			);
		}
	});

	it("reacquires a needs-input lease as the next generation", () => {
		const released = applyAssignmentLeaseFact(working(), {
			type: "needs_input",
			at,
			reason: "Need a product choice.",
		}).lease;
		const reacquired = acquireAssignmentLease(
			"2026-08-03T16:10:00.000Z",
			released,
		);

		expect(reacquired).toMatchObject({
			generation: 2,
			state: "working",
		});
		expect(reacquired).not.toHaveProperty("releasedAt");
		expect(reacquired).not.toHaveProperty("releaseFact");
	});

	it("does not mutate leases for duplicate or impossible facts", () => {
		const lease = working();
		const duplicate = applyAssignmentLeaseFact(lease, {
			type: "head_advanced",
			at,
			candidate: candidateB,
		});
		expect(duplicate).toMatchObject({ outcome: "ignored" });
		expect(duplicate.lease).toBe(lease);

		const impossible = applyAssignmentLeaseFact(lease, {
			type: "merged",
			at,
			candidate: candidateA,
		});
		expect(impossible).toMatchObject({ outcome: "refused" });
		expect(impossible.lease).toBe(lease);
	});
});
