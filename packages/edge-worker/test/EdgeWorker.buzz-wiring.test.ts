import type { EdgeWorkerConfig, ILogger, RepositoryConfig } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
// The two Buzz collaborators that reach outside the process: one spawns the
// CLI, the other starts a poll timer.
vi.mock("../src/buzz/BuzzCliClient.js", () => ({
	BuzzCliClient: vi.fn().mockImplementation(function () {
		return { checkAvailable: vi.fn().mockResolvedValue(true) };
	}),
}));
vi.mock("../src/buzz/BuzzPollingSource.js", () => ({
	BuzzPollingSource: vi.fn().mockImplementation(function () {
		return { start: vi.fn(), stop: vi.fn() };
	}),
}));
// Kept real apart from the constructor, so the deep-link builder under
// assertion is the one the projection would actually be handed.
vi.mock("../src/buzz/BuzzLinearProjection.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../src/buzz/BuzzLinearProjection.js")
	>()),
	BuzzLinearProjection: vi.fn(),
}));

// Imported after the mocks are registered.
const { composeEdgeWorker } = await import("../src/EdgeWorker.js");
const { BuzzLinearProjection } = await import(
	"../src/buzz/BuzzLinearProjection.js"
);

const CHANNEL_ID = "6f1a2b3c-0000-4000-8000-000000000001";
const THREAD_ROOT = "d".repeat(64);

function repository(
	id: string,
	name: string,
	teamKeys?: string[],
): RepositoryConfig {
	return {
		id,
		name,
		repositoryPath: `/repos/${name}`,
		workspaceBaseDir: "/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		...(teamKeys ? { teamKeys } : {}),
	} as RepositoryConfig;
}

function createLogger(): ILogger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		withContext: vi.fn().mockReturnThis(),
	} as unknown as ILogger;
}

/**
 * Build a worker, swap in a capturable logger, and run the Buzz wiring the way
 * `initializeComponents` does.
 */
function registerBuzz(config: EdgeWorkerConfig, logger: ILogger): void {
	const worker = composeEdgeWorker(config);
	(worker as unknown as { logger: ILogger }).logger = logger;
	(
		worker as unknown as { registerBuzzEventTransport(): void }
	).registerBuzzEventTransport();
}

describe("EdgeWorker Buzz wiring", () => {
	let logger: ILogger;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		process.env.BUZZ_PRIVATE_KEY = "nsec-test";
		logger = createLogger();
	});

	afterEach(() => {
		delete process.env.BUZZ_PRIVATE_KEY;
	});

	function config(repositories: RepositoryConfig[]): EdgeWorkerConfig {
		return {
			platform: "linear",
			cyrusHome: "/test/.cyrus",
			repositories,
			linearWorkspaces: { "test-workspace": { linearToken: "test-token" } },
			buzz: {
				cliPath: "/usr/local/bin/buzz",
				relayUrl: "https://relay.example.com",
				channels: [
					{ channelId: CHANNEL_ID, repositoryId: "repo-1" },
					{ channelId: "*", repositoryIds: ["repo-2", "repo-3"] },
				],
			},
		} as EdgeWorkerConfig;
	}

	// G0-a is a configuration claim ("every routed repository has teamKeys").
	// Without this it is only ever asserted; the first evidence otherwise is a
	// gate release hours later that quietly records nothing.
	it("names every routed repository that cannot be projected", () => {
		registerBuzz(
			config([
				repository("repo-1", "cyrus", ["DEV"]),
				repository("repo-2", "honey-automation"),
				repository("repo-3", "trop-ops"),
			]),
			logger,
		);

		expect(vi.mocked(logger.warn).mock.calls).toEqual([
			[
				"Buzz routes reach 2 repositories with no teamKeys, so their threads will not be projected into Linear: honey-automation, trop-ops",
			],
		]);
	});

	// The schema permits `[""]`, and a check on array length would call that
	// repository projectable while the projection refuses it.
	it("counts a blank team key as no teamKeys", () => {
		registerBuzz(
			config([
				repository("repo-1", "cyrus", ["DEV"]),
				repository("repo-2", "honey-automation", [""]),
				repository("repo-3", "trop-ops", ["OPS"]),
			]),
			logger,
		);

		expect(vi.mocked(logger.warn).mock.calls).toEqual([
			[
				"Buzz routes reach 1 repository with no teamKeys, so their threads will not be projected into Linear: honey-automation",
			],
		]);
	});

	it("says nothing when every routed repository has teamKeys", () => {
		registerBuzz(
			config([
				repository("repo-1", "cyrus", ["DEV"]),
				repository("repo-2", "honey-automation", ["HON"]),
				repository("repo-3", "trop-ops", ["OPS"]),
			]),
			logger,
		);

		expect(vi.mocked(logger.warn).mock.calls).toEqual([]);
	});

	// A repository nothing routes to is somebody else's problem — warning about
	// it would train operators to ignore this line.
	it("ignores repositories no Buzz route reaches", () => {
		registerBuzz(
			config([
				repository("repo-1", "cyrus", ["DEV"]),
				repository("repo-2", "honey-automation", ["HON"]),
				repository("repo-3", "trop-ops", ["OPS"]),
				repository("repo-9", "unrouted"),
			]),
			logger,
		);

		expect(vi.mocked(logger.warn).mock.calls).toEqual([]);
	});

	// The projection's `buildThreadUrl` was optional and supplied by nothing, so
	// the `Link:` line had never shipped.
	it("hands the projection the Buzz deep-link builder", () => {
		registerBuzz(config([repository("repo-1", "cyrus", ["DEV"])]), logger);

		const deps = vi.mocked(BuzzLinearProjection).mock.calls[0]?.[0];
		expect(deps?.buildThreadUrl?.(CHANNEL_ID, THREAD_ROOT)).toBe(
			`buzz://message?channel=${CHANNEL_ID}&id=${THREAD_ROOT}&thread=${THREAD_ROOT}`,
		);
	});
});
