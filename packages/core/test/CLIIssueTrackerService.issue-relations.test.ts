import { beforeEach, describe, expect, it } from "vitest";
import { CLIIssueTrackerService } from "../src/issue-tracker/adapters/CLIIssueTrackerService";
import type { Issue } from "../src/issue-tracker/types";

/**
 * The CLI tracker's half of the issue-relation write seam. F1 drives read
 * relations back off an issue, so a relation written here has to be visible
 * through `inverseRelations()` — the same direction Linear reports, i.e. from
 * the issue being pointed at, not the one declaring the relation.
 */
describe("CLIIssueTrackerService - Issue Relations", () => {
	let service: CLIIssueTrackerService;
	let blocker: Issue;
	let blocked: Issue;

	beforeEach(async () => {
		service = new CLIIssueTrackerService();
		service.seedDefaultData();
		blocker = await service.createIssue({
			teamId: "team-default",
			title: "Blocker",
		});
		blocked = await service.createIssue({
			teamId: "team-default",
			title: "Blocked",
		});
	});

	it("reads a created relation back through the related issue's inverseRelations", async () => {
		const created = await service.createIssueRelation({
			issueId: blocker.id,
			relatedIssueId: blocked.id,
			type: "blocks",
		});

		const relations = await (await service.fetchIssue(blocked.id))
			.inverseRelations()
			.then((connection) => connection.nodes);

		expect(relations.map((relation) => relation.id)).toEqual([created.id]);
		expect(relations[0].type).toBe("blocks");
		expect((await relations[0].issue)?.id).toBe(blocker.id);
		expect((await relations[0].relatedIssue)?.id).toBe(blocked.id);
	});

	// `inverseRelations()` is a query on Linear, so it is one here too. The
	// handle below was obtained before the relation existed, which is exactly how
	// `GitService.fetchBlockingIssues` holds it: the issue was fetched when the
	// session started, and the relation is written later in the same session.
	it("reports a relation written after the issue handle was obtained", async () => {
		const created = await service.createIssueRelation({
			issueId: blocker.id,
			relatedIssueId: blocked.id,
			type: "blocks",
		});

		const relations = await blocked
			.inverseRelations()
			.then((connection) => connection.nodes);

		expect(relations.map((relation) => relation.id)).toEqual([created.id]);
		expect((await relations[0].issue)?.id).toBe(blocker.id);
	});

	it("leaves the declaring issue's inverseRelations empty", async () => {
		await service.createIssueRelation({
			issueId: blocker.id,
			relatedIssueId: blocked.id,
			type: "blocks",
		});

		const relations = await (await service.fetchIssue(blocker.id))
			.inverseRelations()
			.then((connection) => connection.nodes);

		expect(relations).toEqual([]);
	});

	it("keeps every relation pointing at the same issue, in write order", async () => {
		const second = await service.createIssue({
			teamId: "team-default",
			title: "Second blocker",
		});

		const first = await service.createIssueRelation({
			issueId: blocker.id,
			relatedIssueId: blocked.id,
			type: "blocks",
		});
		const duplicate = await service.createIssueRelation({
			issueId: second.id,
			relatedIssueId: blocked.id,
			type: "duplicate",
		});

		const relations = await (await service.fetchIssue(blocked.id))
			.inverseRelations()
			.then((connection) => connection.nodes);

		expect(
			relations.map((relation) => ({
				id: relation.id,
				type: relation.type,
			})),
		).toEqual([
			{ id: first.id, type: "blocks" },
			{ id: duplicate.id, type: "duplicate" },
		]);
	});

	it("rejects a relation whose declaring issue does not exist", async () => {
		await expect(
			service.createIssueRelation({
				issueId: "issue-missing",
				relatedIssueId: blocked.id,
				type: "blocks",
			}),
		).rejects.toThrowError(new Error("Issue issue-missing not found"));
	});

	it("rejects a relation whose related issue does not exist", async () => {
		await expect(
			service.createIssueRelation({
				issueId: blocker.id,
				relatedIssueId: "issue-missing",
				type: "blocks",
			}),
		).rejects.toThrowError(new Error("Issue issue-missing not found"));
	});
});
