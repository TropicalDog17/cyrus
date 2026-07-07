import { describe, expect, it } from "vitest";
import {
	buildAtlassianMcpServerConfig,
	DEFAULT_ATLASSIAN_MCP_URL,
} from "../src/AtlassianMcpConfig.js";

describe("buildAtlassianMcpServerConfig", () => {
	it("returns null when neither token nor URL is configured", () => {
		expect(buildAtlassianMcpServerConfig({})).toBeNull();
	});

	it("returns null when env values are blank/whitespace", () => {
		expect(
			buildAtlassianMcpServerConfig({
				ATLASSIAN_MCP_TOKEN: "   ",
				ATLASSIAN_MCP_URL: "  ",
			}),
		).toBeNull();
	});

	it("uses the official HTTP endpoint with a Bearer header when only a token is set", () => {
		const config = buildAtlassianMcpServerConfig({
			ATLASSIAN_MCP_TOKEN: "secret-token",
		});

		expect(config).toEqual({
			type: "http",
			url: DEFAULT_ATLASSIAN_MCP_URL,
			headers: { Authorization: "Bearer secret-token" },
		});
	});

	it("trims surrounding whitespace from the token", () => {
		const config = buildAtlassianMcpServerConfig({
			ATLASSIAN_MCP_TOKEN: "  secret-token  ",
		});

		expect(config).toMatchObject({
			headers: { Authorization: "Bearer secret-token" },
		});
	});

	it("uses a custom URL without auth headers when only a URL is set", () => {
		const config = buildAtlassianMcpServerConfig({
			ATLASSIAN_MCP_URL: "http://localhost:9000/mcp",
		});

		expect(config).toEqual({
			type: "http",
			url: "http://localhost:9000/mcp",
		});
		expect(config).not.toHaveProperty("headers");
	});

	it("combines a custom URL with a token", () => {
		const config = buildAtlassianMcpServerConfig({
			ATLASSIAN_MCP_URL: "https://self-hosted.example.com/mcp",
			ATLASSIAN_MCP_TOKEN: "api-token",
		});

		expect(config).toEqual({
			type: "http",
			url: "https://self-hosted.example.com/mcp",
			headers: { Authorization: "Bearer api-token" },
		});
	});

	it("selects the SSE transport for /sse endpoints", () => {
		const config = buildAtlassianMcpServerConfig({
			ATLASSIAN_MCP_URL: "https://mcp.atlassian.com/v1/sse",
			ATLASSIAN_MCP_TOKEN: "token",
		});

		expect(config).toEqual({
			type: "sse",
			url: "https://mcp.atlassian.com/v1/sse",
			headers: { Authorization: "Bearer token" },
		});
	});

	it("treats /sse with a trailing slash or query string as SSE", () => {
		expect(
			buildAtlassianMcpServerConfig({
				ATLASSIAN_MCP_URL: "https://example.com/v1/sse/",
			}),
		).toMatchObject({ type: "sse" });

		expect(
			buildAtlassianMcpServerConfig({
				ATLASSIAN_MCP_URL: "https://example.com/v1/sse?cloudId=abc",
			}),
		).toMatchObject({ type: "sse" });
	});

	it("does not misclassify non-/sse URLs that merely contain 'sse'", () => {
		expect(
			buildAtlassianMcpServerConfig({
				ATLASSIAN_MCP_URL: "https://example.com/sse-gateway/mcp",
			}),
		).toMatchObject({ type: "http" });
	});
});
