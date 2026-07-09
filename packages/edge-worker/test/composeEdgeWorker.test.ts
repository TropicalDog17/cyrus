import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

// Minimal collaborator mocks so buildCollaborators() can run without real I/O.
// (Mirrors the setup the EdgeWorker.* suites use.)
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
	readdir: vi.fn().mockResolvedValue([]),
}));
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("file-type");
vi.mock("chokidar", () => ({
	watch: vi.fn().mockReturnValue({
		on: vi.fn().mockReturnThis(),
		close: vi.fn().mockResolvedValue(undefined),
	}),
}));
vi.mock("../src/SharedApplicationServer.js", () => ({
	SharedApplicationServer: vi.fn().mockImplementation(function () {
		return {
			initializeFastify: vi.fn(),
			getFastifyInstance: vi
				.fn()
				.mockReturnValue({ get: vi.fn(), post: vi.fn() }),
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
			getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
		};
	}),
}));

// Imported after the mocks are registered.
const { EdgeWorker, composeEdgeWorker } = await import("../src/EdgeWorker.js");

const mockRepository: RepositoryConfig = {
	id: "test-repo",
	name: "Test Repo",
	repositoryPath: "/test/repo",
	workspaceBaseDir: "/test/workspaces",
	baseBranch: "main",
	linearWorkspaceId: "test-workspace",
	isActive: true,
};

describe("composeEdgeWorker", () => {
	let config: EdgeWorkerConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		config = {
			platform: "linear",
			cyrusHome: "/test/.cyrus",
			repositories: [mockRepository],
			linearWorkspaces: { "test-workspace": { linearToken: "test-token" } },
		};
	});

	it("returns a fully-wired EdgeWorker (collaborators built)", () => {
		const worker = composeEdgeWorker(config);
		expect(worker).toBeInstanceOf(EdgeWorker);
		// `repositoryRouter` is a public collaborator wired by buildCollaborators.
		expect(worker.repositoryRouter).toBeDefined();
	});

	it("leaves a raw `new EdgeWorker(config)` intentionally incomplete", () => {
		// The constructor sets only primitive state — no collaborators — so a
		// worker built without the composition root has no repositoryRouter.
		// This locks Frozen decision #6's "no `new` in the constructor body".
		const raw = new EdgeWorker(config);
		expect(raw).toBeInstanceOf(EdgeWorker);
		expect(raw.repositoryRouter).toBeUndefined();
	});

	it("guards buildCollaborators against double-construction (idempotent)", () => {
		const worker = composeEdgeWorker(config);
		const firstRouter = worker.repositoryRouter;
		// A redundant build must be a no-op — same collaborator instances, not a
		// fresh graph.
		worker.buildCollaborators(config);
		expect(worker.repositoryRouter).toBe(firstRouter);
	});
});
