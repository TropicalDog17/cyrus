import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBaseSessionEnv, buildToolOutputCapEnv } from "../src/session-env";

describe("buildBaseSessionEnv", () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		delete process.env.LANGFUSE_PUBLIC_KEY;
		delete process.env.LANGFUSE_SECRET_KEY;
		delete process.env.LANGFUSE_HOST;
		delete process.env.CYRUS_TELEMETRY_DISABLED;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("injects the shared Cyrus session flags", () => {
		const env = buildBaseSessionEnv();
		expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe("true");
		expect(env.MCP_CONNECTION_NONBLOCKING).toBe("true");
	});

	it("never injects OTLP/telemetry vars (LLMOps is hook-driven now)", () => {
		// Even with Langfuse keys present, the session env must not set the
		// broken OTLP-exporter path — telemetry is emitted by a SessionEnd hook
		// via langfuse-exporter.ts, not by Claude Code's OTLP instrumentation.
		process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
		process.env.LANGFUSE_SECRET_KEY = "sk-lf-def";

		const env = buildBaseSessionEnv();
		expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
		expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
	});

	it("lets caller-provided extra env override defaults", () => {
		const env = buildBaseSessionEnv({ CLAUDE_CODE_ENABLE_TASKS: "false" });
		expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe("false");
	});
});

describe("buildToolOutputCapEnv", () => {
	it("stringifies both caps when configured", () => {
		expect(
			buildToolOutputCapEnv({
				bashMaxOutputLength: 30000,
				mcpMaxOutputTokens: 25000,
			}),
		).toEqual({
			BASH_MAX_OUTPUT_LENGTH: "30000",
			MAX_MCP_OUTPUT_TOKENS: "25000",
		});
	});

	it("emits only the configured cap (unset preserves the CLI default)", () => {
		expect(buildToolOutputCapEnv({ bashMaxOutputLength: 30000 })).toEqual({
			BASH_MAX_OUTPUT_LENGTH: "30000",
		});
		expect(buildToolOutputCapEnv({ mcpMaxOutputTokens: 25000 })).toEqual({
			MAX_MCP_OUTPUT_TOKENS: "25000",
		});
	});

	it("returns an empty object when neither cap is configured", () => {
		expect(buildToolOutputCapEnv({})).toEqual({});
	});
});
