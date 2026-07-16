import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CodexRunner,
	mapMcpServersToAcp,
	sliceTextFile,
} from "../src/CodexRunner.js";
import type { CodexRunnerConfig } from "../src/types.js";

const baseConfig = (): CodexRunnerConfig => ({
	cyrusHome: "/tmp/cyrus-codex-test",
	workingDirectory: "/tmp/cyrus-codex-test",
});

describe("CodexRunner (mock mode)", () => {
	beforeEach(() => {
		process.env.CYRUS_CODEX_MOCK = "1";
	});
	afterEach(() => {
		delete process.env.CYRUS_CODEX_MOCK;
	});

	it("advertises the codex provider and no streaming input", () => {
		const runner = new CodexRunner(baseConfig());
		expect(runner.provider).toBe("codex");
		expect(runner.supportsStreamingInput).toBe(false);
	});

	it("emits init → assistant text → success result and completes", async () => {
		const runner = new CodexRunner(baseConfig());
		const info = await runner.start("do the thing");

		expect(info.isRunning).toBe(false);
		expect(info.sessionId).toBeTruthy();

		const messages = runner.getMessages();
		expect(messages[0]).toMatchObject({
			type: "system",
			subtype: "init",
			model: "gpt-5-codex",
		});
		expect(messages.some((m) => m.type === "assistant")).toBe(true);

		const result = messages.at(-1);
		expect(result).toMatchObject({
			type: "result",
			subtype: "success",
			isError: false,
		});
	});

	it("uses the configured model in the init message", async () => {
		const runner = new CodexRunner({ ...baseConfig(), model: "gpt-5" });
		await runner.start("hi");
		expect(runner.getMessages()[0]).toMatchObject({ model: "gpt-5" });
	});
});

describe("mapMcpServersToAcp", () => {
	it("translates stdio and http servers and skips in-process servers", () => {
		const servers = mapMcpServersToAcp({
			stdioServer: {
				command: "npx",
				args: ["-y", "server"],
				env: { TOKEN: "abc" },
			},
			httpServer: {
				url: "https://example.com/mcp",
				headers: { Authorization: "Bearer x" },
			},
			// In-process SDK server exposing closures — not serializable over stdio.
			inProcess: { listTools: () => [], callTool: () => ({}) },
		} as unknown as CodexRunnerConfig["mcpConfig"]);

		expect(servers).toEqual([
			{
				name: "stdioServer",
				command: "npx",
				args: ["-y", "server"],
				env: [{ name: "TOKEN", value: "abc" }],
			},
			{
				type: "http",
				name: "httpServer",
				url: "https://example.com/mcp",
				headers: [{ name: "Authorization", value: "Bearer x" }],
			},
		]);
	});

	it("returns an empty array when no MCP config is present", () => {
		expect(mapMcpServersToAcp(undefined)).toEqual([]);
	});
});

describe("sliceTextFile", () => {
	const text = "l1\nl2\nl3\nl4\nl5";

	it("returns the whole file when no window is given", () => {
		expect(sliceTextFile(text)).toBe(text);
	});

	it("applies a 1-based line offset and limit", () => {
		expect(sliceTextFile(text, 2, 2)).toBe("l2\nl3");
	});

	it("reads to the end when only a line offset is given", () => {
		expect(sliceTextFile(text, 4)).toBe("l4\nl5");
	});
});
