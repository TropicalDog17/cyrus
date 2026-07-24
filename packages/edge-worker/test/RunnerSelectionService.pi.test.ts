import type { EdgeWorkerConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { RunnerSelectionService } from "../src/RunnerSelectionService.js";

describe("RunnerSelectionService — Pi routing", () => {
	const makeService = (config: Partial<EdgeWorkerConfig> = {}) =>
		new RunnerSelectionService(config as EdgeWorkerConfig);

	it("routes to Pi via a pi label and lets Pi use its persisted model", () => {
		expect(
			makeService({ defaultRunner: "claude" }).determineRunnerSelection(["pi"]),
		).toEqual({
			runnerType: "pi",
			modelOverride: "",
			fallbackModelOverride: "",
		});
	});

	it("routes to Pi via [agent=pi] and keeps a cross-provider model", () => {
		expect(
			makeService({
				defaultRunner: "claude",
			}).determineRunnerSelection(
				["codex"],
				"[agent=pi] [model=openai/gpt-5.6]",
			),
		).toEqual({
			runnerType: "pi",
			modelOverride: "openai/gpt-5.6",
			fallbackModelOverride: "",
		});
	});

	it("honors piDefaultModel for explicit and default Pi selection", () => {
		const service = makeService({
			defaultRunner: "pi",
			piDefaultModel: "anthropic/claude-sonnet-4-5",
		});
		expect(service.getDefaultRunner()).toBe("pi");
		expect(service.getDefaultModelForRunner("pi")).toBe(
			"anthropic/claude-sonnet-4-5",
		);
		expect(service.determineRunnerSelection([])).toEqual({
			runnerType: "pi",
			modelOverride: "anthropic/claude-sonnet-4-5",
			fallbackModelOverride: "anthropic/claude-sonnet-4-5",
		});
	});
});
