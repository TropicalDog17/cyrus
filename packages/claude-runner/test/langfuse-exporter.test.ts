import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	exportTranscriptToLangfuse,
	type LangfuseConfig,
	type LangfuseLike,
	resolveLangfuseConfig,
} from "../src/langfuse-exporter";

const PK = "pk-lf-test";
const SK = "sk-lf-test";
const CONFIG: LangfuseConfig = {
	publicKey: PK,
	secretKey: SK,
	baseUrl: "https://lf.example.com",
};

describe("resolveLangfuseConfig", () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		delete process.env.LANGFUSE_PUBLIC_KEY;
		delete process.env.LANGFUSE_SECRET_KEY;
		delete process.env.LANGFUSE_HOST;
		delete process.env.LANGFUSE_BASE_URL;
		delete process.env.CYRUS_TELEMETRY_DISABLED;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("returns null when keys are missing", () => {
		expect(resolveLangfuseConfig({})).toBeNull();
		expect(resolveLangfuseConfig({ LANGFUSE_PUBLIC_KEY: PK })).toBeNull();
		expect(resolveLangfuseConfig({ LANGFUSE_SECRET_KEY: SK })).toBeNull();
	});

	it("returns config when both keys are present, defaulting to cloud host", () => {
		const cfg = resolveLangfuseConfig({
			LANGFUSE_PUBLIC_KEY: PK,
			LANGFUSE_SECRET_KEY: SK,
		});
		expect(cfg).toEqual({
			publicKey: PK,
			secretKey: SK,
			baseUrl: "https://cloud.langfuse.com",
		});
	});

	it("prefers LANGFUSE_HOST and strips trailing slashes", () => {
		const cfg = resolveLangfuseConfig({
			LANGFUSE_PUBLIC_KEY: PK,
			LANGFUSE_SECRET_KEY: SK,
			LANGFUSE_HOST: "http://100.93.103.32:3003/",
		});
		expect(cfg?.baseUrl).toBe("http://100.93.103.32:3003");
	});

	it("falls back to LANGFUSE_BASE_URL alias", () => {
		const cfg = resolveLangfuseConfig({
			LANGFUSE_PUBLIC_KEY: PK,
			LANGFUSE_SECRET_KEY: SK,
			LANGFUSE_BASE_URL: "https://lf.example.com",
		});
		expect(cfg?.baseUrl).toBe("https://lf.example.com");
	});

	it("returns null when CYRUS_TELEMETRY_DISABLED is truthy", () => {
		expect(
			resolveLangfuseConfig({
				LANGFUSE_PUBLIC_KEY: PK,
				LANGFUSE_SECRET_KEY: SK,
				CYRUS_TELEMETRY_DISABLED: "1",
			}),
		).toBeNull();
	});
});

/** Records every call to the fake Langfuse client for assertions. */
function makeFakeClient(): { client: LangfuseLike; calls: unknown[] } {
	const calls: unknown[] = [];
	const client: LangfuseLike = {
		trace(body) {
			calls.push({ kind: "trace", body });
			return {
				generation(body) {
					calls.push({ kind: "generation", body });
				},
				span(body) {
					calls.push({ kind: "span", body });
				},
			};
		},
		async flushAsync() {
			calls.push({ kind: "flush" });
		},
		async shutdownAsync() {
			calls.push({ kind: "shutdown" });
		},
	};
	return { client, calls };
}

/** A small transcript matching the real Claude Code JSONL schema. */
function transcript(lines: string[]): string {
	return lines.join("\n");
}

describe("exportTranscriptToLangfuse", () => {
	it("emits one generation per assistant turn + one span per tool_use", async () => {
		const { client, calls } = makeFakeClient();
		const transcriptPath = writeTempTranscript(
			transcript([
				JSON.stringify({
					type: "user",
					uuid: "u1",
					timestamp: "2026-07-08T10:00:00.000Z",
					message: {
						role: "user",
						content: [{ type: "text", text: "hello" }],
					},
				}),
				JSON.stringify({
					type: "assistant",
					uuid: "a1",
					timestamp: "2026-07-08T10:00:01.000Z",
					message: {
						id: "msg-1",
						role: "assistant",
						model: "claude-opus-4-8",
						stop_reason: "end_turn",
						content: [
							{ type: "text", text: "Hi! Let me read the file." },
							{
								type: "tool_use",
								id: "tu-1",
								name: "Read",
								input: { file_path: "/tmp/a.ts" },
							},
						],
						usage: {
							input_tokens: 100,
							cache_read_input_tokens: 50,
							output_tokens: 20,
						},
					},
				}),
				JSON.stringify({
					type: "user",
					uuid: "u2",
					timestamp: "2026-07-08T10:00:02.000Z",
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tu-1",
								content: "file contents here",
							},
						],
					},
				}),
			]),
		);

		const result = await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-123",
			config: CONFIG,
			traceName: "DEV-120",
			clientFactory: () => client,
		});

		expect(result).toEqual({ generations: 1, toolSpans: 1 });
		const generations = calls.filter(
			(c) => (c as { kind: string }).kind === "generation",
		);
		const spans = calls.filter((c) => (c as { kind: string }).kind === "span");
		const traces = calls.filter(
			(c) => (c as { kind: string }).kind === "trace",
		);

		expect(traces).toHaveLength(1);
		expect((traces[0] as { body: Record<string, unknown> }).body).toMatchObject(
			{
				name: "DEV-120",
				sessionId: "sess-123",
				metadata: { source: "cyrus", claudeSessionId: "sess-123" },
			},
		);

		expect(generations).toHaveLength(1);
		expect(
			(generations[0] as { body: Record<string, unknown> }).body,
		).toMatchObject({
			name: "assistant-turn",
			model: "claude-opus-4-8",
			usage: { input: 150, output: 20, total: 170, unit: "TOKENS" },
		});

		expect(spans).toHaveLength(1);
		expect((spans[0] as { body: Record<string, unknown> }).body).toMatchObject({
			name: "tool:Read",
			input: { file_path: "/tmp/a.ts" },
			output: "file contents here",
		});
	});

	it("uses deterministic trace + object ids (re-export is idempotent)", async () => {
		const { client, calls } = makeFakeClient();
		const transcriptPath = writeTempTranscript(
			transcript([
				JSON.stringify({
					type: "user",
					uuid: "u1",
					timestamp: "2026-07-08T10:00:00.000Z",
					message: { role: "user", content: "hi" },
				}),
				JSON.stringify({
					type: "assistant",
					uuid: "a1",
					timestamp: "2026-07-08T10:00:01.000Z",
					message: {
						id: "msg-1",
						role: "assistant",
						model: "claude-opus-4-8",
						content: [{ type: "text", text: "hello" }],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				}),
			]),
		);

		await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-xyz",
			config: CONFIG,
			clientFactory: () => client,
		});

		const trace = calls.find((c) => (c as { kind: string }).kind === "trace");
		const gen = calls.find(
			(c) => (c as { kind: string }).kind === "generation",
		);
		expect((trace as { body: { id: string } }).body.id).toBe("cyrus-sess-xyz");
		expect((gen as { body: { id: string } }).body.id).toBe("gen-a1");
	});

	it("skips corrupt JSONL lines without failing", async () => {
		const { client } = makeFakeClient();
		const transcriptPath = writeTempTranscript(
			[
				"this is not json {{{",
				JSON.stringify({
					type: "assistant",
					uuid: "a1",
					timestamp: "2026-07-08T10:00:01.000Z",
					message: {
						id: "msg-1",
						role: "assistant",
						model: "claude-opus-4-8",
						content: [{ type: "text", text: "hi" }],
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				}),
				"",
			].join("\n"),
		);

		const result = await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-bad",
			config: CONFIG,
			clientFactory: () => client,
		});
		expect(result.generations).toBe(1);
	});

	it("flushes and shuts down the client", async () => {
		const { client, calls } = makeFakeClient();
		const transcriptPath = writeTempTranscript("");
		await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-empty",
			config: CONFIG,
			clientFactory: () => client,
		});
		expect(calls.some((c) => (c as { kind: string }).kind === "flush")).toBe(
			true,
		);
		expect(calls.some((c) => (c as { kind: string }).kind === "shutdown")).toBe(
			true,
		);
	});
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "langfuse-export-test-"));
let fileCounter = 0;
function writeTempTranscript(content: string): string {
	const path = join(tmpDir, `transcript-${fileCounter++}.jsonl`);
	writeFileSync(path, content, "utf8");
	return path;
}
