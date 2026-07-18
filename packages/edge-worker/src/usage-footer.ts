import type { AgentUsage } from "cyrus-core";

/** Zero-valued usage — the additive identity for {@link addUsage}. */
export function emptyUsage(): AgentUsage {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUsd: 0,
	};
}

/** Field-wise sum of two usage records. */
export function addUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
		cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
		costUsd: a.costUsd + b.costUsd,
	};
}

/**
 * Field-wise `a − b`, clamped at 0. Used to turn a process-cumulative
 * `result.usage` into the per-turn delta since the previous result in the same
 * process (see `agent-docs/dev-gotchas.md`). Clamping guards against a provider
 * ever reporting a non-monotonic figure.
 */
export function subtractUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
	return {
		inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
		outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
		cacheReadTokens: Math.max(0, a.cacheReadTokens - b.cacheReadTokens),
		cacheWriteTokens: Math.max(0, a.cacheWriteTokens - b.cacheWriteTokens),
		costUsd: Math.max(0, a.costUsd - b.costUsd),
	};
}

/** Render a token count with one-decimal `k` suffix: 12345 -> "12.3k", 840 -> "840". */
function formatTokens(tokens: number): string {
	return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * Format a one-line usage footer for a final response, e.g.
 * `$0.42 · 12.3k in / 3.1k out · 85% cached`.
 *
 * `cached%` is `cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)`
 * — the share of total input served from the prompt cache.
 *
 * Returns `null` when every counter is zero (nothing worth surfacing), so
 * callers can skip appending a footer entirely.
 */
export function formatUsageFooter(usage: AgentUsage): string | null {
	const {
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		costUsd,
	} = usage;

	if (
		inputTokens === 0 &&
		outputTokens === 0 &&
		cacheReadTokens === 0 &&
		cacheWriteTokens === 0 &&
		costUsd === 0
	) {
		return null;
	}

	const totalInput = inputTokens + cacheReadTokens + cacheWriteTokens;
	const cachedPct =
		totalInput > 0 ? Math.round((cacheReadTokens / totalInput) * 100) : 0;

	return `$${costUsd.toFixed(2)} · ${formatTokens(inputTokens)} in / ${formatTokens(outputTokens)} out · ${cachedPct}% cached`;
}
