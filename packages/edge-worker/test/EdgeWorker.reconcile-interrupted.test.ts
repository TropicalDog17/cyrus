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

describe("EdgeWorker - reconcileInterruptedSessions", () => {
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
			markInterruptedSessions: vi.fn().mockReturnValue([]),
			createErrorActivity: vi.fn().mockResolvedValue(undefined),
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
			return { register: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() };
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
			linearWorkspaces: { "test-workspace": { linearToken: "test-token" } },
		} as EdgeWorkerConfig;

		edgeWorker = new EdgeWorker(mockConfig);
		(edgeWorker as any).agentSessionManager = mockAgentSessionManager;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("posts a resume notice for each interrupted session and persists once", async () => {
		mockAgentSessionManager.markInterruptedSessions.mockReturnValue([
			"s1",
			"s2",
		]);
		const savedSpy = vi
			.spyOn(edgeWorker as any, "savePersistedState")
			.mockResolvedValue(undefined);

		await (edgeWorker as any).reconcileInterruptedSessions();

		expect(mockAgentSessionManager.createErrorActivity).toHaveBeenCalledTimes(
			2,
		);
		const notifiedSessions =
			mockAgentSessionManager.createErrorActivity.mock.calls.map(
				(c: any[]) => c[0],
			);
		expect(notifiedSessions.sort()).toEqual(["s1", "s2"]);
		expect(
			mockAgentSessionManager.createErrorActivity.mock.calls[0][1],
		).toContain("Comment on this issue to resume");
		expect(savedSpy).toHaveBeenCalledTimes(1);
	});

	it("does nothing (no posts, no save) when no sessions were interrupted", async () => {
		mockAgentSessionManager.markInterruptedSessions.mockReturnValue([]);
		const savedSpy = vi
			.spyOn(edgeWorker as any, "savePersistedState")
			.mockResolvedValue(undefined);

		await (edgeWorker as any).reconcileInterruptedSessions();

		expect(mockAgentSessionManager.createErrorActivity).not.toHaveBeenCalled();
		expect(savedSpy).not.toHaveBeenCalled();
	});

	it("still persists even if posting a notice fails (best-effort notice)", async () => {
		mockAgentSessionManager.markInterruptedSessions.mockReturnValue(["s1"]);
		mockAgentSessionManager.createErrorActivity.mockRejectedValue(
			new Error("network down"),
		);
		const savedSpy = vi
			.spyOn(edgeWorker as any, "savePersistedState")
			.mockResolvedValue(undefined);

		await expect(
			(edgeWorker as any).reconcileInterruptedSessions(),
		).resolves.toBeUndefined();
		expect(savedSpy).toHaveBeenCalledTimes(1);
	});
});
