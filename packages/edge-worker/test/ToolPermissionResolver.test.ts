import {
	GITHUB_DEFAULT_ALLOWED_TOOLS,
	LINEAR_DEFAULT_ALLOWED_TOOLS,
} from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import { ToolPermissionResolver } from "../src/ToolPermissionResolver.js";

function makeLogger() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as any;
}

function makeResolver(config: Record<string, unknown> = {}) {
	const cfg = { repositories: [], ...config } as any;
	return { resolver: new ToolPermissionResolver(cfg, makeLogger()), cfg };
}

const repo = (overrides: Record<string, unknown> = {}) =>
	({ id: "r1", name: "Repo One", ...overrides }) as any;

describe("ToolPermissionResolver", () => {
	describe("buildAllowedTools (Linear)", () => {
		it("falls back to the Linear platform default when nothing is configured", () => {
			const { resolver } = makeResolver();
			expect(resolver.buildAllowedTools(repo())).toEqual([
				...LINEAR_DEFAULT_ALLOWED_TOOLS,
			]);
		});

		it("uses the workspace linearAllowedTools when configured", () => {
			const { resolver } = makeResolver({
				linearAllowedTools: ["Read", "Grep"],
			});
			expect(resolver.buildAllowedTools(repo())).toEqual(["Read", "Grep"]);
		});

		// The CLI hands us `linearAllowedTools: []` whenever the operator has not
		// set one (`WorkerService` resolves `env || config || []`). An empty array
		// is truthy, so treating it as "configured" silently replaced the platform
		// default with an empty allow-list — every Bash/Edit/Write call then fell
		// through to the fail-closed `canUseTool` and was denied with
		// "Tool Bash is not allowed in this session".
		it("treats an empty workspace linearAllowedTools as unset, not as a lockdown", () => {
			const { resolver } = makeResolver({ linearAllowedTools: [] });
			expect(resolver.buildAllowedTools(repo())).toEqual([
				...LINEAR_DEFAULT_ALLOWED_TOOLS,
			]);
		});

		it("treats an empty repo-level allowedTools as unset, not as a lockdown", () => {
			const { resolver } = makeResolver();
			expect(resolver.buildAllowedTools(repo({ allowedTools: [] }))).toEqual([
				...LINEAR_DEFAULT_ALLOWED_TOOLS,
			]);
		});

		it("treats an empty linearAllowedTools as unset for a repo-less session", () => {
			const { resolver } = makeResolver({ linearAllowedTools: [] });
			expect(resolver.buildAllowedTools([])).toEqual([
				...LINEAR_DEFAULT_ALLOWED_TOOLS,
			]);
		});

		it("prefers a repo-level allowedTools override over the workspace default", () => {
			const { resolver } = makeResolver({ linearAllowedTools: ["Read"] });
			expect(
				resolver.buildAllowedTools(repo({ allowedTools: ["Bash"] })),
			).toEqual(["Bash"]);
		});

		it("unions per-repo lists across a multi-repo session", () => {
			const { resolver } = makeResolver();
			const result = resolver.buildAllowedTools([
				repo({ id: "a", allowedTools: ["Read", "Grep"] }),
				repo({ id: "b", allowedTools: ["Grep", "Bash"] }),
			]);
			expect(new Set(result)).toEqual(new Set(["Read", "Grep", "Bash"]));
		});

		it("honors an explicit platformDefault parameter at the bottom of the chain", () => {
			const { resolver } = makeResolver({ linearAllowedTools: ["Read"] });
			// Repo has no override → the passed platformDefault wins over the
			// configured linearAllowedTools.
			expect(resolver.buildAllowedTools(repo(), undefined, ["X", "Y"])).toEqual(
				["X", "Y"],
			);
		});
	});

	describe("buildGithubAllowedTools", () => {
		it("uses the GitHub platform default when githubAllowedTools is unset", () => {
			const { resolver } = makeResolver();
			expect(resolver.buildGithubAllowedTools(repo())).toEqual([
				...GITHUB_DEFAULT_ALLOWED_TOOLS,
			]);
		});

		it("uses the configured githubAllowedTools when non-empty", () => {
			const { resolver } = makeResolver({
				githubAllowedTools: ["Read", "mcp__github"],
			});
			expect(resolver.buildGithubAllowedTools(repo())).toEqual([
				"Read",
				"mcp__github",
			]);
		});

		it("falls back to the GitHub default when githubAllowedTools is an empty array", () => {
			const { resolver } = makeResolver({ githubAllowedTools: [] });
			expect(resolver.buildGithubAllowedTools(repo())).toEqual([
				...GITHUB_DEFAULT_ALLOWED_TOOLS,
			]);
		});

		it("still lets a repo-level allowedTools override win over the GitHub default", () => {
			const { resolver } = makeResolver({ githubAllowedTools: ["Read"] });
			expect(
				resolver.buildGithubAllowedTools(repo({ allowedTools: ["Bash"] })),
			).toEqual(["Bash"]);
		});

		it("does NOT mutate the shared config's linearAllowedTools (aliasing regression)", () => {
			const { resolver, cfg } = makeResolver({
				linearAllowedTools: ["Read", "Grep"],
				githubAllowedTools: ["mcp__github"],
			});
			const before = cfg.linearAllowedTools;
			resolver.buildGithubAllowedTools(repo());
			// Same reference, same contents — the GitHub resolution left the
			// shared normalized config object untouched.
			expect(cfg.linearAllowedTools).toBe(before);
			expect(cfg.linearAllowedTools).toEqual(["Read", "Grep"]);
		});

		it("leaves the Linear resolution unaffected after a GitHub resolution", () => {
			const { resolver } = makeResolver({
				linearAllowedTools: ["Read", "Grep"],
				githubAllowedTools: ["mcp__github"],
			});
			resolver.buildGithubAllowedTools(repo());
			// A subsequent Linear call must still see the Linear default, proving
			// no cross-call state leaked through config mutation.
			expect(resolver.buildAllowedTools(repo())).toEqual(["Read", "Grep"]);
		});
	});

	describe("buildDisallowedTools", () => {
		it("returns the global default disallowed tools for a repo with no override", () => {
			const { resolver } = makeResolver({ defaultDisallowedTools: ["Bash"] });
			expect(resolver.buildDisallowedTools(repo())).toEqual(["Bash"]);
		});

		it("intersects disallowed tools across a multi-repo session", () => {
			const { resolver } = makeResolver();
			const result = resolver.buildDisallowedTools([
				repo({ id: "a", disallowedTools: ["Bash", "WebFetch"] }),
				repo({ id: "b", disallowedTools: ["Bash"] }),
			]);
			expect(result).toEqual(["Bash"]);
		});
	});
});
