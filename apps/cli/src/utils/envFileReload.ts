/**
 * Helpers for hot-reloading ~/.cyrus/.env without restarting the process.
 *
 * Token-refresh timers rewrite .env / config.json; a full process restart drops
 * Linear webhooks for several seconds and has previously caused Linear to
 * disable the OAuth app after repeated delivery failures. Hot-reload is the
 * preferred path: Atlassian MCP config is built per session from process.env,
 * and Linear tokens are live-updated via ConfigManager.
 */

/** Keys whose length changes are safe to log (never log values). */
export const HOT_RELOAD_TOKEN_KEYS = [
	"ATLASSIAN_MCP_TOKEN",
	"LINEAR_WEBHOOK_SECRET",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CURSOR_API_KEY",
] as const;

/**
 * Snapshot token lengths from env for change detection after dotenv reload.
 */
export function snapshotTokenLengths(
	env: NodeJS.ProcessEnv,
	keys: readonly string[] = HOT_RELOAD_TOKEN_KEYS,
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const key of keys) {
		const value = env[key];
		out[key] = value ? value.length : 0;
	}
	return out;
}

/**
 * Human-readable summary of token length changes (no secret values).
 */
export function summarizeTokenLengthChanges(
	before: Record<string, number>,
	after: Record<string, number>,
): string[] {
	const lines: string[] = [];
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	for (const key of keys) {
		const from = before[key] ?? 0;
		const to = after[key] ?? 0;
		if (from === to) continue;
		lines.push(
			`${key}: ${from === 0 ? "unset" : `${from} chars`} → ${to === 0 ? "unset" : `${to} chars`}`,
		);
	}
	return lines;
}

/**
 * Debounce a void callback. Used to coalesce multi-fire fs.watch events from
 * atomic .env writes (editors and token-refresh scripts often emit 2–3 events).
 */
export function createDebouncedCallback(
	fn: () => void,
	delayMs: number,
): { schedule: () => void; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		schedule() {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			timer = setTimeout(() => {
				timer = undefined;
				fn();
			}, delayMs);
		},
		cancel() {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		},
	};
}
