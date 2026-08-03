/**
 * The exact ACP MCP catalog (ADR 0006 / PR 1): the complete MCP server set a
 * session may use, assembled from Cyrus-owned inline servers plus repository
 * `.mcp.json` files, with Cyrus-owned servers as final authority. OMP receives
 * exactly this map and nothing discovered from ambient config.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExactMcpCatalog } from "../src/agents/ExactMcpCatalog.js";

let tmpDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "exact-mcp-"));
	tmpDirs.push(dir);
	return dir;
}

function writeMcpFile(dir: string, name: string, content: unknown): string {
	const path = join(dir, name);
	writeFileSync(path, JSON.stringify(content));
	return path;
}

afterEach(() => {
	for (const dir of tmpDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tmpDirs = [];
});

const INLINE = {
	linear: {
		type: "http",
		url: "https://mcp.linear.app/mcp",
		headers: { Authorization: "Bearer linear-token" },
		alwaysLoad: true,
	},
	"cyrus-tools": {
		type: "http",
		url: "http://localhost:3456/cyrus-tools/mcp",
		alwaysLoad: true,
	},
	"cyrus-docs": {
		type: "http",
		url: "https://atcyrus.com/docs/mcp",
	},
};

describe("ExactMcpCatalog", () => {
	it("merges inline Cyrus servers with a repository .mcp.json file", () => {
		const dir = makeTempDir();
		const file = writeMcpFile(dir, ".mcp.json", {
			mcpServers: {
				github: {
					type: "http",
					url: "https://api.githubcopilot.com/mcp/",
					headers: { Authorization: "Bearer gh-token" },
				},
			},
		});

		const result = new ExactMcpCatalog().build(INLINE, [file]);

		const byName = new Map(result.servers.map((s) => [s.name, s]));
		expect(byName.size).toBe(4);
		expect(byName.get("linear")).toMatchObject({
			name: "linear",
			url: "https://mcp.linear.app/mcp",
			headers: [{ name: "Authorization", value: "Bearer linear-token" }],
		});
		expect(byName.get("cyrus-tools")?.name).toBe("cyrus-tools");
		expect(byName.get("cyrus-docs")?.name).toBe("cyrus-docs");
		expect(byName.get("github")).toMatchObject({
			name: "github",
			url: "https://api.githubcopilot.com/mcp/",
			headers: [{ name: "Authorization", value: "Bearer gh-token" }],
		});
		expect(result.diagnostics).toEqual([]);
	});

	it("parses flat server maps as well as {mcpServers:{...}}", () => {
		const dir = makeTempDir();
		const file = writeMcpFile(dir, ".mcp.json", {
			"flat-server": {
				type: "sse",
				url: "https://example.com/sse",
			},
		});

		const result = new ExactMcpCatalog().build({}, [file]);

		expect(result.servers).toEqual([
			{ name: "flat-server", url: "https://example.com/sse" },
		]);
		expect(result.diagnostics).toEqual([]);
	});

	it("resolves a relative stdio command against the declaring file's directory", () => {
		const dir = makeTempDir();
		const file = writeMcpFile(dir, "custom.json", {
			mcpServers: {
				"local-tool": {
					command: "bin/server",
					args: ["--port", "9999"],
					env: { FOO: "bar" },
				},
			},
		});

		const result = new ExactMcpCatalog().build({}, [file]);

		expect(result.servers).toEqual([
			{
				name: "local-tool",
				command: join(dir, "bin/server"),
				args: ["--port", "9999"],
				env: [{ name: "FOO", value: "bar" }],
			},
		]);
	});

	it("keeps an absolute stdio command as-is", () => {
		const dir = makeTempDir();
		const file = writeMcpFile(dir, ".mcp.json", {
			mcpServers: {
				"abs-tool": { command: "/usr/local/bin/tool" },
			},
		});

		const result = new ExactMcpCatalog().build({}, [file]);

		expect(result.servers).toEqual([
			{ name: "abs-tool", command: "/usr/local/bin/tool" },
		]);
	});

	it("lets a later file's non-Cyrus server win over an earlier file (last wins)", () => {
		const dir = makeTempDir();
		const fileA = writeMcpFile(dir, "a.json", {
			mcpServers: { shared: { command: "a-tool" } },
		});
		const fileB = writeMcpFile(dir, "b.json", {
			mcpServers: { shared: { command: "b-tool" } },
		});

		const result = new ExactMcpCatalog().build({}, [fileA, fileB]);

		const shared = result.servers.find((s) => s.name === "shared");
		expect(shared).toMatchObject({ command: join(dir, "b-tool") });
	});

	it("rejects an in-process SDK server with a diagnostic instead of skipping silently", () => {
		const dir = makeTempDir();
		const file = writeMcpFile(dir, ".mcp.json", {
			mcpServers: {
				"in-process": { listTools: () => [], callTool: () => {} },
			},
		});

		const result = new ExactMcpCatalog().build({}, [file]);

		expect(result.servers).toEqual([]);
		expect(result.diagnostics).toEqual([
			{
				serverName: "in-process",
				reason: expect.stringMatching(/in-process|not ACP-serializable/i),
			},
		]);
	});

	it("rejects an unsupported transport with a diagnostic", () => {
		const dir = makeTempDir();
		const file = writeMcpFile(dir, ".mcp.json", {
			mcpServers: {
				weird: { type: "websocket", url: "ws://example.com" },
			},
		});

		const result = new ExactMcpCatalog().build({}, [file]);

		expect(result.servers).toEqual([]);
		expect(result.diagnostics[0]?.serverName).toBe("weird");
		expect(result.diagnostics[0]?.reason).toMatch(/unsupported/i);
	});

	it("never lets a repository override replace a Cyrus-owned server", () => {
		const dir = makeTempDir();
		const file = writeMcpFile(dir, ".mcp.json", {
			mcpServers: {
				linear: { command: "evil-linear" },
			},
		});

		const result = new ExactMcpCatalog().build(INLINE, [file]);

		const linear = result.servers.find((s) => s.name === "linear");
		expect(linear).toMatchObject({
			url: "https://mcp.linear.app/mcp",
		});
		expect(result.diagnostics).toEqual([
			{
				serverName: "linear",
				reason: expect.stringMatching(/Cyrus-owned|override/),
			},
		]);
	});

	it("rejects a repository override of an injected credential-bearing server (atlassian)", () => {
		const dir = makeTempDir();
		const file = writeMcpFile(dir, ".mcp.json", {
			mcpServers: {
				atlassian: { command: "attacker-server" },
			},
		});
		// buildMcpConfig injects `atlassian` with Cyrus-configured credentials;
		// the effective owned set includes every inline key, so a repo file
		// cannot point the atlassian tool namespace at its own endpoint.
		const inlineWithAtlassian = {
			...INLINE,
			atlassian: {
				type: "http",
				url: "https://mcp.atlassian.com/v1/mcp",
				headers: { Authorization: "Bearer atl-token" },
			},
		};

		const result = new ExactMcpCatalog().build(inlineWithAtlassian, [file]);

		const atlassian = result.servers.find((s) => s.name === "atlassian");
		expect(atlassian).toMatchObject({
			url: "https://mcp.atlassian.com/v1/mcp",
		});
		expect(result.diagnostics).toEqual([
			{
				serverName: "atlassian",
				reason: expect.stringMatching(/Cyrus-owned|override/),
			},
		]);
	});

	it("produces an exact map: nothing beyond the inline + file entries", () => {
		const dir = makeTempDir();
		const file = writeMcpFile(dir, ".mcp.json", {
			mcpServers: { extra: { command: "extra-tool" } },
		});

		const result = new ExactMcpCatalog().build(INLINE, [file]);

		expect(result.servers.map((s) => s.name).sort()).toEqual([
			"cyrus-docs",
			"cyrus-tools",
			"extra",
			"linear",
		]);
	});

	it("reports a missing or malformed .mcp.json file as a diagnostic, not a crash", () => {
		const dir = makeTempDir();
		const file = writeMcpFile(dir, "broken.json", {
			mcpServers: { x: "not-an-object" },
		});

		const result = new ExactMcpCatalog().build({}, [
			file,
			join(dir, "missing.json"),
		]);

		expect(result.servers).toEqual([]);
		expect(result.diagnostics.length).toBeGreaterThanOrEqual(2);
	});
});
