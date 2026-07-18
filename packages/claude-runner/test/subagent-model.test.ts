import * as claudeCode from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeRunner } from "../src/ClaudeRunner";
import type { ClaudeRunnerConfig } from "../src/types";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

vi.mock("fs", () => ({
	readFileSync: vi.fn(() => "{}"),
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
	writeFileSync: vi.fn(),
	statSync: vi.fn(() => ({ isDirectory: vi.fn(() => true) })),
}));

/**
 * The `agents` option is the *only* way to set a subagent's model — the SDK has
 * no global subagent-model knob. If it silently fails to reach the query call,
 * delegated reads keep running on the session model (Opus) and the whole point
 * of the knob is lost, with nothing to show it. So assert on the query args.
 */
describe("ClaudeRunner — explore subagent registration", () => {
	const queryMock = vi.mocked(claudeCode.query);

	beforeEach(() => {
		vi.clearAllMocks();
		queryMock.mockImplementation(async function* () {});
	});

	afterEach(() => vi.clearAllMocks());

	const baseConfig: ClaudeRunnerConfig = {
		workingDirectory: "/test",
		allowedTools: ["Read"],
		cyrusHome: "/test/cyrus",
	};

	async function optionsFor(
		config: ClaudeRunnerConfig,
	): Promise<Record<string, unknown>> {
		await new ClaudeRunner(config).start("prompt");
		expect(queryMock).toHaveBeenCalledTimes(1);
		const args = queryMock.mock.calls[0]?.[0] as {
			options: Record<string, unknown>;
		};
		return args.options;
	}

	it("registers a read-only explore agent pinned to the configured model", async () => {
		const options = await optionsFor({
			...baseConfig,
			subagentModel: "haiku",
		});

		expect(options.agents).toMatchObject({
			explore: {
				model: "haiku",
				// Read-only: an explorer that can edit is a different, riskier thing.
				tools: ["Read", "Grep", "Glob"],
			},
		});
	});

	it("omits the agents option entirely when no subagent model is configured", async () => {
		// Unset must be a true no-op: registering an agent with an inherited model
		// would change delegation behavior while saving nothing.
		const options = await optionsFor(baseConfig);
		expect(options).not.toHaveProperty("agents");
	});
});
