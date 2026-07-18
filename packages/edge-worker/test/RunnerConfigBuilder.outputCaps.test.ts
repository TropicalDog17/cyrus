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
	caps: { bashMaxOutputLength?: number; mcpMaxOutputTokens?: number },
) {
	return makeBuilder(runnerType).buildIssueConfig({
		session: makeSession(),
		repository: makeRepository(),
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/repos/repo-a"],
		disallowedTools: [],
		bashMaxOutputLength: caps.bashMaxOutputLength,
		mcpMaxOutputTokens: caps.mcpMaxOutputTokens,
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
	});
}

type OutputCapConfig = {
	bashMaxOutputLength?: number;
	mcpMaxOutputTokens?: number;
};

describe("RunnerConfigBuilder tool-output caps passthrough", () => {
	it("forwards both caps to the Claude runner config when set", () => {
		const { config } = buildIssueConfig("claude", {
			bashMaxOutputLength: 30000,
			mcpMaxOutputTokens: 25000,
		});
		expect((config as OutputCapConfig).bashMaxOutputLength).toBe(30000);
		expect((config as OutputCapConfig).mcpMaxOutputTokens).toBe(25000);
	});

	it("forwards each cap independently of the other", () => {
		const { config } = buildIssueConfig("claude", {
			bashMaxOutputLength: 30000,
		});
		expect((config as OutputCapConfig).bashMaxOutputLength).toBe(30000);
		expect((config as OutputCapConfig).mcpMaxOutputTokens).toBeUndefined();
	});

	it("leaves both caps unset on the Claude config when not provided", () => {
		const { config } = buildIssueConfig("claude", {});
		expect((config as OutputCapConfig).bashMaxOutputLength).toBeUndefined();
		expect((config as OutputCapConfig).mcpMaxOutputTokens).toBeUndefined();
	});

	it("does not set the caps on the Cursor runner config (Cursor manages its own tool output)", () => {
		const { config, runnerType } = buildIssueConfig("cursor", {
			bashMaxOutputLength: 30000,
			mcpMaxOutputTokens: 25000,
		});
		expect(runnerType).toBe("cursor");
		expect((config as OutputCapConfig).bashMaxOutputLength).toBeUndefined();
		expect((config as OutputCapConfig).mcpMaxOutputTokens).toBeUndefined();
	});
});
