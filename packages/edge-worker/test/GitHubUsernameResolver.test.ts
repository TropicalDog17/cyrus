/**
 * Unit tests for GitHubUsernameResolver.
 *
 * Covers the behavior moved out of PromptBuilder.resolveGitHubUsername:
 * resolve a numeric GitHub user ID to a login via the public REST API, never
 * throwing on failure.
 */

import { createLogger, LogLevel } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubUsernameResolver } from "../src/GitHubUsernameResolver.js";

const logger = createLogger({
	component: "github-username-resolver-test",
	level: LogLevel.SILENT,
});

describe("GitHubUsernameResolver", () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	it("returns the login on a 200 response", async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ login: "octocat" }),
		}) as unknown as typeof fetch;

		const resolver = new GitHubUsernameResolver(logger);
		const result = await resolver.resolve("583231");

		expect(result).toBe("octocat");
		expect(global.fetch).toHaveBeenCalledWith(
			"https://api.github.com/user/583231",
			expect.objectContaining({
				headers: expect.objectContaining({
					Accept: "application/vnd.github.v3+json",
					"User-Agent": "Cyrus-Agent",
				}),
			}),
		);
	});

	it("returns undefined on a non-ok status", async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 404,
			json: async () => ({}),
		}) as unknown as typeof fetch;

		const resolver = new GitHubUsernameResolver(logger);
		const result = await resolver.resolve("999999");

		expect(result).toBeUndefined();
	});

	it("returns undefined (never throws) when fetch rejects", async () => {
		global.fetch = vi
			.fn()
			.mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

		const resolver = new GitHubUsernameResolver(logger);
		await expect(resolver.resolve("123")).resolves.toBeUndefined();
	});

	it("returns undefined when the 200 body has no login field", async () => {
		global.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ id: 123 }),
		}) as unknown as typeof fetch;

		const resolver = new GitHubUsernameResolver(logger);
		const result = await resolver.resolve("123");

		expect(result).toBeUndefined();
	});
});
