import type { LinearClient } from "@linear/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Options threaded into the agent-session tools from the harness (or CLI
 * mode, where all three are omitted).
 */
export interface AgentSessionToolsOptions {
	/**
	 * Callback to register a child-to-parent session mapping.
	 * Called when a new agent session is created.
	 */
	onSessionCreated?: (childSessionId: string, parentSessionId: string) => void;

	/**
	 * Callback to deliver feedback to a parent session.
	 * Called when feedback is given to a child session.
	 */
	onFeedbackDelivery?: (
		childSessionId: string,
		message: string,
	) => Promise<boolean>;

	/**
	 * The ID of the current parent session (if any).
	 */
	parentSessionId?: string;
}

/**
 * Register the 5 Linear agent-session tools: create (on issue), create (on
 * comment), give-feedback, list, and get-one.
 */
export function registerAgentSessionTools(
	server: McpServer,
	linearClient: LinearClient,
	options: AgentSessionToolsOptions,
): void {
	server.registerTool(
		"linear_agent_session_create",
		{
			description:
				"Create an agent session on a Linear issue to track AI/bot activity.",
			inputSchema: {
				issueId: z
					.string()
					.describe(
						'The ID or identifier of the Linear issue (e.g., "ABC-123" or UUID)',
					),
				externalLink: z
					.string()
					.optional()
					.describe(
						"Optional URL of an external agent-hosted page associated with this session",
					),
			},
		},
		async ({ issueId, externalLink }) => {
			try {
				const graphQLClient = (linearClient as any).client;

				const mutation = `
					mutation AgentSessionCreateOnIssue($input: AgentSessionCreateOnIssue!) {
						agentSessionCreateOnIssue(input: $input) {
							success
							lastSyncId
							agentSession {
								id
							}
						}
					}
				`;

				const variables = {
					input: {
						issueId,
						...(externalLink && { externalLink }),
					},
				};

				const response = await graphQLClient.rawRequest(mutation, variables);
				const result = response.data.agentSessionCreateOnIssue;

				if (!result.success) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: "Failed to create agent session",
								}),
							},
						],
					};
				}

				const agentSessionId = result.agentSession.id;
				if (options.parentSessionId && options.onSessionCreated) {
					options.onSessionCreated(agentSessionId, options.parentSessionId);
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: result.success,
								agentSessionId,
								lastSyncId: result.lastSyncId,
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
		"linear_agent_session_create_on_comment",
		{
			description:
				"Create an agent session on a Linear root comment (not a reply) to trigger a sub-agent for processing child issues or tasks. See Linear API docs: https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/inputs/AgentSessionCreateOnComment",
			inputSchema: {
				commentId: z
					.string()
					.describe(
						"The ID of the Linear root comment (not a reply) to create the session on",
					),
				externalLink: z
					.string()
					.optional()
					.describe(
						"Optional URL of an external agent-hosted page associated with this session",
					),
			},
		},
		async ({ commentId, externalLink }) => {
			try {
				const graphQLClient = (linearClient as any).client;

				const mutation = `
					mutation AgentSessionCreateOnComment($input: AgentSessionCreateOnComment!) {
						agentSessionCreateOnComment(input: $input) {
							success
							lastSyncId
							agentSession {
								id
							}
						}
					}
				`;

				const variables = {
					input: {
						commentId,
						...(externalLink && { externalLink }),
					},
				};

				const response = await graphQLClient.rawRequest(mutation, variables);
				const result = response.data.agentSessionCreateOnComment;

				if (!result.success) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: "Failed to create agent session on comment",
								}),
							},
						],
					};
				}

				const agentSessionId = result.agentSession.id;
				if (options.parentSessionId && options.onSessionCreated) {
					options.onSessionCreated(agentSessionId, options.parentSessionId);
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: result.success,
								agentSessionId,
								lastSyncId: result.lastSyncId,
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
		"linear_agent_give_feedback",
		{
			description:
				"Provide feedback to a child agent session to continue its processing.",
			inputSchema: {
				agentSessionId: z
					.string()
					.describe("The ID of the child agent session to provide feedback to"),
				message: z
					.string()
					.describe("The feedback message to send to the child agent session"),
			},
		},
		async ({ agentSessionId, message }) => {
			if (!agentSessionId) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: "agentSessionId is required",
							}),
						},
					],
				};
			}

			if (!message) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								success: false,
								error: "message is required",
							}),
						},
					],
				};
			}

			if (options.onFeedbackDelivery) {
				try {
					await options.onFeedbackDelivery(agentSessionId, message);
				} catch (error) {
					console.error("[CyrusTools] Failed to deliver feedback:", error);
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							success: true,
						}),
					},
				],
			};
		},
	);

	server.registerTool(
		"linear_get_agent_sessions",
		{
			description:
				"Get all agent sessions. Returns a paginated list of agent sessions with their details including status, timestamps, and associated issues.",
			inputSchema: {
				first: z
					.number()
					.optional()
					.describe(
						"Number of items to fetch from the beginning (default: 50, max: 250)",
					),
				after: z
					.string()
					.optional()
					.describe("Cursor to start fetching items after"),
				before: z
					.string()
					.optional()
					.describe("Cursor to start fetching items before"),
				last: z
					.number()
					.optional()
					.describe("Number of items to fetch from the end"),
				includeArchived: z
					.boolean()
					.optional()
					.describe(
						"Whether to include archived agent sessions (default: false)",
					),
				orderBy: z
					.enum(["createdAt", "updatedAt"])
					.optional()
					.describe(
						"Field to order results by (default: updatedAt). Can be 'createdAt' or 'updatedAt'",
					),
			},
		},
		async ({
			first = 50,
			after,
			before,
			last,
			includeArchived = false,
			orderBy,
		}) => {
			try {
				const finalFirst = first
					? Math.min(Math.max(1, first), 250)
					: undefined;
				const finalLast = last ? Math.min(Math.max(1, last), 250) : undefined;

				const variables: any = {};
				if (finalFirst !== undefined) variables.first = finalFirst;
				if (after) variables.after = after;
				if (before) variables.before = before;
				if (finalLast !== undefined) variables.last = finalLast;
				if (includeArchived !== undefined)
					variables.includeArchived = includeArchived;
				if (orderBy) variables.orderBy = orderBy;

				const sessionsConnection = await linearClient.agentSessions(variables);
				const sessions = await sessionsConnection.nodes;

				const sessionsData = sessions.map((session) => ({
					id: session.id,
					createdAt: session.createdAt.toISOString(),
					updatedAt: session.updatedAt.toISOString(),
					startedAt: session.startedAt?.toISOString() || null,
					endedAt: session.endedAt?.toISOString() || null,
					dismissedAt: session.dismissedAt?.toISOString() || null,
					archivedAt: session.archivedAt?.toISOString() || null,
					externalLink: session.externalLink || null,
					summary: session.summary || null,
					plan: session.plan || null,
					sourceMetadata: session.sourceMetadata || null,
				}));

				const pageInfo = await sessionsConnection.pageInfo;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									success: true,
									count: sessionsData.length,
									sessions: sessionsData,
									pageInfo: {
										hasNextPage: pageInfo.hasNextPage,
										hasPreviousPage: pageInfo.hasPreviousPage,
										startCursor: pageInfo.startCursor,
										endCursor: pageInfo.endCursor,
									},
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

	server.registerTool(
		"linear_get_agent_session",
		{
			description:
				"Get a single agent session by ID. Returns detailed information about the agent session including its status, timestamps, associated issue, and metadata.",
			inputSchema: {
				sessionId: z
					.string()
					.describe("The ID of the agent session to retrieve (UUID)"),
			},
		},
		async ({ sessionId }) => {
			try {
				const session = await linearClient.agentSession(sessionId);

				if (!session) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									success: false,
									error: `Agent session ${sessionId} not found`,
								}),
							},
						],
					};
				}

				const [issue, creator, appUser, comment, sourceComment, dismissedBy] =
					await Promise.all([
						session.issue,
						session.creator,
						session.appUser,
						session.comment,
						session.sourceComment,
						session.dismissedBy,
					]);

				const sessionData = {
					id: session.id,
					createdAt: session.createdAt.toISOString(),
					updatedAt: session.updatedAt.toISOString(),
					startedAt: session.startedAt?.toISOString() || null,
					endedAt: session.endedAt?.toISOString() || null,
					dismissedAt: session.dismissedAt?.toISOString() || null,
					archivedAt: session.archivedAt?.toISOString() || null,
					externalLink: session.externalLink || null,
					summary: session.summary || null,
					plan: session.plan || null,
					sourceMetadata: session.sourceMetadata || null,
					issue: issue
						? {
								id: issue.id,
								identifier: issue.identifier,
								title: issue.title,
								url: issue.url,
								description: issue.description,
								priority: issue.priority,
								priorityLabel: issue.priorityLabel,
							}
						: null,
					creator: creator
						? {
								id: creator.id,
								name: creator.name,
								email: creator.email,
								displayName: creator.displayName,
							}
						: null,
					appUser: appUser
						? {
								id: appUser.id,
								name: appUser.name,
							}
						: null,
					comment: comment
						? {
								id: comment.id,
								body: comment.body,
								createdAt: comment.createdAt.toISOString(),
							}
						: null,
					sourceComment: sourceComment
						? {
								id: sourceComment.id,
								body: sourceComment.body,
								createdAt: sourceComment.createdAt.toISOString(),
							}
						: null,
					dismissedBy: dismissedBy
						? {
								id: dismissedBy.id,
								name: dismissedBy.name,
								email: dismissedBy.email,
							}
						: null,
				};

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									success: true,
									session: sessionData,
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
