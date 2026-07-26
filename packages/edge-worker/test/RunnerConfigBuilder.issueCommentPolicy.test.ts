import type {
	CyrusAgentSession,
	ILogger,
	RepositoryConfig,
	RunnerType,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import { ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM } from "../src/prompts/issueCommentPolicyPromptAddendum.js";
import {
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(runnerType: RunnerType): RunnerConfigBuilder {
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType }),
		getDefaultModelForRunner: () => "opus",
		getDefaultFallbackModelForRunner: () => "sonnet",
	};
	return new RunnerConfigBuilder(mcpConfigProvider, runnerSelector);
}

function makeRepository(): RepositoryConfig {
	return {
		id: "repo-a",
		name: "Repo A",
		repositoryPath: "/repos/repo-a",
		allowedTools: [],
	} as unknown as RepositoryConfig;
}

function makeSession(): CyrusAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace: { path: "/ws/repo-a", isGitWorktree: true },
	} as unknown as CyrusAgentSession;
}

function buildIssueConfig(runnerType: RunnerType, systemPrompt: string) {
	return makeBuilder(runnerType).buildIssueConfig({
		session: makeSession(),
		repository: makeRepository(),
		sessionId: "sess-1",
		systemPrompt,
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/repos/repo-a"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
	});
}

/**
 * The addendum chain in `buildIssueConfig` is the single hop where this policy
 * can be silently dropped — a hand-written config literal elsewhere that forgets
 * one link would leave the shipped agent with no policy and no failing test. So
 * assert it lands in the built config, not just that the helper composes.
 */
describe("RunnerConfigBuilder issue-comment policy passthrough", () => {
	it("appends the policy to the Claude runner's system prompt", () => {
		const { config } = buildIssueConfig("claude", "You are in builder mode.");
		expect(config.appendSystemPrompt).toContain(
			ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM,
		);
	});

	it("keeps the caller's system prompt ahead of the policy", () => {
		const { config } = buildIssueConfig("claude", "You are in builder mode.");
		const prompt = config.appendSystemPrompt ?? "";
		expect(prompt.indexOf("You are in builder mode.")).toBeGreaterThanOrEqual(
			0,
		);
		expect(prompt.indexOf("You are in builder mode.")).toBeLessThan(
			prompt.indexOf(ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM),
		);
	});

	it("applies on the mention path, where no label-based system prompt exists", () => {
		// Mention-triggered sessions skip the label-based system prompt entirely,
		// which is exactly the case that used to leave comment behavior ungoverned.
		const { config } = buildIssueConfig("claude", "");
		expect(config.appendSystemPrompt).toContain(
			ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM,
		);
	});

	it("applies to the Cursor runner as well", () => {
		const { config, runnerType } = buildIssueConfig("cursor", "Base prompt.");
		expect(runnerType).toBe("cursor");
		expect(config.appendSystemPrompt).toContain(
			ISSUE_COMMENT_POLICY_PROMPT_ADDENDUM,
		);
	});
});
