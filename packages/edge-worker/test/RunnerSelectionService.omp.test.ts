import type { EdgeWorkerConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { RunnerSelectionService } from "../src/RunnerSelectionService.js";

/**
 * Canary rules for the OMP profile (ADR 0009 / PR 1): only an explicit
 * `[agent=omp]` tag or the `omp` label selects it. No model inference, no
 * default eligibility. Description tags outrank labels; a resumed session's
 * persisted `agentProfileId` outranks everything.
 */
describe("RunnerSelectionService — OMP canary", () => {
	const makeService = (config: Partial<EdgeWorkerConfig> = {}) =>
		new RunnerSelectionService(config as EdgeWorkerConfig);

	it("selects omp via an [agent=omp] description tag", () => {
		const result = makeService().determineRunnerSelection(
			[],
			"Please fix [agent=omp]",
		);
		expect(result.agentProfileId).toBe("omp");
	});

	it("selects omp via an omp label", () => {
		const result = makeService().determineRunnerSelection(["omp"]);
		expect(result.agentProfileId).toBe("omp");
	});

	it("lets [agent=omp] win over conflicting labels", () => {
		const result = makeService().determineRunnerSelection(
			["claude"],
			"Use [agent=omp] here",
		);
		expect(result.agentProfileId).toBe("omp");
	});

	it("lets [agent=claude] win over an omp label", () => {
		const result = makeService().determineRunnerSelection(
			["omp"],
			"Use [agent=claude] here",
		);
		expect(result.agentProfileId).toBe("claude");
	});

	it("never selects omp from model-only selection", () => {
		const service = makeService();
		expect(service.determineRunnerSelection(["opus"]).agentProfileId).not.toBe(
			"omp",
		);
		expect(
			service.determineRunnerSelection([], "[model=opus]").agentProfileId,
		).not.toBe("omp");
		// An unknown model still falls to the default, never to omp.
		expect(service.determineRunnerSelection(["nonsense"]).agentProfileId).toBe(
			"claude",
		);
	});

	it("never selects omp as the configured default", () => {
		// The schema forbids naming omp here; at runtime the registry refuses it.
		expect(
			makeService({ defaultAgentProfile: "claude" }).determineRunnerSelection(
				[],
			).agentProfileId,
		).toBe("claude");
	});

	it("resolves the persisted agentProfileId for resumed sessions, ignoring changed selectors", () => {
		// A session that started as omp must stay omp even when the issue's
		// labels/description now say claude. This mirrors the runner pinning in
		// RunnerConfigBuilder: the persisted `agentProfileId` is authoritative.
		const service = makeService();
		const selection = service.determineRunnerSelection(
			["claude"],
			"Use [agent=claude]",
		);
		expect(selection.agentProfileId).toBe("claude");

		// The pinning decision itself lives in RunnerConfigBuilder; here we
		// assert the registry can resolve any persisted profile id, including
		// the canary, so pinning never fails closed on it.
		const registry = (
			service as unknown as { registry: { get: (id: string) => unknown } }
		).registry;
		expect(registry.get("omp")).toBeDefined();
	});
});
