/**
 * Budgets — deterministic per-tier cap checks (ported from `pipeline/budgets.py`,
 * DESIGN.md §Budgets, config/budgets.yaml).
 *
 * Plain minute/token comparisons, never an LM (anti-goal #1). Execute is opaque — Cyrus owns
 * runtime enforcement (terminating an over-cap run mid-flight), so this module does NOT
 * terminate anything. It reports whether a FINISHED run's telemetry exceeded its tier cap, so
 * `learn record` can surface an over-budget run instead of budgets.yaml being dead config.
 *
 * ADVISORY: a missing value OR a missing cap is never treated as an exceedance.
 */

import { loadYaml } from "./config.js";

export interface TierCaps {
	agent_minutes?: number;
	tokens_total?: number;
	[key: string]: number | undefined;
}

export interface Exceedance {
	metric: string;
	value: number;
	cap: number;
}

export interface BudgetResult {
	tier: string;
	caps: TierCaps;
	exceeded: Exceedance[];
	within_budget: boolean;
}

export function capsFor(tier: string): TierCaps {
	const budgets = loadYaml("budgets.yaml") as {
		tiers?: Record<string, TierCaps>;
	};
	return budgets.tiers?.[tier] ?? {};
}

/**
 * Which caps this run exceeded. `exceeded` empty == within budget (or no telemetry / no cap
 * configured for the tier — a missing datum is never treated as an exceedance).
 */
export function check(
	tier: string,
	opts: { agentMinutes?: number | null; tokensTotal?: number | null } = {},
): BudgetResult {
	const caps = capsFor(tier);
	const exceeded: Exceedance[] = [];
	const pairs: Array<[string, number | null | undefined]> = [
		["agent_minutes", opts.agentMinutes],
		["tokens_total", opts.tokensTotal],
	];
	for (const [metric, value] of pairs) {
		const cap = caps[metric];
		if (value != null && cap != null && value > cap) {
			exceeded.push({ metric, value, cap });
		}
	}
	return {
		tier,
		caps,
		exceeded,
		within_budget: exceeded.length === 0,
	};
}

export function checkRecord(record: {
	tier?: string;
	agent_minutes?: number | null;
	tokens_total?: number | null;
}): BudgetResult {
	return check(record.tier ?? "", {
		agentMinutes: record.agent_minutes,
		tokensTotal: record.tokens_total,
	});
}
