import { readFile } from "node:fs/promises";
import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import type { LinearAgentSessionCreatedWebhook, RunnerType } from "cyrus-core";
import {
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedWebhook,
} from "cyrus-core";
import { CursorRunner } from "cyrus-cursor-runner";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { composeEdgeWorker, type EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
}));

// Mock dependencies
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-cursor-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		isAgentSessionCreatedWebhook: vi.fn(),
		isAgentSessionPromptedWebhook: vi.fn(),
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});
vi.mock("file-type");

/**
 * This fork runs Claude (default) and Cursor. These tests verify that:
 * - the Claude runner is selected by default and via claude/model labels
 * - the Cursor runner is selected via a `cursor` label, `[agent=cursor]` tag,
 *   or a `composer-*` model label
 * - the model is resolved from labels + `[model=...]` description tags
 * - session continuation resumes the existing runner session
 */
describe("EdgeWorker - Runner Selection Based on Labels", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let mockLinearClient: any;
	let mockClaudeRunner: any;
	let mockAgentSessionManager: any;
	let capturedRunnerType: RunnerType | null = null;
	let capturedRunnerConfig: any = null;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		allowedTools: ["Read", "Edit"],
	};

	function createMockIssueWithLabels(
		labels: string[],
		description: string = "Test description",
	) {
		return {
			id: "issue-123",
			identifier: "TEST-123",
			title: "Test Issue",
			description,
			url: "https://linear.app/test/issue/TEST-123",
			branchName: "test-branch",
			state: { name: "Todo" },
			team: { id: "team-123" },
			labels: vi.fn().mockResolvedValue({
				nodes: labels.map((name) => ({ name })),
			}),
		};
	}

	function createWebhook(): LinearAgentSessionCreatedWebhook {
		return {
			type: "Issue",
			action: "agentSessionCreated",
			organizationId: "test-workspace",
			agentSession: {
				id: "agent-session-123",
				issue: {
					id: "issue-123",
					identifier: "TEST-123",
					team: { key: "TEST" },
				},
				comment: { body: "@cyrus work on this" },
			},
		} as LinearAgentSessionCreatedWebhook;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		capturedRunnerType = null;
		capturedRunnerConfig = null;

		// Mock console methods
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		// Mock LinearClient
		mockLinearClient = {
			issue: vi.fn(),
			workflowStates: vi.fn().mockResolvedValue({
				nodes: [
					{ id: "state-1", name: "Todo", type: "unstarted", position: 0 },
					{ id: "state-2", name: "In Progress", type: "started", position: 1 },
				],
			}),
			updateIssue: vi.fn().mockResolvedValue({ success: true }),
			createAgentActivity: vi.fn().mockResolvedValue({ success: true }),
			comments: vi.fn().mockResolvedValue({ nodes: [] }),
			rawRequest: vi.fn(),
		};
		vi.mocked(LinearClient).mockImplementation(function () {
			return mockLinearClient;
		});

		// Mock ClaudeRunner
		mockClaudeRunner = {
			supportsStreamingInput: true,
			start: vi.fn().mockResolvedValue({ sessionId: "claude-session-123" }),
			startStreaming: vi
				.fn()
				.mockResolvedValue({ sessionId: "claude-session-123" }),
			stop: vi.fn(),
			isStreaming: vi.fn().mockReturnValue(false),
			addStreamMessage: vi.fn(),
			updatePromptVersions: vi.fn(),
		};
		vi.mocked(ClaudeRunner).mockImplementation(function (config: any) {
			capturedRunnerType = "claude";
			capturedRunnerConfig = config;
			return mockClaudeRunner;
		});

		// Mock CursorRunner
		const mockCursorRunner = {
			supportsStreamingInput: false,
			start: vi.fn().mockResolvedValue({ sessionId: "cursor-session-123" }),
			stop: vi.fn(),
			isStreaming: vi.fn().mockReturnValue(false),
			getFormatter: vi.fn(),
		};
		vi.mocked(CursorRunner).mockImplementation(function (config: any) {
			capturedRunnerType = "cursor";
			capturedRunnerConfig = config;
			return mockCursorRunner as any;
		});

		// Mock AgentSessionManager
		mockAgentSessionManager = {
			createCyrusAgentSession: vi.fn(),
			getSession: vi.fn().mockReturnValue({
				issueId: "issue-123",
				workspace: { path: "/test/workspaces/TEST-123" },
			}),
			addAgentRunner: vi.fn(),
			getAllAgentRunners: vi.fn().mockReturnValue([]),
			serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
			restoreState: vi.fn(),
			postAnalyzingThought: vi.fn().mockResolvedValue(null),
			createThoughtActivity: vi.fn().mockResolvedValue(undefined),
			setActivitySink: vi.fn(),
			on: vi.fn(), // EventEmitter method
		};
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		});

		// Mock SharedApplicationServer
		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			};
		} as any);

		// Mock LinearEventTransport
		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return {
				register: vi.fn(),
				on: vi.fn(),
				removeAllListeners: vi.fn(),
			};
		} as any);

		// Mock type guards
		vi.mocked(isAgentSessionCreatedWebhook).mockReturnValue(true);
		vi.mocked(isAgentSessionPromptedWebhook).mockReturnValue(false);

		// Mock readFile
		vi.mocked(readFile).mockImplementation(async () => {
			return `<version-tag value="default-v1.0.0" />
# Default Template

Repository: {{repository_name}}
Issue: {{issue_identifier}}`;
		});

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/TEST-123",
					isGitWorktree: false,
				}),
			},
		};

		edgeWorker = composeEdgeWorker(mockConfig);

		// Inject mock issue tracker
		const mockIssueTracker = {
			fetchIssue: vi.fn().mockImplementation(async (issueId: string) => {
				return mockLinearClient.issue(issueId);
			}),
			getIssueLabels: vi.fn(),
			getClient: vi.fn().mockReturnValue({}),
		};
		(edgeWorker as any).issueTrackers.set(
			mockRepository.linearWorkspaceId,
			mockIssueTracker,
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("Claude Runner Selection", () => {
		it("should select Claude runner when 'claude' label is present", async () => {
			const mockIssue = createMockIssueWithLabels(["claude"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createWebhook(),
				[mockRepository],
			);

			expect(capturedRunnerType).toBe("claude");
			expect(ClaudeRunner).toHaveBeenCalled();
		});

		it("should select Claude runner when 'sonnet' label is present", async () => {
			const mockIssue = createMockIssueWithLabels(["sonnet"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createWebhook(),
				[mockRepository],
			);

			expect(capturedRunnerType).toBe("claude");
			expect(ClaudeRunner).toHaveBeenCalled();
			expect(capturedRunnerConfig.model).toBe("sonnet");
		});

		it("should select Claude runner with 'opus' model when 'opus' label is present", async () => {
			const mockIssue = createMockIssueWithLabels(["opus"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createWebhook(),
				[mockRepository],
			);

			expect(capturedRunnerType).toBe("claude");
			expect(ClaudeRunner).toHaveBeenCalled();
			expect(capturedRunnerConfig.model).toBe("opus");
		});
	});

	describe("Cursor Runner Selection", () => {
		it("should select Cursor runner when 'cursor' label is present", async () => {
			const mockIssue = createMockIssueWithLabels(["cursor"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createWebhook(),
				[mockRepository],
			);

			expect(capturedRunnerType).toBe("cursor");
			expect(CursorRunner).toHaveBeenCalled();
			expect(ClaudeRunner).not.toHaveBeenCalled();
			expect(capturedRunnerConfig.model).toBe("composer-2.5");
		});

		it("should select Cursor runner via the [agent=cursor] description tag", async () => {
			const mockIssue = createMockIssueWithLabels(
				[],
				"Please refactor this [agent=cursor]",
			);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createWebhook(),
				[mockRepository],
			);

			expect(capturedRunnerType).toBe("cursor");
			expect(CursorRunner).toHaveBeenCalled();
		});

		it("should select Cursor runner when a 'composer-*' model label is present", async () => {
			const mockIssue = createMockIssueWithLabels(["composer-2.5"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createWebhook(),
				[mockRepository],
			);

			expect(capturedRunnerType).toBe("cursor");
			expect(CursorRunner).toHaveBeenCalled();
			expect(capturedRunnerConfig.model).toBe("composer-2.5");
		});
	});

	describe("Description Tag Selection", () => {
		it("should select model from [model=...] description tag", async () => {
			const mockIssue = createMockIssueWithLabels(
				[],
				"Fix this bug [model=sonnet]",
			);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createWebhook(),
				[mockRepository],
			);

			expect(capturedRunnerType).toBe("claude");
			expect(capturedRunnerConfig.model).toBe("sonnet");
		});

		it("should let the [model=...] description tag override the label model", async () => {
			const mockIssue = createMockIssueWithLabels(
				["opus"],
				"Fix this bug [model=haiku]",
			);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createWebhook(),
				[mockRepository],
			);

			expect(capturedRunnerType).toBe("claude");
			expect(capturedRunnerConfig.model).toBe("haiku");
		});
	});

	describe("Default Runner Selection", () => {
		it("should default to Claude runner when no runner-related labels are present", async () => {
			const mockIssue = createMockIssueWithLabels(["bug", "feature"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createWebhook(),
				[mockRepository],
			);

			expect(capturedRunnerType).toBe("claude");
			expect(ClaudeRunner).toHaveBeenCalled();
		});

		it("should default to Claude runner when issue has no labels", async () => {
			const mockIssue = createMockIssueWithLabels([]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createWebhook(),
				[mockRepository],
			);

			expect(capturedRunnerType).toBe("claude");
			expect(ClaudeRunner).toHaveBeenCalled();
		});
	});

	describe("Case Insensitivity", () => {
		it("should select Claude runner with uppercase 'CLAUDE' label", async () => {
			const mockIssue = createMockIssueWithLabels(["CLAUDE"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(
				createWebhook(),
				[mockRepository],
			);

			expect(capturedRunnerType).toBe("claude");
			expect(ClaudeRunner).toHaveBeenCalled();
		});
	});

	describe("Runner Selection Service", () => {
		it("should resolve the Claude runner with the model override", () => {
			const runnerSelection = (
				edgeWorker as any
			).runnerSelectionService.determineRunnerSelection(["opus"]);

			expect(runnerSelection.runnerType).toBe("claude");
			expect(runnerSelection.modelOverride).toBe("opus");
			expect(runnerSelection.fallbackModelOverride).toBe("sonnet");
		});

		it("should resolve the default Claude model when no model label is present", () => {
			const runnerSelection = (
				edgeWorker as any
			).runnerSelectionService.determineRunnerSelection(["bug"]);

			expect(runnerSelection.runnerType).toBe("claude");
			expect(runnerSelection.modelOverride).toBe("opus");
		});

		it("should resolve the Cursor runner and default model for a 'cursor' label", () => {
			const runnerSelection = (
				edgeWorker as any
			).runnerSelectionService.determineRunnerSelection(["cursor"]);

			expect(runnerSelection.runnerType).toBe("cursor");
			expect(runnerSelection.modelOverride).toBe("composer-2.5");
		});

		// Model precedence is centralized here: description tag > model label >
		// labelPromptModel > repositoryModel. The `opts` sources are the ones a
		// pre-DEV-174 build ignored entirely.
		it("folds labelPromptModel and repositoryModel into the precedence chain", () => {
			const svc = (edgeWorker as any).runnerSelectionService;

			// repository.model alone is honored (would have been ignored before).
			expect(
				svc.determineRunnerSelection([], undefined, {
					repositoryModel: "haiku",
				}).modelOverride,
			).toBe("haiku");

			// labelPromptModel outranks repositoryModel.
			expect(
				svc.determineRunnerSelection([], undefined, {
					labelPromptModel: "sonnet",
					repositoryModel: "haiku",
				}).modelOverride,
			).toBe("sonnet");

			// A model label outranks both opts sources.
			expect(
				svc.determineRunnerSelection(["opus"], undefined, {
					labelPromptModel: "sonnet",
					repositoryModel: "haiku",
				}).modelOverride,
			).toBe("opus");

			// A [model=...] description tag outranks everything.
			expect(
				svc.determineRunnerSelection(["opus"], "[model=fable]", {
					labelPromptModel: "sonnet",
					repositoryModel: "haiku",
				}).modelOverride,
			).toBe("fable");
		});

		it("drops a repositoryModel that conflicts with the resolved runner family", () => {
			// A `cursor` label forces the Cursor runner; the Claude-family
			// repository.model is dropped and Cursor's default model is used.
			const result = (
				edgeWorker as any
			).runnerSelectionService.determineRunnerSelection(["cursor"], undefined, {
				repositoryModel: "haiku",
			});

			expect(result.runnerType).toBe("cursor");
			expect(result.modelOverride).toBe("composer-2.5");
		});

		it("honors repositoryFallbackModel when its family matches the runner", () => {
			const result = (
				edgeWorker as any
			).runnerSelectionService.determineRunnerSelection([], undefined, {
				repositoryModel: "opus",
				repositoryFallbackModel: "haiku",
			});

			expect(result.runnerType).toBe("claude");
			expect(result.modelOverride).toBe("opus");
			expect(result.fallbackModelOverride).toBe("haiku");
		});
	});

	// End-to-end proof that a configured `repository.model` reaches the runner
	// config. This is the exact path a pre-DEV-174 build broke: the selector
	// always returned a truthy model, so RunnerConfigBuilder's
	// `modelOverride || repository.model || default` chain never fell through to
	// `repository.model`.
	describe("Model precedence (repository.model revival)", () => {
		async function runWithRepository(
			repository: RepositoryConfig,
			labels: string[],
			description = "Test description",
		) {
			const worker = composeEdgeWorker({
				...mockConfig,
				repositories: [repository],
			});
			(worker as any).issueTrackers.set(repository.linearWorkspaceId, {
				fetchIssue: vi.fn().mockImplementation(async (issueId: string) => {
					return mockLinearClient.issue(issueId);
				}),
				getIssueLabels: vi.fn(),
				getClient: vi.fn().mockReturnValue({}),
			});
			mockLinearClient.issue.mockResolvedValue(
				createMockIssueWithLabels(labels, description),
			);
			await (worker as any).handleAgentSessionCreatedWebhook(createWebhook(), [
				repository,
			]);
		}

		it("uses repository.model when no label/description model is present", async () => {
			await runWithRepository(
				{ ...mockRepository, model: "haiku", fallbackModel: "sonnet" },
				[],
			);

			expect(capturedRunnerType).toBe("claude");
			// Pre-fix this resolved to the runner default ("opus"); repository.model
			// was dead. Post-fix the selector folds it in.
			expect(capturedRunnerConfig.model).toBe("haiku");
			expect(capturedRunnerConfig.fallbackModel).toBe("sonnet");
		});

		it("lets a model label override repository.model", async () => {
			await runWithRepository({ ...mockRepository, model: "haiku" }, ["opus"]);

			expect(capturedRunnerType).toBe("claude");
			expect(capturedRunnerConfig.model).toBe("opus");
		});

		it("lets a [model=...] description tag override repository.model", async () => {
			await runWithRepository(
				{ ...mockRepository, model: "haiku" },
				[],
				"Fix this [model=sonnet]",
			);

			expect(capturedRunnerType).toBe("claude");
			expect(capturedRunnerConfig.model).toBe("sonnet");
		});
	});

	describe("Session Continuation", () => {
		it("should pass claudeSessionId as resumeSessionId for claude continuations", async () => {
			const mockIssue = createMockIssueWithLabels(["claude"]);
			vi.spyOn(edgeWorker as any, "fetchFullIssueDetails").mockResolvedValue(
				mockIssue,
			);
			vi.spyOn(edgeWorker as any, "buildSessionPrompt").mockResolvedValue(
				"Resume this session",
			);
			vi.spyOn(edgeWorker as any, "savePersistedState").mockResolvedValue(
				undefined,
			);

			const session: any = {
				issueId: "issue-123",
				workspace: { path: "/test/workspaces/TEST-123" },
				issue: { identifier: "TEST-123" },
				claudeSessionId: "claude-session-existing",
			};

			await (edgeWorker as any).resumeAgentSession(
				session,
				mockRepository,
				"agent-session-123",
				mockAgentSessionManager,
				"follow-up prompt",
			);

			expect(capturedRunnerType).toBe("claude");
			expect(capturedRunnerConfig.resumeSessionId).toBe(
				"claude-session-existing",
			);
			expect(mockClaudeRunner.startStreaming).toHaveBeenCalled();
		});

		it("should keep the Cursor runner and resume cursorSessionId for cursor continuations", async () => {
			// Even though the labels would select Claude, an existing cursorSessionId
			// must keep the session on the Cursor runner and resume it.
			const mockIssue = createMockIssueWithLabels(["claude"]);
			vi.spyOn(edgeWorker as any, "fetchFullIssueDetails").mockResolvedValue(
				mockIssue,
			);
			vi.spyOn(edgeWorker as any, "buildSessionPrompt").mockResolvedValue(
				"Resume this session",
			);
			vi.spyOn(edgeWorker as any, "savePersistedState").mockResolvedValue(
				undefined,
			);

			const session: any = {
				issueId: "issue-123",
				workspace: { path: "/test/workspaces/TEST-123" },
				issue: { identifier: "TEST-123" },
				cursorSessionId: "cursor-session-existing",
			};

			await (edgeWorker as any).resumeAgentSession(
				session,
				mockRepository,
				"agent-session-123",
				mockAgentSessionManager,
				"follow-up prompt",
			);

			expect(capturedRunnerType).toBe("cursor");
			expect(capturedRunnerConfig.resumeSessionId).toBe(
				"cursor-session-existing",
			);
		});
	});
});
