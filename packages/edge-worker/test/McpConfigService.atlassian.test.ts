import type { LinearClient } from "@linear/sdk";
import type { IIssueTrackerService } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	McpConfigService,
	type McpConfigServiceDeps,
} from "../src/McpConfigService.js";

/**
 * Verifies that McpConfigService.buildMcpConfig() injects the Atlassian MCP
 * server into the assembled config when (and only when) the integration is
 * configured via environment variables.
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

describe("McpConfigService — Atlassian MCP injection", () => {
	const originalToken = process.env.ATLASSIAN_MCP_TOKEN;
	const originalUrl = process.env.ATLASSIAN_MCP_URL;

	beforeEach(() => {
		delete process.env.ATLASSIAN_MCP_TOKEN;
		delete process.env.ATLASSIAN_MCP_URL;
	});

	afterEach(() => {
		if (originalToken === undefined) delete process.env.ATLASSIAN_MCP_TOKEN;
		else process.env.ATLASSIAN_MCP_TOKEN = originalToken;
		if (originalUrl === undefined) delete process.env.ATLASSIAN_MCP_URL;
		else process.env.ATLASSIAN_MCP_URL = originalUrl;
	});

	it("does not inject atlassian when unconfigured", () => {
		const config = makeService().buildMcpConfig("repo-1", "ws-1", "session-1");
		expect(config.atlassian).toBeUndefined();
		// Sanity check that the standard servers are still present.
		expect(config.linear).toBeDefined();
		expect(config["cyrus-tools"]).toBeDefined();
	});

	it("injects the atlassian server when a token is configured", () => {
		process.env.ATLASSIAN_MCP_TOKEN = "atl-token";
		const config = makeService().buildMcpConfig("repo-1", "ws-1", "session-1");
		expect(config.atlassian).toEqual({
			type: "http",
			url: "https://mcp.atlassian.com/v1/mcp",
			headers: { Authorization: "Bearer atl-token" },
		});
	});
});
