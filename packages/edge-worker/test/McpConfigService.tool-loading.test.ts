import type { LinearClient } from "@linear/sdk";
import type { IIssueTrackerService } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	McpConfigService,
	type McpConfigServiceDeps,
} from "../src/McpConfigService.js";

/**
 * Verifies that McpConfigService.buildMcpConfig() eager-loads the MCP servers
 * whose tools are needed on turn 1 — `linear` (DEV-140 / CYPACK-716) and
 * `cyrus-tools` (DEV-210) — with `alwaysLoad: true`, while leaving the genuinely
 * rare servers (`cyrus-docs`, slack/atlassian) deferred. Deferral is not just a
 * context-size choice: pulling a needed tool in mid-session via `ToolSearch`
 * injects its schema at the head of the tools array and invalidates the whole
 * cached prompt prefix, forcing a full rewrite at 2x (DEV-210).
 */
function makeService(): McpConfigService {
	const deps: McpConfigServiceDeps = {
		getLinearTokenForWorkspace: () => "linear-token",
		getIssueTracker: () =>
			({
				// createCyrusToolsServer only uses the client inside tool handlers,
				// so an empty object is sufficient for config assembly.
				getClient: () => ({}) as LinearClient,
			}) as unknown as IIssueTrackerService & {
				getClient: () => LinearClient;
			},
		getCyrusToolsMcpUrl: () => "http://localhost:3456/cyrus-tools/mcp",
		createCyrusToolsOptions: () => ({}),
	};
	return new McpConfigService(deps);
}

describe("McpConfigService — MCP tool loading", () => {
	it("eager-loads both Linear and cyrus-tools", () => {
		const config = makeService().buildMcpConfig("repo-1", "ws-1", "session-1");

		// Both servers carry tools needed on turn 1 (Linear issue/comment tools;
		// cyrus-tools agent-session reads + upload), so both are eager-loaded to
		// avoid a mid-session ToolSearch invalidating the cached prefix (DEV-210).
		expect(config.linear).toMatchObject({ alwaysLoad: true });
		expect(config["cyrus-tools"]).toMatchObject({ alwaysLoad: true });
	});

	it("leaves rarely-used servers deferred (no alwaysLoad)", () => {
		const config = makeService().buildMcpConfig("repo-1", "ws-1", "session-1");

		// cyrus-docs is used rarely; keeping it behind tool search keeps turn-1
		// context lean.
		expect(config["cyrus-docs"]).toBeDefined();
		expect(
			(config["cyrus-docs"] as { alwaysLoad?: boolean }).alwaysLoad,
		).toBeUndefined();
	});

	it("does not set alwaysLoad in CLI platform mode (no Linear client)", () => {
		const deps: McpConfigServiceDeps = {
			getLinearTokenForWorkspace: () => null,
			getIssueTracker: () => undefined,
			getCyrusToolsMcpUrl: () => "http://localhost:3456/cyrus-tools/mcp",
			createCyrusToolsOptions: () => ({}),
		};
		const config = new McpConfigService(deps).buildMcpConfig(
			"repo-1",
			"ws-1",
			"session-1",
		);

		// CLI mode only exposes cyrus-docs, which stays deferred.
		expect(config.linear).toBeUndefined();
		expect(config["cyrus-tools"]).toBeUndefined();
		expect(
			(config["cyrus-docs"] as { alwaysLoad?: boolean }).alwaysLoad,
		).toBeUndefined();
	});
});
