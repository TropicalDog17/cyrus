/**
 * Prompt Assembly Test Utilities
 *
 * Provides a human-readable DSL for testing PromptAssembler.assemble().
 *
 * The harness builds a REAL PromptAssembler wired to a REAL PromptBuilder and a
 * REAL SkillsPluginResolver (so the byte-exact `## Skills` guidance renders),
 * with the Linear-touching collaborators (IIssueTrackerService, GitService,
 * GitHubUsernameResolver) replaced by deterministic stubs. No `(worker as any)`
 * casts remain — the DSL mutates the shared Maps directly.
 */

import {
	createLogger,
	type IIssueTrackerService,
	type ILogger,
	type Issue,
	LogLevel,
	type RepositoryConfig,
} from "cyrus-core";
import { expect } from "vitest";
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

/**
 * Test harness exposing the assembler and its shared collaborator Maps so the
 * scenario DSL (and the routing-context test) can inspect/mutate them.
 */
export interface PromptAssemblyHarness {
	assembler: PromptAssembler;
	promptBuilder: PromptBuilder;
	issueTrackers: Map<string, IIssueTrackerService>;
	repositories: Map<string, RepositoryConfig>;
}

/**
 * Build a minimal mock IssueTrackerService implementing the real methods the
 * prompt builders call: fetchComments, fetchComment, fetchTeams, fetchLabels.
 */
function createMockIssueTracker(): IIssueTrackerService {
	return {
		fetchComments: async () => ({ nodes: [] }),
		fetchComment: async () => ({ user: Promise.resolve(null), body: "" }),
		fetchTeams: async () => ({ nodes: [] }),
		fetchLabels: async () => ({ nodes: [] }),
	} as unknown as IIssueTrackerService;
}

/**
 * Mirror EdgeWorker.buildSkillSessionContext so the injected function behaves
 * identically to production (repoPaths from workspace, team/label passthrough).
 */
function buildSkillSessionContext(
	repository: RepositoryConfig,
	fullIssue?: Issue,
	session?: any,
): SkillSessionContext {
	const repoPaths = session?.workspace?.repoPaths as
		| Record<string, string>
		| undefined;
	let resolvedPaths: string[] = [];
	if (repoPaths) {
		const paths = Object.values(repoPaths).filter(
			(p): p is string => typeof p === "string" && p.length > 0,
		);
		if (paths.length > 0) {
			resolvedPaths = [...new Set(paths)];
		}
	}
	if (resolvedPaths.length === 0) {
		const worktreePath = session?.workspace?.path;
		if (typeof worktreePath === "string" && worktreePath.length > 0) {
			resolvedPaths = [worktreePath];
		}
	}

	const context: SkillSessionContext = {
		repositoryId: repository.id,
		repoPaths: resolvedPaths,
	};
	const anyIssue = fullIssue as any;
	if (anyIssue?.teamId) {
		context.linearTeamId = anyIssue.teamId;
	}
	if (Array.isArray(anyIssue?.labelIds) && anyIssue.labelIds.length > 0) {
		context.linearLabelIds = [...anyIssue.labelIds];
	}
	return context;
}

/**
 * Create a PromptAssembler test harness.
 *
 * @param repositories Repository configs to pre-populate (routing-context tests
 *   rely on these being visible in the PromptBuilder's repositories Map).
 * @param _linearWorkspaceSlug Retained for signature compatibility; unused now
 *   that prompt building no longer reads workspace slugs.
 */
export function createTestWorker(
	repositories: RepositoryConfig[] = [],
	_linearWorkspaceSlug?: string,
): PromptAssemblyHarness {
	const logger: ILogger = createLogger({
		component: "prompt-assembly-test",
		level: LogLevel.SILENT,
	});

	const repositoriesMap = new Map<string, RepositoryConfig>();
	const issueTrackers = new Map<string, IIssueTrackerService>();
	for (const repo of repositories) {
		repositoriesMap.set(repo.id, repo);
		const workspaceKey = repo.linearWorkspaceId ?? repo.id;
		if (!issueTrackers.has(workspaceKey)) {
			issueTrackers.set(workspaceKey, createMockIssueTracker());
		}
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

	const assembler = new PromptAssembler({
		logger,
		promptBuilder,
		skillsPluginResolver,
		buildSkillSessionContext,
	});

	return {
		assembler,
		promptBuilder,
		issueTrackers,
		repositories: repositoriesMap,
	};
}

/**
 * Scenario builder for test cases - provides human-readable DSL
 */
export class PromptScenario {
	private harness: PromptAssemblyHarness;
	private input: any = {};
	private expectedUserPrompt?: string;
	private expectedSystemPrompt?: string;
	private expectedComponents?: string[];
	private expectedPromptType?: string;

	constructor(harness: PromptAssemblyHarness) {
		this.harness = harness;
	}

	// ===== Input Builders =====

	streamingSession() {
		this.input.isStreaming = true;
		this.input.isNewSession = false;
		return this;
	}

	continuationSession() {
		this.input.isStreaming = false;
		this.input.isNewSession = false;
		return this;
	}

	newSession() {
		this.input.isStreaming = false;
		this.input.isNewSession = true;
		return this;
	}

	assignmentBased() {
		this.input.isMentionTriggered = false;
		this.input.isLabelBasedPromptRequested = false;
		return this;
	}

	mentionTriggered() {
		this.input.isMentionTriggered = true;
		this.input.isLabelBasedPromptRequested = false;
		return this;
	}

	labelBasedPromptCommand() {
		this.input.isMentionTriggered = true;
		this.input.isLabelBasedPromptRequested = true;
		return this;
	}

	withUserComment(comment: string) {
		this.input.userComment = comment;
		return this;
	}

	withCommentAuthor(author: string) {
		this.input.commentAuthor = author;
		return this;
	}

	withCommentTimestamp(timestamp: string) {
		this.input.commentTimestamp = timestamp;
		return this;
	}

	withAttachments(manifest: string) {
		this.input.attachmentManifest = manifest;
		return this;
	}

	withPreviousSessionSummary(summary: string) {
		this.input.previousSessionSummary = summary;
		return this;
	}

	withLabels(...labels: string[]) {
		this.input.labels = labels;
		return this;
	}

	withSession(session: any) {
		this.input.session = session;
		return this;
	}

	withIssue(issue: any) {
		this.input.fullIssue = issue;
		return this;
	}

	withRepository(repo: any) {
		// Ensure repo has required fields for prompt assembly (baseBranch, labelPrompts, repositoryPath)
		const fullRepo = {
			baseBranch: "main",
			labelPrompts: {},
			repositoryPath: repo.repositoryPath ?? repo.path ?? "/test/repo",
			linearWorkspaceId: repo.linearWorkspaceId ?? repo.id,
			...repo,
		};
		this.input.repository = fullRepo;
		this.input.repositories = [fullRepo];
		// Also ensure the harness has an IssueTrackerService for this repository
		this.ensureIssueTracker(fullRepo);
		return this;
	}

	withRepositories(repos: any[]) {
		const fullRepos = repos.map((repo) => ({
			baseBranch: "main",
			labelPrompts: {},
			repositoryPath: repo.repositoryPath ?? repo.path ?? "/test/repo",
			linearWorkspaceId: repo.linearWorkspaceId ?? repo.id,
			...repo,
		}));
		this.input.repositories = fullRepos;
		this.input.repository = fullRepos[0];
		for (const repo of fullRepos) {
			this.ensureIssueTracker(repo);
		}
		return this;
	}

	private ensureIssueTracker(repo: any) {
		const workspaceKey = repo.linearWorkspaceId ?? repo.id;
		if (!this.harness.issueTrackers.has(workspaceKey)) {
			this.harness.issueTrackers.set(workspaceKey, createMockIssueTracker());
		}
	}

	withGuidance(guidance: any[]) {
		this.input.guidance = guidance;
		return this;
	}

	withAgentSession(agentSession: any) {
		this.input.agentSession = agentSession;
		return this;
	}

	withMentionTriggered(triggered: boolean) {
		this.input.isMentionTriggered = triggered;
		return this;
	}

	// ===== Expectation Builders =====

	expectUserPrompt(prompt: string) {
		this.expectedUserPrompt = prompt;
		return this;
	}

	expectSystemPrompt(prompt: string | undefined) {
		this.expectedSystemPrompt = prompt;
		return this;
	}

	expectComponents(...components: string[]) {
		this.expectedComponents = components;
		return this;
	}

	expectPromptType(type: string) {
		this.expectedPromptType = type;
		return this;
	}

	// ===== Execution =====

	async build() {
		return await this.harness.assembler.assemble(
			this.input as PromptAssemblyInput,
		);
	}

	async verify() {
		const result = await this.harness.assembler.assemble(
			this.input as PromptAssemblyInput,
		);

		if (this.expectedUserPrompt !== undefined) {
			expect(result.userPrompt).toBe(this.expectedUserPrompt);
		}

		if (this.expectedSystemPrompt !== undefined) {
			expect(result.systemPrompt).toBe(this.expectedSystemPrompt);
		}

		if (this.expectedComponents) {
			expect(result.metadata.components).toEqual(this.expectedComponents);
		}

		if (this.expectedPromptType) {
			expect(result.metadata.promptType).toBe(this.expectedPromptType);
		}

		return result;
	}
}

/**
 * Start building a test scenario
 */
export function scenario(harness: PromptAssemblyHarness): PromptScenario {
	return new PromptScenario(harness);
}
