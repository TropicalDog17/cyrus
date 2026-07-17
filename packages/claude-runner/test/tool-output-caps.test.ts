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
 * The bundled Claude CLI caps tool output via the `BASH_MAX_OUTPUT_LENGTH` and
 * `MAX_MCP_OUTPUT_TOKENS` env vars. If they silently fail to reach the query
 * `env`, oversized results keep bloating the transcript (and every subsequent
 * cache write) with nothing to show it — so assert on the query args, and that
 * an unset cap emits no key at all (which preserves the CLI default).
 */
describe("ClaudeRunner — tool-output cap env vars", () => {
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

	async function envFor(
		config: ClaudeRunnerConfig,
	): Promise<Record<string, string | undefined>> {
		await new ClaudeRunner(config).start("prompt");
		expect(queryMock).toHaveBeenCalledTimes(1);
		const args = queryMock.mock.calls[0]?.[0] as {
			options: { env: Record<string, string | undefined> };
		};
		return args.options.env;
	}

	it("emits both cap env vars as strings when configured", async () => {
		const env = await envFor({
			...baseConfig,
			bashMaxOutputLength: 30000,
			mcpMaxOutputTokens: 25000,
		});

		expect(env.BASH_MAX_OUTPUT_LENGTH).toBe("30000");
		expect(env.MAX_MCP_OUTPUT_TOKENS).toBe("25000");
	});

	it("emits only the configured cap and omits the other key entirely", async () => {
		const env = await envFor({
			...baseConfig,
			bashMaxOutputLength: 30000,
		});

		expect(env.BASH_MAX_OUTPUT_LENGTH).toBe("30000");
		expect(env).not.toHaveProperty("MAX_MCP_OUTPUT_TOKENS");
	});

	it("omits both cap keys when neither is configured (CLI default preserved)", async () => {
		const env = await envFor(baseConfig);

		expect(env).not.toHaveProperty("BASH_MAX_OUTPUT_LENGTH");
		expect(env).not.toHaveProperty("MAX_MCP_OUTPUT_TOKENS");
	});
});
