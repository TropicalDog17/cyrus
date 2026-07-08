import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBaseSessionEnv } from "../src/session-env";

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
