import type {
	CyrusAgentSession,
	EffortLevel,
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

function buildIssueConfig(
	runnerType: RunnerType,
	effort: EffortLevel | undefined,
) {
	return makeBuilder(runnerType).buildIssueConfig({
		session: makeSession(),
		repository: makeRepository(),
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/repos/repo-a"],
		disallowedTools: [],
		effort,
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
	});
}

describe("RunnerConfigBuilder effort passthrough", () => {
	it("forwards the effort to the Claude runner config when set", () => {
		const { config } = buildIssueConfig("claude", "max");
		expect((config as { effort?: EffortLevel }).effort).toBe("max");
	});

	it("leaves effort unset on the Claude config when not provided", () => {
		const { config } = buildIssueConfig("claude", undefined);
		expect((config as { effort?: EffortLevel }).effort).toBeUndefined();
	});

	it("does not set effort on the Cursor runner config (Cursor has no such knob)", () => {
		const { config, runnerType } = buildIssueConfig("cursor", "max");
		expect(runnerType).toBe("cursor");
		expect((config as { effort?: EffortLevel }).effort).toBeUndefined();
	});
});
