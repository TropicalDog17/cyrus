/**
 * PromptAssembler contract tests.
 *
 * Constructs a PromptAssembler DIRECTLY (no EdgeWorker, no scenario DSL) with a
 * mocked IIssueTrackerService, proving the extracted seam produces the full
 * PromptAssemblyResult contract for the streaming, continuation, and
 * new-session/fallback paths.
 */

import {
	createLogger,
	type IIssueTrackerService,
	type Issue,
	LogLevel,
	type RepositoryConfig,
} from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitHubUsernameResolver } from "../src/GitHubUsernameResolver.js";
import type { GitService } from "../src/GitService.js";
import { PromptBuilder } from "../src/PromptBuilder.js";
import { PromptAssembler } from "../src/prompt-assembly/PromptAssembler.js";
import type { PromptAssemblyInput } from "../src/prompt-assembly/types.js";
import {
	type SkillSessionContext,
	SkillsPluginResolver,
} from "../src/SkillsPluginResolver.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

const logger = createLogger({
	component: "prompt-assembler-contract-test",
	level: LogLevel.SILENT,
});

function buildAssembler(
	repositories: RepositoryConfig[] = [],
): PromptAssembler {
	const repositoriesMap = new Map<string, RepositoryConfig>();
	const issueTrackers = new Map<string, IIssueTrackerService>();
	const mockIssueTracker = {
		fetchComments: async () => ({ nodes: [] }),
		fetchComment: async () => ({ user: Promise.resolve(null), body: "" }),
		fetchTeams: async () => ({ nodes: [] }),
		fetchLabels: async () => ({ nodes: [] }),
	} as unknown as IIssueTrackerService;
	for (const repo of repositories) {
		repositoriesMap.set(repo.id, repo);
		issueTrackers.set(repo.linearWorkspaceId ?? repo.id, mockIssueTracker);
	}

	const gitService = {
		sanitizeBranchName: (name?: string) => name ?? "",
		branchExists: async () => false,
		determineBaseBranch: async (_issue: Issue, repo: RepositoryConfig) => ({
			branch: repo.baseBranch,
			source: "default" as const,
		}),
	} as unknown as GitService;

	const gitHubUsernameResolver = {
		resolve: async () => undefined,
	} as unknown as GitHubUsernameResolver;

	const promptBuilder = new PromptBuilder({
		logger,
		repositories: repositoriesMap,
		issueTrackers,
		gitService,
		gitHubUsernameResolver,
	});

	const skillsPluginResolver = new SkillsPluginResolver(
		TEST_CYRUS_HOME,
		logger,
	);

	return new PromptAssembler({
		logger,
		promptBuilder,
		skillsPluginResolver,
		buildSkillSessionContext: (repository): SkillSessionContext => ({
			repositoryId: repository.id,
			repoPaths: [],
		}),
	});
}

const EXPECTED_FALLBACK_SYSTEM_PROMPT = `<task_management_instructions>
CRITICAL: You MUST use the Task tools (TaskCreate, TaskUpdate, TaskGet, TaskList) extensively:
- IMMEDIATELY create a comprehensive task list at the beginning of your work using TaskCreate
- Break down complex tasks into smaller, actionable items
- Update tasks to 'in_progress' when you start them using TaskUpdate
- Update tasks to 'completed' immediately after finishing them using TaskUpdate
- Only have ONE task 'in_progress' at a time
- Add new tasks as you discover them during your work using TaskCreate
- Your first response should focus on creating a thorough task breakdown

Remember: Your first message is internal planning. Use this time to:
1. Thoroughly analyze the issue and requirements
2. Create detailed tasks using TaskCreate
3. Plan your approach systematically
</task_management_instructions>

## Skills

You have skills available via the Skill tool: \`debug\`, \`implementation\`, \`investigate\`, \`summarize\`, \`verify-and-ship\`

Choose the appropriate skill based on the context:

- **Code changes requested** (feature, bug fix, refactor): Use \`implementation\` to write code, then \`verify-and-ship\` to run checks and create a PR, then \`summarize\` to narrate results.
- **Bug report or error**: Use \`debug\` to reproduce, root-cause, and fix, then \`verify-and-ship\`, then \`summarize\`.
- **Question or research request**: Use \`investigate\` to search the codebase and provide an answer, then \`summarize\`.
- **PR review feedback** (changes requested): Use \`implementation\` to address review comments, then \`verify-and-ship\`.

Analyze the issue description, labels, and any user comments to determine which workflow fits. Do NOT skip the verify-and-ship step if you made code changes — it ensures quality checks pass and a PR is created.`;

describe("PromptAssembler contract", () => {
	let savedBot: string | undefined;

	beforeEach(() => {
		savedBot = process.env.GITHUB_BOT_USERNAME;
		delete process.env.GITHUB_BOT_USERNAME;
	});

	afterEach(() => {
		if (savedBot === undefined) {
			delete process.env.GITHUB_BOT_USERNAME;
		} else {
			process.env.GITHUB_BOT_USERNAME = savedBot;
		}
	});

	it("streaming: passes the user comment through verbatim", async () => {
		const assembler = buildAssembler();
		const input = {
			isStreaming: true,
			isNewSession: false,
			userComment: "just this",
		} as unknown as PromptAssemblyInput;

		const result = await assembler.assemble(input);

		expect(result).toEqual({
			systemPrompt: undefined,
			userPrompt: "just this",
			metadata: {
				components: ["user-comment"],
				promptType: "continuation",
				isNewSession: false,
				isStreaming: true,
			},
		});
	});

	it("continuation: wraps the comment in <new_comment> with author/timestamp", async () => {
		const assembler = buildAssembler();
		const input = {
			isStreaming: false,
			isNewSession: false,
			userComment: "follow up",
			commentAuthor: "Alice",
			commentTimestamp: "2025-01-27T12:00:00Z",
		} as unknown as PromptAssemblyInput;

		const result = await assembler.assemble(input);

		expect(result).toEqual({
			systemPrompt: undefined,
			userPrompt: `<new_comment>
  <author>Alice</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
follow up
  </content>
</new_comment>`,
			metadata: {
				components: ["user-comment"],
				promptType: "continuation",
				isNewSession: false,
				isStreaming: false,
			},
		});
	});

	it("new session (fallback): builds full issue context + shared/skills system prompt", async () => {
		const repository = {
			id: "contract-repo-id",
			name: "contract-repo",
			repositoryPath: "/contract/repo",
			baseBranch: "main",
			labelPrompts: {},
			linearWorkspaceId: "ws-contract",
		} as unknown as RepositoryConfig;

		const assembler = buildAssembler([repository]);

		const session = {
			issueId: "issue-1",
			workspace: { path: "/ws/path" },
			metadata: {},
		};
		const issue = {
			id: "issue-1",
			identifier: "CON-1",
			title: "Contract test",
			description: "Body",
		};

		const input = {
			session,
			fullIssue: issue,
			repositories: [repository],
			repository,
			userComment: "",
			isNewSession: true,
			isStreaming: false,
			isMentionTriggered: false,
			isLabelBasedPromptRequested: false,
			labels: [],
		} as unknown as PromptAssemblyInput;

		const result = await assembler.assemble(input);

		expect(result.userPrompt).toBe(`<context>
  <repository>contract-repo</repository>
  <working_directory>/ws/path</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>issue-1</id>
  <identifier>CON-1</identifier>
  <title>Contract test</title>
  <description>
Body
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
</linear_comments>`);
		expect(result.systemPrompt).toBe(EXPECTED_FALLBACK_SYSTEM_PROMPT);
		expect(result.metadata).toEqual({
			components: ["issue-context"],
			promptType: "fallback",
			isNewSession: true,
			isStreaming: false,
		});
	});
});
