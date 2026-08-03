/**
 * OmpRunner tests against a fake `omp acp` subprocess fixture (no in-runner
 * mock path — production has no mock-success fallback).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "cyrus-core";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { OmpRunner } from "../src/OmpRunner.js";
import type { OmpPermissionPolicy, OmpRunnerConfig } from "../src/types.js";

const FIXTURE = fileURLToPath(
	new URL("./fixtures/fakeOmpAcp.mjs", import.meta.url),
);
let WORK_DIR = "/tmp";

beforeAll(() => {
	WORK_DIR = mkdtempSync(join(tmpdir(), "cyrus-omp-test-"));
});

afterAll(() => {
	rmSync(WORK_DIR, { recursive: true, force: true });
});

const ALLOW_ALL: OmpPermissionPolicy = { allowsTool: () => true };
const _DENY_ALL: OmpPermissionPolicy = { allowsTool: () => false };

function makeConfig(overrides: Partial<OmpRunnerConfig> = {}): OmpRunnerConfig {
	return {
		cyrusHome: WORK_DIR,
		workingDirectory: WORK_DIR,
		// Vitest workers scrub PATH; use the running node binary directly.
		ompCommand: `${process.execPath} ${FIXTURE}`,
		ompPermissionPolicy: ALLOW_ALL,
		ompStartupTimeoutMs: 10_000,
		ompPromptTimeoutMs: 10_000,
		...overrides,
	};
}

async function runToEnd(
	config: OmpRunnerConfig,
	prompt = "Do the thing",
): Promise<{ messages: AgentMessage[]; result: AgentMessage | undefined }> {
	const messages: AgentMessage[] = [];
	const runner = new OmpRunner(config);
	runner.on("message", (message) => messages.push(message));
	// The runner emits an 'error' event for failed turns; tests observe the
	// error result message instead, so a listener must be present or the
	// EventEmitter throws on emission.
	runner.on("error", () => {});
	const sessionInfo = await runner.start(prompt);
	expect(sessionInfo.sessionId).toBeTruthy();
	const result = messages.find((m) => m.type === "result");
	return { messages, result: result as AgentMessage | undefined };
}

describe("OmpRunner", () => {
	afterEach(() => {
		delete process.env.FAKE_OMP_SCENARIO;
		delete process.env.FAKE_OMP_SESSION_ID;
	});

	it("advertises the omp provider and no streaming input", async () => {
		const runner = new OmpRunner(makeConfig());
		expect(runner.provider).toBe("omp");
		expect(runner.supportsStreamingInput).toBe(false);
		await expect(runner.startStreaming("x")).rejects.toThrow(/streaming/);
		expect(() => runner.addStreamMessage("x")).toThrow(/streaming/);
	});

	it("emits init → assistant text → tool activity → one success result", async () => {
		const { messages, result } = await runToEnd(makeConfig());

		const init = messages.find(
			(m) => m.type === "system" && m.subtype === "init",
		);
		expect(init).toMatchObject({
			type: "system",
			subtype: "init",
			sessionId: "fixture-sess-1",
			permissionMode: "always-ask",
		});

		const assistantText = messages.find(
			(m) => m.type === "assistant" && m.content.some((c) => c.type === "text"),
		);
		expect(assistantText).toBeDefined();

		const toolUse = messages.find(
			(m) =>
				m.type === "assistant" &&
				m.content.some((c) => c.type === "tool_use" && c.name === "Bash"),
		);
		expect(toolUse).toBeDefined();

		// Exactly one terminal result, and it carries the last assistant text.
		expect(result).toMatchObject({
			type: "result",
			subtype: "success",
			sessionId: "fixture-sess-1",
			usage: {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 10,
				cacheWriteTokens: 5,
			},
		});
	});

	it("resumes the persisted runner session id via session/resume", async () => {
		process.env.FAKE_OMP_SESSION_ID = "persisted-omp-uuid";
		const resumeSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const { result } = await runToEnd(
			makeConfig({ resumeSessionId: "persisted-omp-uuid" }),
		);
		expect(result?.sessionId).toBe("persisted-omp-uuid");
		resumeSpy.mockRestore();
	});

	it("maps an allowed permission request to allow-once", async () => {
		process.env.FAKE_OMP_SCENARIO = "permission";
		const allowSpy = vi.fn(() => true);
		await runToEnd(
			makeConfig({ ompPermissionPolicy: { allowsTool: allowSpy } }),
		);

		// The operation speaks the OMP kind vocabulary (the same the rendered
		// policy uses), not the timeline's Cyrus display name.
		expect(allowSpy).toHaveBeenCalledWith(
			"execute",
			expect.stringContaining("rm -rf"),
		);
	});

	it("rejects an unknown or denied permission request (fail closed)", async () => {
		process.env.FAKE_OMP_SCENARIO = "permission";
		const denySpy = vi.fn(() => false);
		const { result } = await runToEnd(
			makeConfig({ ompPermissionPolicy: { allowsTool: denySpy } }),
		);

		expect(denySpy).toHaveBeenCalled();
		// Rejected operation → the turn still completes (the agent sees the
		// rejection as a tool result) — the run does not hang or crash.
		expect(result?.subtype).toBe("success");
	});

	it("rejects every permission request when no policy is supplied", async () => {
		process.env.FAKE_OMP_SCENARIO = "permission";
		const { result } = await runToEnd(
			makeConfig({ ompPermissionPolicy: undefined }),
		);
		expect(result?.subtype).toBe("success");
	});

	const countInit = (messages: AgentMessage[]): number =>
		messages.filter(
			(m) =>
				m.type === "system" && (m as { subtype?: string }).subtype === "init",
		).length;

	it("fails profile startup when the agent name is wrong", async () => {
		process.env.FAKE_OMP_SCENARIO = "wrong-name";
		const messages: AgentMessage[] = [];
		const runner = new OmpRunner(makeConfig());
		runner.on("message", (message) => messages.push(message));
		runner.on("error", () => {});
		await runner.start("hi");

		const result = messages.find((m) => m.type === "result");
		expect(result).toMatchObject({ subtype: "error" });
		expect((result as { errors?: string[] }).errors?.[0]).toContain("oh-my-pi");
		// No init with a fabricated session id: a failed startup must never
		// produce a runnerSessionId OMP did not assign (the next resume would
		// permanently wedge the session).
		expect(countInit(messages)).toBe(0);
	});

	it("fails profile startup when session.resume capability is missing", async () => {
		process.env.FAKE_OMP_SCENARIO = "no-resume";
		const messages: AgentMessage[] = [];
		const runner = new OmpRunner(makeConfig());
		runner.on("message", (message) => messages.push(message));
		runner.on("error", () => {});
		await runner.start("hi");

		const result = messages.find((m) => m.type === "result");
		expect(result).toMatchObject({ subtype: "error" });
		expect((result as { errors?: string[] }).errors?.[0]).toContain("resume");
		expect(countInit(messages)).toBe(0);
	});

	it("emits no init when the process exits before session/new", async () => {
		// A spawn of a missing binary: the process never completes initialize.
		const messages: AgentMessage[] = [];
		const runner = new OmpRunner(
			makeConfig({
				ompCommand: `${process.execPath} /definitely/missing/fixture.mjs`,
			}),
		);
		runner.on("message", (message) => messages.push(message));
		runner.on("error", () => {});
		await runner.start("hi");

		const result = messages.find((m) => m.type === "result");
		expect(result).toMatchObject({ subtype: "error" });
		expect(countInit(messages)).toBe(0);
	});

	it("surfaces a malformed frame without hanging", async () => {
		process.env.FAKE_OMP_SCENARIO = "malformed";
		const { result } = await runToEnd(makeConfig());
		// Malformed stdout is ignored by the NDJSON stream; the turn still
		// completes with a success result from the later valid response.
		expect(result?.subtype).toBe("success");
	});

	it("surfaces a process exit mid-prompt as an error result", async () => {
		process.env.FAKE_OMP_SCENARIO = "exit";
		const { result } = await runToEnd(makeConfig());
		expect(result?.subtype).toBe("error");
	});

	it("stop() cancels and tears down the process", async () => {
		const runner = new OmpRunner(makeConfig());
		runner.on("message", () => {});
		runner.on("error", () => {});
		const startPromise = runner.start("long task");
		// Give the fixture a moment to reach the prompt, then cancel.
		await new Promise((resolve) => setTimeout(resolve, 100));
		runner.stop();
		await startPromise;
		expect(runner.isRunning()).toBe(false);
	});
});
