import type { EdgeWorkerConfig } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerSelectionService } from "../src/RunnerSelectionService.js";

/**
 * Unit coverage for Codex routing in {@link RunnerSelectionService}: label,
 * `[agent=codex]` tag, and model-family inference, plus the model/fallback
 * defaults and the precedence rules that govern conflicts between them.
 */
describe("RunnerSelectionService — Codex routing", () => {
	const makeService = (config: Partial<EdgeWorkerConfig> = {}) =>
		new RunnerSelectionService(config as EdgeWorkerConfig);

	// getDefaultRunner reads process.env; snapshot and restore the auth vars so
	// tests never leak credentials state into one another.
	const AUTH_KEYS = [
		"CLAUDE_CODE_OAUTH_TOKEN",
		"ANTHROPIC_API_KEY",
		"CURSOR_API_KEY",
		"CODEX_API_KEY",
		"OPENAI_API_KEY",
	];
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		savedEnv = {};
		for (const key of AUTH_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of AUTH_KEYS) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	describe("default runner", () => {
		it("honors an explicit codex defaultRunner", () => {
			expect(makeService({ defaultRunner: "codex" }).getDefaultRunner()).toBe(
				"codex",
			);
		});

		it("auto-selects codex when only Codex/OpenAI credentials are present", () => {
			process.env.OPENAI_API_KEY = "sk-test";
			expect(makeService().getDefaultRunner()).toBe("codex");
		});

		it("does not auto-select codex when Claude credentials are also present", () => {
			process.env.OPENAI_API_KEY = "sk-test";
			process.env.ANTHROPIC_API_KEY = "sk-claude";
			expect(makeService().getDefaultRunner()).toBe("claude");
		});
	});

	describe("default model + fallback", () => {
		it("returns the built-in gpt-5-codex default", () => {
			const service = makeService();
			expect(service.getDefaultModelForRunner("codex")).toBe("gpt-5-codex");
			expect(service.getDefaultFallbackModelForRunner("codex")).toBe(
				"gpt-5-codex",
			);
		});

		it("honors configured codex model + fallback overrides", () => {
			const service = makeService({
				codexDefaultModel: "gpt-5",
				codexDefaultFallbackModel: "o4-mini",
			});
			expect(service.getDefaultModelForRunner("codex")).toBe("gpt-5");
			expect(service.getDefaultFallbackModelForRunner("codex")).toBe("o4-mini");
		});
	});

	describe("determineRunnerSelection", () => {
		it("routes to codex via a `codex` label", () => {
			const result = makeService({
				defaultRunner: "claude",
			}).determineRunnerSelection(["codex"]);
			expect(result).toEqual({
				runnerType: "codex",
				modelOverride: "gpt-5-codex",
				fallbackModelOverride: "gpt-5-codex",
			});
		});

		it("routes to codex via an [agent=codex] description tag", () => {
			const result = makeService({
				defaultRunner: "claude",
			}).determineRunnerSelection([], "Please fix [agent=codex] now");
			expect(result.runnerType).toBe("codex");
			expect(result.modelOverride).toBe("gpt-5-codex");
		});

		it("infers codex from a gpt-* model label and keeps the explicit model", () => {
			const result = makeService({
				defaultRunner: "claude",
			}).determineRunnerSelection(["gpt-5"]);
			expect(result).toEqual({
				runnerType: "codex",
				modelOverride: "gpt-5",
				fallbackModelOverride: "gpt-5-codex",
			});
		});

		it("infers codex from an o-series model tag", () => {
			const result = makeService({
				defaultRunner: "claude",
			}).determineRunnerSelection([], "Try [model=o3] on this");
			expect(result.runnerType).toBe("codex");
			expect(result.modelOverride).toBe("o3");
		});

		it("lets the [agent=codex] tag win over a conflicting cursor label", () => {
			const result = makeService({
				defaultRunner: "claude",
			}).determineRunnerSelection(["cursor"], "[agent=codex]");
			expect(result.runnerType).toBe("codex");
		});

		it("drops a claude model that conflicts with an explicit [agent=codex]", () => {
			const result = makeService({
				defaultRunner: "claude",
			}).determineRunnerSelection([], "[agent=codex] [model=opus]");
			// The mismatched model is discarded; codex falls back to its default.
			expect(result.runnerType).toBe("codex");
			expect(result.modelOverride).toBe("gpt-5-codex");
		});
	});
});
