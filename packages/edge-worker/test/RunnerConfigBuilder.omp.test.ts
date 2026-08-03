import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import type { OmpRunnerConfig } from "cyrus-omp-runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

let TMP = "/tmp";
beforeAll(() => {
	TMP = mkdtempSync(join(tmpdir(), "omp-builder-test-"));
});
afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

/**
 * OMP canary wiring (PR 1): an `[agent=omp]` session gets the launch-scoped
 * authorization inputs — exact ACP MCP catalog, rendered tool policy, SRT
 * sandbox config, session-private state dir, generated 0600 overlay — and the
 * shared baseline minus the Claude-only fields.
 */
describe("RunnerConfigBuilder — OMP canary", () => {
	const makeBuilder = (persistedProfileId?: string) => {
		const mcpConfigProvider: IMcpConfigProvider = {
			buildMcpConfig: () => ({}),
			buildMergedMcpConfigPath: () => undefined,
			buildExactAcpCatalog: () => ({
				servers: [
					{
						name: "linear",
						url: "https://mcp.linear.app/mcp",
						headers: [{ name: "Authorization", value: "Bearer tok" }],
					},
				],
				diagnostics: [],
			}),
		};
		const runnerSelector: IRunnerSelector = {
			determineRunnerSelection: () => ({
				agentProfileId: persistedProfileId ?? "omp",
				modelOverride: undefined,
				fallbackModelOverride: undefined,
			}),
			getDefaultModelForRunner: () => "opus",
			getDefaultFallbackModelForRunner: () => "sonnet",
		};
		return new RunnerConfigBuilder(mcpConfigProvider, runnerSelector);
	};

	const makeSession = (overrides: Partial<CyrusAgentSession> = {}) =>
		({
			id: "sess-omp-1",
			issueId: "issue-1",
			issue: { identifier: "OMP-1" },
			workspace: { path: join(TMP, "wt"), isGitWorktree: true },
			repositories: [{ repositoryId: "repo-1" }],
			...overrides,
		}) as unknown as CyrusAgentSession;

	const baseInput = (overrides: Record<string, unknown> = {}) => ({
		repository: {
			id: "repo-1",
			name: "Repo One",
			repositoryPath: join(TMP, "repo"),
			allowedTools: [],
		} as unknown as RepositoryConfig,
		sessionId: "sess-omp-1",
		systemPrompt: "You are OMP.",
		allowedTools: ["Read", "Edit", "Bash", "mcp__linear_issue"],
		allowedDirectories: [join(TMP, "repo")],
		disallowedTools: ["mcp__linear_create_attachment"],
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		...overrides,
	});

	it("selects the omp profile and builds an OmpRunnerConfig", () => {
		const builder = makeBuilder();
		const { agentProfileId, config } = builder.buildIssueConfig({
			...baseInput({ cyrusHome: TMP }),
			session: makeSession(),
			labels: [],
			issueDescription: "Use [agent=omp]",
		});

		expect(agentProfileId).toBe("omp");
		const omp = config as OmpRunnerConfig;
		expect(omp.model).toBeUndefined(); // no model inference for the canary
		expect(omp.appendSystemPrompt).toContain("You are OMP.");
		expect(omp.onMessage).toBeDefined();
	});

	it("forwards the exact MCP catalog — and only the catalog", () => {
		const builder = makeBuilder();
		const { config } = builder.buildIssueConfig({
			...baseInput({ cyrusHome: TMP }),
			session: makeSession(),
		});

		const omp = config as OmpRunnerConfig;
		expect(omp.ompMcpServers).toEqual([
			{
				name: "linear",
				url: "https://mcp.linear.app/mcp",
				headers: [{ name: "Authorization", value: "Bearer tok" }],
			},
		]);
	});

	it("renders the tool policy and builds the sandbox + session dir", () => {
		const builder = makeBuilder();
		const { config } = builder.buildIssueConfig({
			...baseInput({ cyrusHome: TMP }),
			session: makeSession(),
		});

		const omp = config as OmpRunnerConfig;
		expect(omp.ompPermissionPolicy).toBeDefined();
		// Allowed built-ins map to OMP kinds; the pruned MCP tool is denied.
		expect(omp.ompPermissionPolicy!.allowsTool("execute")).toBe(true);
		expect(omp.ompPermissionPolicy!.allowsTool("read")).toBe(true);
		expect(omp.ompPermissionPolicy!.allowsTool("mcp__linear_issue")).toBe(true);
		expect(
			omp.ompPermissionPolicy!.allowsTool("mcp__linear_create_attachment"),
		).toBe(false);

		expect(omp.ompSandbox).toBeDefined();
		expect(omp.ompSessionDir).toBe(
			join(TMP, "runner-data", "omp", "sess-omp-1"),
		);
		expect(omp.ompOverlayConfigPath).toBe(
			join(TMP, "runner-data", "omp", "sess-omp-1.overlay.yml"),
		);
	});

	it("keeps Claude-only fields out of the OMP config", () => {
		const builder = makeBuilder();
		const { config } = builder.buildIssueConfig({
			...baseInput({ cyrusHome: TMP }),
			session: makeSession(),
			effort: "high" as never,
			autoCompactWindow: 50_000,
			bashMaxOutputLength: 30_000,
			subagentModel: "haiku",
			plugins: [{ name: "skills" } as never],
		});

		const omp = config as OmpRunnerConfig;
		expect((omp as Record<string, unknown>).effort).toBeUndefined();
		expect((omp as Record<string, unknown>).autoCompactWindow).toBeUndefined();
		expect(
			(omp as Record<string, unknown>).bashMaxOutputLength,
		).toBeUndefined();
		expect((omp as Record<string, unknown>).subagentModel).toBeUndefined();
		expect((omp as Record<string, unknown>).plugins).toBeUndefined();
	});
});
