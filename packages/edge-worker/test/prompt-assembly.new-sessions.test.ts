/**
 * Prompt Assembly Tests - New Sessions
 *
 * Tests prompt assembly for new (initial) sessions with full issue context.
 */

import type { IIssueTrackerService } from "cyrus-core";
import { describe, it } from "vitest";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

describe("Prompt Assembly - New Sessions", () => {
	it("assignment-based (no labels) - should have system prompt with shared instructions", async () => {
		const worker = createTestWorker();

		// Create minimal test data
		const session = {
			issueId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			workspace: { path: "/test/repo" },
			metadata: {},
		};

		const issue = {
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			identifier: "CEE-123",
			title: "Fix authentication bug",
			description: "Users cannot log in",
		};

		const repository = {
			id: "repo-uuid-1234-5678-90ab-cdef12345678",
			path: "/test/repo",
		};

		await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("")
			.withLabels()
			.expectUserPrompt(`<context>
  <repository>undefined</repository>
  <working_directory>/test/repo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>a1b2c3d4-e5f6-7890-abcd-ef1234567890</id>
  <identifier>CEE-123</identifier>
  <title>Fix authentication bug</title>
  <description>
Users cannot log in
  </description>
  <state>Unknown</state>
  <priority>None</priority>
  <url></url>
  <assignee>
    <linear_display_name></linear_display_name>
    <linear_profile_url></linear_profile_url>
    <github_username></github_username>
    <github_user_id></github_user_id>
    <github_noreply_email></github_noreply_email>
  </assignee>
</linear_issue>

<linear_comments>
No comments yet.
</linear_comments>`)
			.expectSystemPrompt(`<work_management>
Use TaskCreate and TaskUpdate only when substantial multi-step work benefits from
a visible checklist. Skip task bookkeeping for simple requests.

Use Agent for bounded, independent reconnaissance that would otherwise load many
files into the main conversation. Keep edits and integration decisions in the
main session.
</work_management>


## Skills

You have skills available via the Skill tool: \`debug\`, \`implementation\`, \`investigate\`, \`summarize\`, \`verify-and-ship\`

Choose the appropriate skill based on the context:

- **Code changes requested** (feature, bug fix, refactor): Use \`implementation\` to write code, then \`verify-and-ship\` to run checks and create a PR, then \`summarize\` to narrate results.
- **Bug report or error**: Use \`debug\` to reproduce, root-cause, and fix, then \`verify-and-ship\`, then \`summarize\`.
- **Question or research request**: Use \`investigate\` to search the codebase and provide an answer, then \`summarize\`.
- **PR review feedback** (changes requested): Use \`implementation\` to address review comments, then \`verify-and-ship\`.

Analyze the issue description, labels, and any user comments to determine which workflow fits. Do NOT skip the verify-and-ship step if you made code changes — it ensures quality checks pass and a PR is created.`)
			.expectPromptType("fallback")
			.expectComponents("issue-context")
			.verify();
	});

	it("assignment-based (with user comment) - should include user comment in XML wrapper", async () => {
		const worker = createTestWorker();

		// Create minimal test data
		const session = {
			issueId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
			workspace: { path: "/test/repo" },
			metadata: {},
		};

		const issue = {
			id: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
			identifier: "CEE-456",
			title: "Implement new feature",
			description: "Add payment processing",
		};

		const repository = {
			id: "repo-uuid-2345-6789-01bc-def123456789",
			path: "/test/repo",
		};

		await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("Please add Stripe integration")
			.withLabels()
			.expectUserPrompt(`<context>
  <repository>undefined</repository>
  <working_directory>/test/repo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>b2c3d4e5-f6a7-8901-bcde-f12345678901</id>
  <identifier>CEE-456</identifier>
  <title>Implement new feature</title>
  <description>
Add payment processing
  </description>
  <state>Unknown</state>
  <priority>None</priority>
  <url></url>
  <assignee>
    <linear_display_name></linear_display_name>
    <linear_profile_url></linear_profile_url>
    <github_username></github_username>
    <github_user_id></github_user_id>
    <github_noreply_email></github_noreply_email>
  </assignee>
</linear_issue>

<linear_comments>
No comments yet.
</linear_comments>

<user_comment>
Please add Stripe integration
</user_comment>`)
			.expectSystemPrompt(`<work_management>
Use TaskCreate and TaskUpdate only when substantial multi-step work benefits from
a visible checklist. Skip task bookkeeping for simple requests.

Use Agent for bounded, independent reconnaissance that would otherwise load many
files into the main conversation. Keep edits and integration decisions in the
main session.
</work_management>


## Skills

You have skills available via the Skill tool: \`debug\`, \`implementation\`, \`investigate\`, \`summarize\`, \`verify-and-ship\`

Choose the appropriate skill based on the context:

- **Code changes requested** (feature, bug fix, refactor): Use \`implementation\` to write code, then \`verify-and-ship\` to run checks and create a PR, then \`summarize\` to narrate results.
- **Bug report or error**: Use \`debug\` to reproduce, root-cause, and fix, then \`verify-and-ship\`, then \`summarize\`.
- **Question or research request**: Use \`investigate\` to search the codebase and provide an answer, then \`summarize\`.
- **PR review feedback** (changes requested): Use \`implementation\` to address review comments, then \`verify-and-ship\`.

Analyze the issue description, labels, and any user comments to determine which workflow fits. Do NOT skip the verify-and-ship step if you made code changes — it ensures quality checks pass and a PR is created.`)
			.expectPromptType("fallback")
			.expectComponents("issue-context", "user-comment")
			.verify();
	});

	it("excludes the active routing thread and orders retained comments chronologically", async () => {
		const worker = createTestWorker();
		const repository = {
			id: "repo-routing-context",
			name: "routing-context",
			path: "/test/repo",
		};
		const olderRootTime = new Date("2026-07-14T10:00:00.000Z");
		const olderReplyTime = new Date("2026-07-14T10:01:00.000Z");
		const newerReplyTime = new Date("2026-07-14T10:02:00.000Z");
		const newerRootTime = new Date("2026-07-14T10:03:00.000Z");

		worker.issueTrackers.set(repository.id, {
			fetchComments: async () => ({
				nodes: [
					{
						id: "newer-root",
						body: "Newer context",
						createdAt: newerRootTime,
						parent: Promise.resolve(null),
						user: Promise.resolve({ displayName: "Bob" }),
					},
					{
						id: "routing-selection",
						body: "git@github.com:example/repo",
						createdAt: newerReplyTime,
						parent: Promise.resolve({ id: "routing-root" }),
						user: Promise.resolve({ displayName: "Alice" }),
					},
					{
						id: "older-root",
						body: "Older context",
						createdAt: olderRootTime,
						parent: Promise.resolve(null),
						user: Promise.resolve({ displayName: "Alice" }),
					},
					{
						id: "newer-reply",
						body: "Second detail",
						createdAt: newerReplyTime,
						parent: Promise.resolve({ id: "older-root" }),
						user: Promise.resolve({ displayName: "Bob" }),
					},
					{
						id: "routing-root",
						body: "This thread is for an agent session with cyrusagent.",
						createdAt: olderReplyTime,
						parent: Promise.resolve(null),
						user: Promise.resolve(null),
					},
					{
						id: "older-reply",
						body: "First detail",
						createdAt: olderReplyTime,
						parent: Promise.resolve({ id: "older-root" }),
						user: Promise.resolve({ displayName: "Alice" }),
					},
					{
						id: "routing-question",
						body: "Which repository should I work in?",
						createdAt: olderReplyTime,
						parent: Promise.resolve({ id: "routing-root" }),
						user: Promise.resolve({ displayName: "cyrusagent" }),
					},
				],
			}),
			fetchComment: async () => ({ user: Promise.resolve(null), body: "" }),
			fetchTeams: async () => ({ nodes: [] }),
			fetchLabels: async () => ({ nodes: [] }),
		} as unknown as IIssueTrackerService);

		await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession({
				issueId: "issue-routing-context",
				workspace: { path: "/test/repo" },
				metadata: {},
			})
			.withIssue({
				id: "issue-routing-context",
				identifier: "CEE-789",
				title: "Keep routing out of the prompt",
				description: "Use only task-relevant comments",
			})
			.withRepository(repository)
			.withAgentSession({ comment: { id: "routing-root" } })
			.withUserComment("")
			.withLabels()
			.expectUserPrompt(`<context>
  <repository>routing-context</repository>
  <working_directory>/test/repo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>issue-routing-context</id>
  <identifier>CEE-789</identifier>
  <title>Keep routing out of the prompt</title>
  <description>
Use only task-relevant comments
  </description>
  <state>Unknown</state>
  <priority>None</priority>
  <url></url>
  <assignee>
    <linear_display_name></linear_display_name>
    <linear_profile_url></linear_profile_url>
    <github_username></github_username>
    <github_user_id></github_user_id>
    <github_noreply_email></github_noreply_email>
  </assignee>
</linear_issue>

<linear_comments>
<comment_thread>
	<root_comment>
		<author>@Alice</author>
		<timestamp>${olderRootTime.toLocaleString()}</timestamp>
		<content>
Older context
		</content>
	</root_comment>
  <replies>
		<reply>
			<author>@Alice</author>
			<timestamp>${olderReplyTime.toLocaleString()}</timestamp>
			<content>
First detail
			</content>
		</reply>
		<reply>
			<author>@Bob</author>
			<timestamp>${newerReplyTime.toLocaleString()}</timestamp>
			<content>
Second detail
			</content>
		</reply>
  </replies>
</comment_thread>

<comment_thread>
	<root_comment>
		<author>@Bob</author>
		<timestamp>${newerRootTime.toLocaleString()}</timestamp>
		<content>
Newer context
		</content>
	</root_comment>
</comment_thread>
</linear_comments>`)
			.expectPromptType("fallback")
			.expectComponents("issue-context")
			.verify();
	});
});
