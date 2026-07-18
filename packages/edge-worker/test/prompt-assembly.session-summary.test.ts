/**
 * Prompt Assembly Tests - Previous Session Summary (cold-resume restart)
 *
 * Asserts that when a new-session prompt carries a `previousSessionSummary`
 * (produced by the cold-resume summarize-and-restart path), a
 * `<previous_session_summary>` component is inserted after issue-context and
 * before user-comment, including the session's branches and the
 * check-before-redoing note.
 */

import { describe, it } from "vitest";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

describe("Prompt Assembly - Previous Session Summary", () => {
	it("inserts the session-summary component after issue context and before the user comment", async () => {
		const worker = createTestWorker();

		const session = {
			issueId: "c3d4e5f6-a7b8-9012-cdef-123456789012",
			workspace: { path: "/test/repo" },
			repositories: [{ branchName: "feature/cee-789" }],
			metadata: {},
		};

		const issue = {
			id: "c3d4e5f6-a7b8-9012-cdef-123456789012",
			identifier: "CEE-789",
			title: "Build new feature",
		};

		const repository = {
			id: "repo-uuid-3456-7890-12cd-ef1234567890",
			path: "/test/repo",
		};

		await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("Add user authentication")
			.withPreviousSessionSummary("Prior work summary here.")
			.withLabels()
			.expectPromptType("fallback")
			.expectComponents("issue-context", "session-summary", "user-comment")
			.expectUserPrompt(`<context>
  <repository>undefined</repository>
  <working_directory>/test/repo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>c3d4e5f6-a7b8-9012-cdef-123456789012</id>
  <identifier>CEE-789</identifier>
  <title>Build new feature</title>
  <description>
No description provided
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

<previous_session_summary>
  <branches>
    <branch>feature/cee-789</branch>
  </branches>
  <summary>
Prior work summary here.
  </summary>
  <note>This summary replaces a prior session that grew too large to resume directly. Work may already exist on the branch above and a pull request may already be open — check the current state with git and gh before redoing anything.</note>
</previous_session_summary>

<user_comment>
Add user authentication
</user_comment>`)
			.verify();
	});
});
