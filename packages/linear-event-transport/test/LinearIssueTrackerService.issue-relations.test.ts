import { IssueRelationType, type LinearClient } from "@linear/sdk";
import { describe, expect, it, vi } from "vitest";
import { LinearIssueTrackerService } from "../src/LinearIssueTrackerService.js";

/**
 * The issue-relation write seam. Nothing in this repository calls it yet, so
 * these tests are the only thing pinning the SDK call shape a caller will
 * inherit: the platform-agnostic relation kind must arrive at Linear as the
 * matching `IssueRelationType` member, and both sides must pass through as the
 * ids they were given (no identifier resolution, unlike `createIssue`).
 */

function createService(createIssueRelation: (input: unknown) => unknown) {
	const linearClient = {
		client: { request: vi.fn(), setHeader: vi.fn() },
		createIssueRelation,
	} as unknown as LinearClient;
	return new LinearIssueTrackerService(linearClient);
}

/** Resolve the rejection value without letting `toThrow`'s substring match in. */
async function captureError(promise: Promise<unknown>): Promise<Error> {
	const caught = await promise.then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(caught).toBeInstanceOf(Error);
	return caught as Error;
}

describe("LinearIssueTrackerService.createIssueRelation", () => {
	it.each([
		["blocks", IssueRelationType.Blocks],
		["duplicate", IssueRelationType.Duplicate],
		["related", IssueRelationType.Related],
	] as const)("sends kind %s to Linear as IssueRelationType.%s and returns the created relation", async (kind, expectedType) => {
		const createdRelation = { id: "relation-1", type: kind };
		const createIssueRelation = vi.fn().mockResolvedValue({
			success: true,
			issueRelation: Promise.resolve(createdRelation),
		});
		const service = createService(createIssueRelation);

		const relation = await service.createIssueRelation({
			issueId: "id-1",
			relatedIssueId: "id-2",
			type: kind,
		});

		expect(createIssueRelation.mock.calls).toEqual([
			[{ issueId: "id-1", relatedIssueId: "id-2", type: expectedType }],
		]);
		expect(relation).toBe(createdRelation);
	});

	it("rejects when Linear reports the mutation as unsuccessful", async () => {
		const service = createService(
			vi.fn().mockResolvedValue({ success: false, issueRelation: undefined }),
		);

		const error = await captureError(
			service.createIssueRelation({
				issueId: "id-1",
				relatedIssueId: "id-2",
				type: "blocks",
			}),
		);

		expect(error.message).toBe(
			"Failed to create blocks relation from id-1 to id-2: Linear API returned success=false",
		);
	});

	it("rejects when a successful mutation returns no relation", async () => {
		const service = createService(
			vi.fn().mockResolvedValue({ success: true, issueRelation: undefined }),
		);

		const error = await captureError(
			service.createIssueRelation({
				issueId: "id-1",
				relatedIssueId: "id-2",
				type: "related",
			}),
		);

		expect(error.message).toBe(
			"Failed to create related relation from id-1 to id-2: Created relation not returned from Linear API",
		);
	});

	it("wraps a transport failure, naming both sides and keeping the cause", async () => {
		const cause = new Error("linear down");
		const service = createService(vi.fn().mockRejectedValue(cause));

		const error = await captureError(
			service.createIssueRelation({
				issueId: "id-1",
				relatedIssueId: "id-2",
				type: "duplicate",
			}),
		);

		expect(error.message).toBe(
			"Failed to create duplicate relation from id-1 to id-2: linear down",
		);
		expect(error.cause).toBe(cause);
	});
});
