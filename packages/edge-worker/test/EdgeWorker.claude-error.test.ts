import { LinearClient } from "@linear/sdk";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

vi.mock("fs/promises");
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-mcp-tools");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});

describe("EdgeWorker - handleClaudeError (runner-crash surfacing)", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let mockAgentSessionManager: any;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		allowedTools: ["Read", "Edit"],
		labelPrompts: {},
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});

		mockAgentSessionManager = {
			failSession: vi.fn().mockResolvedValue(undefined),
			on: vi.fn(),
		};

		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		} as any);

		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			};
		} as any);

		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return {
				register: vi.fn(),
				on: vi.fn(),
				removeAllListeners: vi.fn(),
			};
		} as any);

		vi.mocked(LinearClient).mockImplementation(function () {
			return {
				users: {
					me: vi.fn().mockResolvedValue({ id: "user-123", name: "Test User" }),
				},
			};
		} as any);

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		} as EdgeWorkerConfig;

		edgeWorker = new EdgeWorker(mockConfig);
		(edgeWorker as any).agentSessionManager = mockAgentSessionManager;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("surfaces a genuine crash to Linear and reclaims the warm slot", async () => {
		const sessionId = "sess-crash";
		(edgeWorker as any).warmInstances.set(sessionId, { fake: "warm" });
		const savedSpy = vi
			.spyOn(edgeWorker as any, "savePersistedState")
			.mockResolvedValue(undefined);

		await (edgeWorker as any).handleClaudeError(
			new Error("Claude Code process exited with code 1"),
			sessionId,
			"test-repo",
		);

		expect(mockAgentSessionManager.failSession).toHaveBeenCalledTimes(1);
		const [failedSessionId, body] =
			mockAgentSessionManager.failSession.mock.calls[0];
		expect(failedSessionId).toBe(sessionId);
		expect(body).toContain("Claude Code process exited with code 1");
		expect((edgeWorker as any).warmInstances.has(sessionId)).toBe(false);
		expect(savedSpy).toHaveBeenCalled();
	});

	it("ignores user-initiated aborts (no failSession, no state write)", async () => {
		const savedSpy = vi
			.spyOn(edgeWorker as any, "savePersistedState")
			.mockResolvedValue(undefined);
		const abortErr = new Error("Query aborted by user");
		abortErr.name = "AbortError";

		await (edgeWorker as any).handleClaudeError(
			abortErr,
			"sess-abort",
			"test-repo",
		);

		expect(mockAgentSessionManager.failSession).not.toHaveBeenCalled();
		expect(savedSpy).not.toHaveBeenCalled();
	});

	it("ignores graceful SIGTERM (exit code 143)", async () => {
		await (edgeWorker as any).handleClaudeError(
			new Error("Claude Code process exited with code 143"),
			"sess-sigterm",
			"test-repo",
		);
		expect(mockAgentSessionManager.failSession).not.toHaveBeenCalled();
	});

	it("only logs when no session context is available (legacy callers)", async () => {
		const savedSpy = vi
			.spyOn(edgeWorker as any, "savePersistedState")
			.mockResolvedValue(undefined);

		await (edgeWorker as any).handleClaudeError(
			new Error("some background crash"),
		);

		expect(mockAgentSessionManager.failSession).not.toHaveBeenCalled();
		expect(savedSpy).not.toHaveBeenCalled();
	});
});
