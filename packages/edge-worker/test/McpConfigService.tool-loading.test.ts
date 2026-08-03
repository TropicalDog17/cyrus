import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinearClient } from "@linear/sdk";
import type { IIssueTrackerService } from "cyrus-core";
import { afterEach, describe, expect, it } from "vitest";
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

let tmpDirs: string[] = [];
afterEach(() => {
	for (const dir of tmpDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tmpDirs = [];
});

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

	describe("buildExactAcpCatalog", () => {
		it("merges Cyrus-owned servers with a repository .mcp.json into the exact ACP map", () => {
			const dir = mkdtempSync(join(tmpdir(), "mcp-tool-loading-"));
			tmpDirs.push(dir);
			const file = join(dir, ".mcp.json");
			writeFileSync(
				file,
				JSON.stringify({
					mcpServers: { "local-db": { command: "./bin/db-mcp" } },
				}),
			);

			const result = makeService().buildExactAcpCatalog(
				"repo-1",
				"ws-1",
				"session-1",
				file,
			);

			const byName = new Map(result.servers.map((s) => [s.name, s]));
			// Cyrus-owned servers are always present and authoritative...
			expect(byName.get("linear")?.url).toBe("https://mcp.linear.app/mcp");
			expect(byName.get("cyrus-tools")?.url).toBe(
				"http://localhost:3456/cyrus-tools/mcp",
			);
			// ...and the repo's stdio command is resolved against its file.
			expect(byName.get("local-db")).toMatchObject({
				command: join(dir, "bin/db-mcp"),
			});
			expect(result.diagnostics).toEqual([]);
		});

		it("keeps the Linear token in memory (headers), never on disk", () => {
			const result = makeService().buildExactAcpCatalog(
				"repo-1",
				"ws-1",
				"session-1",
			);
			const linear = result.servers.find((s) => s.name === "linear");
			expect(linear).toBeDefined();
			expect(JSON.stringify(linear)).toContain("Bearer linear-token");
		});
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
