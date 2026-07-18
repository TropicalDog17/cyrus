import type { AgentUsage } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	addUsage,
	emptyUsage,
	formatUsageFooter,
	subtractUsage,
} from "../src/usage-footer";

const usage = (partial: Partial<AgentUsage>): AgentUsage => ({
	...emptyUsage(),
	...partial,
});

describe("formatUsageFooter", () => {
	it("renders cost, token counts, and cached share", () => {
		expect(
			formatUsageFooter(
				usage({
					inputTokens: 12345,
					outputTokens: 3100,
					cacheReadTokens: 70000,
					cacheWriteTokens: 0,
					costUsd: 0.42,
				}),
			),
		).toBe("$0.42 · 12.3k in / 3.1k out · 85% cached");
	});

	it("rounds cost to two decimals and tokens to one decimal", () => {
		expect(
			formatUsageFooter(
				usage({
					inputTokens: 1290,
					outputTokens: 999,
					costUsd: 0.014,
				}),
			),
		).toBe("$0.01 · 1.3k in / 999 out · 0% cached");
	});

	it("reports 0% cached when nothing was served from cache", () => {
		expect(
			formatUsageFooter(
				usage({ inputTokens: 1000, outputTokens: 500, costUsd: 0.1 }),
			),
		).toBe("$0.10 · 1.0k in / 500 out · 0% cached");
	});

	it("reports 100% cached when all input came from cache", () => {
		expect(
			formatUsageFooter(
				usage({ cacheReadTokens: 5000, outputTokens: 200, costUsd: 0.05 }),
			),
		).toBe("$0.05 · 0 in / 200 out · 100% cached");
	});

	it("returns null when every counter is zero", () => {
		expect(formatUsageFooter(emptyUsage())).toBeNull();
	});

	it("still renders when only cost is non-zero", () => {
		expect(formatUsageFooter(usage({ costUsd: 0.03 }))).toBe(
			"$0.03 · 0 in / 0 out · 0% cached",
		);
	});
});

describe("addUsage / subtractUsage", () => {
	it("adds field-wise", () => {
		expect(
			addUsage(
				usage({
					inputTokens: 10,
					outputTokens: 20,
					cacheReadTokens: 30,
					cacheWriteTokens: 40,
					costUsd: 0.5,
				}),
				usage({
					inputTokens: 1,
					outputTokens: 2,
					cacheReadTokens: 3,
					cacheWriteTokens: 4,
					costUsd: 0.25,
				}),
			),
		).toEqual({
			inputTokens: 11,
			outputTokens: 22,
			cacheReadTokens: 33,
			cacheWriteTokens: 44,
			costUsd: 0.75,
		});
	});

	it("subtracts field-wise", () => {
		expect(
			subtractUsage(
				usage({
					inputTokens: 10,
					outputTokens: 20,
					cacheReadTokens: 30,
					cacheWriteTokens: 40,
					costUsd: 0.5,
				}),
				usage({
					inputTokens: 4,
					outputTokens: 5,
					cacheReadTokens: 6,
					cacheWriteTokens: 7,
					costUsd: 0.2,
				}),
			),
		).toEqual({
			inputTokens: 6,
			outputTokens: 15,
			cacheReadTokens: 24,
			cacheWriteTokens: 33,
			costUsd: expect.closeTo(0.3, 10),
		});
	});

	it("clamps subtraction at zero (never reports a negative delta)", () => {
		expect(
			subtractUsage(
				usage({ inputTokens: 5, costUsd: 0.1 }),
				usage({ inputTokens: 8, costUsd: 0.3 }),
			),
		).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
		});
	});
});
