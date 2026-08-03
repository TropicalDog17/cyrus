import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
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

/**
 * A resumed session must resolve its persisted `agentProfileId`, ignoring
 * changed labels/descriptions — a session never switches harness mid-flight
 * (ADR 0009; the pinning moved to the profile registry in the OMP canary work).
 */
describe("RunnerConfigBuilder — resumed-session profile pinning", () => {
	// Selection says claude (via label + description); the persisted profile
	// says codex. The persisted profile must win.
	const makeBuilder = () => {
		const mcpConfigProvider: IMcpConfigProvider = {
			buildMcpConfig: () => ({}),
			buildMergedMcpConfigPath: () => undefined,
		};
		const runnerSelector: IRunnerSelector = {
			determineRunnerSelection: () => ({
				agentProfileId: "claude",
				modelOverride: "opus",
				fallbackModelOverride: "sonnet",
			}),
			getDefaultModelForRunner: () => "opus",
			getDefaultFallbackModelForRunner: () => "sonnet",
		};
		return new RunnerConfigBuilder(mcpConfigProvider, runnerSelector);
	};

	const makeSession = (profileId: string, runnerSessionId: string) =>
		({
			issueId: "issue-1",
			issue: { identifier: "ABC-1" },
			workspace: { path: "/ws/repo-a", isGitWorktree: true },
			agentProfileId: profileId,
			runnerSessionId,
		}) as unknown as CyrusAgentSession;

	const baseInput = {
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
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
	};

	it("keeps the persisted agentProfileId when selectors changed", () => {
		const builder = makeBuilder();
		const { agentProfileId, config } = builder.buildIssueConfig({
			...baseInput,
			session: makeSession("codex", "codex-runner-1"),
			labels: ["claude"],
			issueDescription: "Use [agent=claude] now",
			resumeSessionId: "codex-runner-1",
		});

		expect(agentProfileId).toBe("codex");
		// Model/fallback reset to the pinned profile's defaults.
		expect(config.model).toBe("opus");
		expect(config.fallbackModel).toBe("sonnet");
		expect(config.resumeSessionId).toBe("codex-runner-1");
	});

	it("pins to the omp canary for a resumed omp session", () => {
		const builder = makeBuilder();
		const build = () =>
			builder.buildIssueConfig({
				...baseInput,
				session: makeSession("omp", "omp-runner-1"),
				labels: ["claude"],
				issueDescription: "Use [agent=claude] now",
				resumeSessionId: "omp-runner-1",
			});

		// The pin happens even though omp is not default-eligible: resuming is
		// not defaulting. omp's buildConfig is wired in a later PR; until then
		// the profile fails closed rather than silently building a claude config
		// for a resumed omp session. The wiring PR replaces this throw assertion
		// with config-shape assertions.
		expect(() => build()).toThrow(
			/OMP profile is registered but its runner is not wired/,
		);
	});
});
