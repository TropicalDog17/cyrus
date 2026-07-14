import type {
	CyrusAgentSession,
	ILogger,
	RepositoryConfig,
	RunnerType,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
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

function buildIssueConfig(
	runnerType: RunnerType,
	subagentModel: string | undefined,
) {
	return makeBuilder(runnerType).buildIssueConfig({
		session: {
			issueId: "issue-1",
			issue: { identifier: "ABC-1" },
			workspace: { path: "/ws/repo-a", isGitWorktree: true },
		} as unknown as CyrusAgentSession,
		repository: {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repos/repo-a",
			allowedTools: [],
		} as unknown as RepositoryConfig,
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/repos/repo-a"],
		disallowedTools: [],
		subagentModel,
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
	});
}

describe("RunnerConfigBuilder — explore subagent model", () => {
	it("forwards the configured model to the Claude runner config", () => {
		const { config } = buildIssueConfig("claude", "haiku");
		expect((config as { subagentModel?: string }).subagentModel).toBe("haiku");
	});

	it("leaves it unset when unconfigured, so delegation keeps inheriting the session model", () => {
		const { config } = buildIssueConfig("claude", undefined);
		expect(
			(config as { subagentModel?: string }).subagentModel,
		).toBeUndefined();
	});

	it("does not set it on the Cursor config (Cursor has no agent registration)", () => {
		const { config, runnerType } = buildIssueConfig("cursor", "haiku");
		expect(runnerType).toBe("cursor");
		expect(
			(config as { subagentModel?: string }).subagentModel,
		).toBeUndefined();
	});
});
