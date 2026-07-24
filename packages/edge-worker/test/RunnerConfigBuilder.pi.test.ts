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

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(): RunnerConfigBuilder {
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({
			runnerType: "claude",
			modelOverride: "opus",
			fallbackModelOverride: "sonnet",
		}),
		getDefaultModelForRunner: (runnerType: RunnerType) =>
			`${runnerType}-default`,
		getDefaultFallbackModelForRunner: (runnerType: RunnerType) =>
			`${runnerType}-fallback`,
	};
	return new RunnerConfigBuilder(mcpConfigProvider, runnerSelector);
}

describe("RunnerConfigBuilder — Pi resume", () => {
	it("pins a persisted Pi session to Pi and forwards its durable session id", () => {
		const session = {
			issueId: "issue-1",
			issue: { identifier: "DEV-111" },
			workspace: { path: "/tmp/dev-111", isGitWorktree: true },
			piSessionId: "pi-session-1",
		} as unknown as CyrusAgentSession;
		const repository = {
			id: "repo-1",
			name: "Cyrus",
			repositoryPath: "/repos/cyrus",
			allowedTools: [],
		} as unknown as RepositoryConfig;

		const result = makeBuilder().buildIssueConfig({
			session,
			repository,
			sessionId: "cyrus-session-1",
			systemPrompt: "Follow the issue.",
			allowedTools: ["Read"],
			allowedDirectories: ["/repos/cyrus"],
			disallowedTools: [],
			resumeSessionId: session.piSessionId,
			cyrusHome: "/tmp/cyrus-home",
			linearWorkspaceId: "workspace-1",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "workspace-1",
		});

		expect(result.runnerType).toBe("pi");
		expect(result.config).toMatchObject({
			model: "pi-default",
			fallbackModel: "pi-fallback",
			resumeSessionId: "pi-session-1",
		});
	});
});
