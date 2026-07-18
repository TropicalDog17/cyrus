/**
 * PromptBuilder timestamp tests.
 *
 * Prompt assembly must use the event's own timestamps (deterministic ISO) rather
 * than wall-clock `new Date()` values or locale-dependent `toLocaleString()`, so
 * re-assembled prompts stay byte-identical and the cache prefix stays stable.
 *
 * Covers:
 *  - buildIssueUpdatePrompt renders the passed timestamp, and omits the
 *    <timestamp> line entirely when none is supplied.
 *  - buildIssueContextPrompt fills {{new_comment_timestamp}} from the fetched
 *    comment's createdAt as ISO.
 */

import {
	createLogger,
	type IIssueTrackerService,
	type Issue,
	LogLevel,
	type RepositoryConfig,
	type WebhookComment,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import type { GitHubUsernameResolver } from "../src/GitHubUsernameResolver.js";
import type { GitService } from "../src/GitService.js";
import { PromptBuilder } from "../src/PromptBuilder.js";

const logger = createLogger({
	component: "prompt-builder-timestamps-test",
	level: LogLevel.SILENT,
});

function buildPromptBuilder(
	issueTrackers: Map<string, IIssueTrackerService> = new Map(),
): PromptBuilder {
	const gitService = {
		sanitizeBranchName: (name?: string) => name ?? "",
	} as unknown as GitService;
	const gitHubUsernameResolver = {
		resolve: async () => undefined,
	} as unknown as GitHubUsernameResolver;

	return new PromptBuilder({
		logger,
		repositories: new Map(),
		issueTrackers,
		gitService,
		gitHubUsernameResolver,
	});
}

describe("PromptBuilder.buildIssueUpdatePrompt", () => {
	it("renders the supplied timestamp", () => {
		const builder = buildPromptBuilder();

		const prompt = builder.buildIssueUpdatePrompt(
			"TEST-1",
			{ title: "New" },
			{ title: "Old" },
			"2026-07-17T10:00:00.000Z",
		);

		expect(prompt).toBe(`<issue_update>
  <identifier>TEST-1</identifier>
  <timestamp>2026-07-17T10:00:00.000Z</timestamp>
  <title_change>
    <old_title>Old</old_title>
    <new_title>New</new_title>
  </title_change>
</issue_update>

<guidance>
  The issue has been updated while you are working on it. Please evaluate whether these changes
  affect your current implementation or action plan. Consider the following:
  - Does the updated content change the requirements or scope of your work?
  - Are there new details, clarifications, or attachments that should inform your approach?
  - Should you adjust your implementation strategy based on this update?
  If the changes are relevant, incorporate them into your work. If not, you may continue as planned.
</guidance>`);
	});

	it("omits the <timestamp> line when no source timestamp exists", () => {
		const builder = buildPromptBuilder();

		const prompt = builder.buildIssueUpdatePrompt(
			"TEST-1",
			{ title: "New" },
			{ title: "Old" },
		);

		expect(prompt).toBe(`<issue_update>
  <identifier>TEST-1</identifier>
  <title_change>
    <old_title>Old</old_title>
    <new_title>New</new_title>
  </title_change>
</issue_update>

<guidance>
  The issue has been updated while you are working on it. Please evaluate whether these changes
  affect your current implementation or action plan. Consider the following:
  - Does the updated content change the requirements or scope of your work?
  - Are there new details, clarifications, or attachments that should inform your approach?
  - Should you adjust your implementation strategy based on this update?
  If the changes are relevant, incorporate them into your work. If not, you may continue as planned.
</guidance>`);
	});
});

describe("PromptBuilder.buildIssueContextPrompt new comment timestamp", () => {
	it("fills {{new_comment_timestamp}} from the fetched comment createdAt as ISO", async () => {
		const issueTrackers = new Map<string, IIssueTrackerService>();
		issueTrackers.set("ws-1", {
			fetchComments: async () => ({ nodes: [] }),
			fetchComment: async () => ({
				user: Promise.resolve({ displayName: "Dana" }),
				createdAt: new Date("2026-07-17T10:54:51.489Z"),
			}),
		} as unknown as IIssueTrackerService);

		const builder = buildPromptBuilder(issueTrackers);

		const repository = {
			id: "repo-1",
			name: "my-repo",
			repositoryPath: "/work/repo",
			baseBranch: "main",
			linearWorkspaceId: "ws-1",
			labelPrompts: {},
		} as unknown as RepositoryConfig;

		const issue = {
			id: "issue-1",
			identifier: "TEST-1",
			title: "Fix bug",
			description: "Please fix",
			url: "",
			branchName: "test-1",
			state: Promise.resolve({ name: "Todo" }),
		} as unknown as Issue;

		const newComment = {
			id: "comment-1",
			body: "Please prioritize this",
			createdAt: "2026-07-17T09:00:00.000Z",
		} as unknown as WebhookComment;

		const { prompt } = await builder.buildIssueContextPrompt(
			issue,
			[repository],
			newComment,
			"",
			undefined,
			{ "repo-1": { branch: "main", source: "default" } },
		);

		expect(prompt).toBe(`<context>
  <repository>my-repo</repository>
  <working_directory>/work/repo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>issue-1</id>
  <identifier>TEST-1</identifier>
  <title>Fix bug</title>
  <description>
Please fix
  </description>
  <state>Todo</state>
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

<new_comment_to_address>
	<author>Dana</author>
	<timestamp>2026-07-17T10:54:51.489Z</timestamp>
	<content>
Please prioritize this
	</content>
</new_comment_to_address>

IMPORTANT: Focus specifically on addressing the new comment above. This is a new request that requires your attention.`);
	});
});
