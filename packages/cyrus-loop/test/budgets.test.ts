import { describe, expect, it } from "vitest";
import { check, checkRecord } from "../src/budgets.js";

// Ported from tests/test_budgets.py. Caps come from the bundled config/budgets.yaml:
//   feature -> agent_minutes 120, tokens_total 1_500_000
//   chore   -> agent_minutes 15,  tokens_total 200_000
describe("budgets", () => {
	it("reports within budget when under every cap", () => {
		const r = check("feature", { agentMinutes: 40, tokensTotal: 200_000 });
		expect(r.within_budget).toBe(true);
		expect(r.exceeded).toEqual([]);
	});

	it("reports each metric that exceeded its cap", () => {
		const r = check("chore", { agentMinutes: 30, tokensTotal: 999_999 });
		const metrics = new Set(r.exceeded.map((e) => e.metric));
		expect(metrics).toEqual(new Set(["agent_minutes", "tokens_total"]));
		expect(r.within_budget).toBe(false);
	});

	it("treats missing telemetry as NOT an exceedance", () => {
		const r = check("feature", { agentMinutes: null, tokensTotal: null });
		expect(r.within_budget).toBe(true);
	});

	it("treats an unknown tier as having no caps (never over budget)", () => {
		const r = check("nonexistent", {
			agentMinutes: 10_000,
			tokensTotal: 10_000_000,
		});
		expect(r.caps).toEqual({});
		expect(r.within_budget).toBe(true);
	});

	it("checkRecord pulls telemetry off a run record", () => {
		const rec = { tier: "chore", agent_minutes: 99, tokens_total: 10 };
		expect(checkRecord(rec).exceeded[0]!.metric).toBe("agent_minutes");
	});
});
