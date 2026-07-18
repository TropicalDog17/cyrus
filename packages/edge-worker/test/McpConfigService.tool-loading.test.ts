import type { LinearClient } from "@linear/sdk";
import type { IIssueTrackerService } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	McpConfigService,
	type McpConfigServiceDeps,
} from "../src/McpConfigService.js";

/**
 * Verifies that McpConfigService.buildMcpConfig() marks only the Linear MCP
 * server with `alwaysLoad: true` so its turn-1 tools are never deferred behind the
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
	it("eager-loads Linear but defers rarely-used cyrus-tools", () => {
		const config = makeService().buildMcpConfig("repo-1", "ws-1", "session-1");

		// Core Linear tools are needed on every session; cyrus-tools are not.
		expect(config.linear).toMatchObject({ alwaysLoad: true });
		expect(config["cyrus-tools"]).toBeDefined();
		expect(
			(config["cyrus-tools"] as { alwaysLoad?: boolean }).alwaysLoad,
		).toBeUndefined();
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
