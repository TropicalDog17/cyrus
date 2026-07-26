import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiRunner } from "../src/PiRunner.js";
import {
	buildPiArgs,
	mapToolsToPi,
	resolvePiLaunchCommand,
} from "../src/piProcess.js";
import type { PiRunnerConfig } from "../src/types.js";

const baseConfig = (): PiRunnerConfig => ({
	cyrusHome: "/tmp/cyrus-pi-test",
	workingDirectory: "/tmp/cyrus-pi-test",
});

describe("PiRunner mock lifecycle", () => {
	beforeEach(() => {
		process.env.CYRUS_PI_MOCK = "1";
	});
	afterEach(() => {
		delete process.env.CYRUS_PI_MOCK;
	});

	it("advertises Pi streaming input and emits init → text → result", async () => {
		const runner = new PiRunner({ ...baseConfig(), model: "openai/gpt-5.6" });
		const info = await runner.startStreaming("do the thing");

		expect(runner.provider).toBe("pi");
		expect(runner.supportsStreamingInput).toBe(true);
		expect(info.isRunning).toBe(false);
		expect(runner.getMessages()).toEqual([
			expect.objectContaining({
				type: "system",
				subtype: "init",
				model: "openai/gpt-5.6",
			}),
			expect.objectContaining({ type: "assistant" }),
			expect.objectContaining({
				type: "result",
				subtype: "success",
				result: "Pi mock session completed",
			}),
		]);
	});
});

describe("Pi CLI translation", () => {
	it("resolves the pinned package CLI without a global Pi install", () => {
		const launch = resolvePiLaunchCommand(baseConfig());
		expect(launch.command).toBe(process.execPath);
		expect(launch.args[0]).toMatch(/pi-coding-agent.*dist\/cli\.js$/);
	});

	it("maps Cyrus tools and builds model/session/prompt flags", () => {
		expect(
			mapToolsToPi(["Read", "Glob", "Bash(git:*)", "mcp__linear__get_issue"]),
		).toEqual(["read", "find", "mcp__linear__get_issue"]);

		expect(
			buildPiArgs({
				...baseConfig(),
				resumeSessionId: "session-1",
				model: "anthropic/claude-sonnet-4-5",
				appendSystemPrompt: "Follow Cyrus workflow.",
				allowedTools: ["Read", "Edit"],
				disallowedTools: ["Bash"],
			}),
		).toEqual([
			"--mode",
			"rpc",
			"--approve",
			"--session",
			"session-1",
			"--model",
			"anthropic/claude-sonnet-4-5",
			"--append-system-prompt",
			"Follow Cyrus workflow.",
			"--tools",
			"read,edit",
			"--exclude-tools",
			"bash",
		]);
	});

	it("fails closed for scoped allows and unknown Claude-only tools", () => {
		expect(mapToolsToPi(["Bash(git:*)", "Task", "AskUserQuestion"])).toEqual(
			[],
		);
		expect(
			buildPiArgs({
				...baseConfig(),
				allowedTools: ["Bash(git:*)", "Task"],
			}),
		).toContain("--no-tools");
	});
});
