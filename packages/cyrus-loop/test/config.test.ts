import { describe, expect, it } from "vitest";
import { loadYaml } from "../src/config.js";

// Ported from the config-loading behaviour exercised across the Python suite.
describe("config", () => {
	it("loads the bundled budgets.yaml", () => {
		const budgets = loadYaml("budgets.yaml") as {
			version: number;
			tiers: Record<string, { agent_minutes: number; tokens_total: number }>;
		};
		expect(budgets.version).toBe(1);
		expect(budgets.tiers.chore?.agent_minutes).toBe(15);
		expect(Object.keys(budgets.tiers).sort()).toEqual([
			"chore",
			"feature",
			"full",
			"small",
		]);
	});

	it("loads the bundled route.yaml as an object", () => {
		expect(typeof loadYaml("route.yaml")).toBe("object");
	});

	it("returns the cached object on repeat reads (same reference)", () => {
		expect(loadYaml("budgets.yaml")).toBe(loadYaml("budgets.yaml"));
	});
});
