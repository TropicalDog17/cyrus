import type { ILogger } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import { resolveAutoCompactWindow } from "../src/SessionOrchestrator.js";

function makeLogger(): ILogger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	} as unknown as ILogger;
}

/**
 * The Claude CLI validates `settings.autoCompactWindow` with
 * `min(1e5).max(1e6).catch(undefined)`, so an out-of-range value is dropped
 * without a word and the session compacts at the model's native window.
 * Verified in an F1 drive: a 40000 window let a session reach 154k tokens
 * uncompacted, while 100000 compacted it at 70k.
 */
describe("resolveAutoCompactWindow", () => {
	it("passes through a window the SDK accepts", () => {
		const logger = makeLogger();
		expect(resolveAutoCompactWindow(120_000, logger)).toBe(120_000);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it.each([100_000, 1_000_000])("accepts the boundary value %i", (window) => {
		expect(resolveAutoCompactWindow(window, makeLogger())).toBe(window);
	});

	it.each([
		40_000, 99_999, 1_000_001,
	])("drops out-of-range %i and warns rather than pretending it works", (window) => {
		const logger = makeLogger();
		expect(resolveAutoCompactWindow(window, logger)).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toContain(String(window));
	});

	it("leaves an unset window unset without warning", () => {
		const logger = makeLogger();
		expect(resolveAutoCompactWindow(undefined, logger)).toBeUndefined();
		expect(logger.warn).not.toHaveBeenCalled();
	});
});
