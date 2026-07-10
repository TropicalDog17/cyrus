import type { LinearClient } from "@linear/sdk";
import type { IIssueTrackerService } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	McpConfigService,
	type McpConfigServiceDeps,
} from "../src/McpConfigService.js";

/**
 * Verifies that McpConfigService.buildMcpConfig() marks the Linear-critical MCP
 * servers with `alwaysLoad: true` so their tools are never deferred behind the
 * SDK's MCP tool-search auto mode. Deferral would force the agent to spend
 * ~a minute running `ToolSearch` round-trips against the remote Linear MCP on
 * turn 1 before it can read or update the issue (DEV-140 / CYPACK-716).
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
	it("eager-loads linear and cyrus-tools so their tools are not deferred", () => {
		const config = makeService().buildMcpConfig("repo-1", "ws-1", "session-1");

		// The two servers whose tools are needed on every session load up front.
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
