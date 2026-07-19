import { IssueRelationType, type LinearClient } from "@linear/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerIssueTools(
	server: McpServer,
	linearClient: LinearClient,
): void {
	server.registerTool(
		"linear_set_issue_relation",
		{
			description:
				"Create a relationship between two Linear issues. Use this to set 'blocks', 'related', or 'duplicate' relationships. For Graphite stacking workflows, use 'blocks' type where the blocking issue is the one that must be completed first.",
			inputSchema: {
				issueId: z
					.string()
					.describe(
						"The BLOCKING issue (the one that must complete first). For 'blocks' type: this issue blocks relatedIssueId. Example: 'PROJ-123' or UUID",
					),
				relatedIssueId: z
					.string()
					.describe(
						"The BLOCKED issue (the one that depends on issueId). For 'blocks' type: this issue is blocked by issueId. Example: 'PROJ-124' or UUID",
					),
				type: z
					.enum(["blocks", "related", "duplicate"])
					.describe(
						"The type of relation: 'blocks' (issueId blocks relatedIssueId - use for Graphite stacking), 'related' (issues are related), 'duplicate' (issueId is a duplicate of relatedIssue)",
					),
			},
		},
		async ({ issueId, relatedIssueId, type }) => {
			try {
				const issue = await linearClient.issue(issueId);
				const relatedIssue = await linearClient.issue(relatedIssueId);

				if (!issue) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Issue ${issueId} not found`,
								}),
							},
						],
					};
				}

				if (!relatedIssue) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Related issue ${relatedIssueId} not found`,
								}),
							},
						],
					};
				}

				const relationTypeMap: Record<
					"blocks" | "related" | "duplicate",
					IssueRelationType
				> = {
					blocks: IssueRelationType.Blocks,
					related: IssueRelationType.Related,
					duplicate: IssueRelationType.Duplicate,
				};
				const relationType = relationTypeMap[type];

				const result = await linearClient.createIssueRelation({
					issueId: issue.id,
					relatedIssueId: relatedIssue.id,
					type: relationType,
				});

				const relation = await result.issueRelation;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: true,
								relationId: relation?.id,
								message: `Successfully created '${type}' relation: ${issue.identifier} ${type} ${relatedIssue.identifier}`,
							}),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"linear_get_child_issues",
		{
			description:
				"Get all child issues (sub-issues) for a given Linear issue. Takes an issue identifier like 'CYHOST-91' and returns a list of child issue ids and their titles.",
			inputSchema: {
				issueId: z
					.string()
					.describe(
						"The ID or identifier of the parent issue (e.g., 'CYHOST-91' or UUID)",
					),
				limit: z
					.number()
					.optional()
					.describe(
						"Maximum number of child issues to return (default: 50, max: 250)",
					),
				includeCompleted: z
					.boolean()
					.optional()
					.describe(
						"Whether to include completed child issues (default: true)",
					),
				includeArchived: z
					.boolean()
					.optional()
					.describe(
						"Whether to include archived child issues (default: false)",
					),
			},
		},
		async ({
			issueId,
			limit = 50,
			includeCompleted = true,
			includeArchived = false,
		}) => {
			try {
				const finalLimit = Math.min(Math.max(1, limit), 250);
				const issue = await linearClient.issue(issueId);

				if (!issue) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Issue ${issueId} not found`,
								}),
							},
						],
					};
				}

				const filter: any = {};
				if (!includeCompleted) {
					filter.state = { type: { neq: "completed" } };
				}
				if (!includeArchived) {
					filter.archivedAt = { null: true };
				}

				const childrenConnection = await issue.children({
					first: finalLimit,
					...(Object.keys(filter).length > 0 && { filter }),
				});
				const children = await childrenConnection.nodes;

				const childrenData = await Promise.all(
					children.map(async (child) => {
						const [state, assignee] = await Promise.all([
							child.state,
							child.assignee,
						]);

						return {
							id: child.id,
							identifier: child.identifier,
							title: child.title,
							state: state?.name || "Unknown",
							stateType: state?.type || null,
							assignee: assignee?.name || null,
							assigneeId: assignee?.id || null,
							priority: child.priority,
							priorityLabel: child.priorityLabel,
							createdAt: child.createdAt.toISOString(),
							updatedAt: child.updatedAt.toISOString(),
							url: child.url,
							archivedAt: child.archivedAt?.toISOString() || null,
						};
					}),
				);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									success: true,
									parentIssue: {
										id: issue.id,
										identifier: issue.identifier,
										title: issue.title,
										url: issue.url,
									},
									childCount: childrenData.length,
									children: childrenData,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						},
					],
				};
			}
		},
	);
}
