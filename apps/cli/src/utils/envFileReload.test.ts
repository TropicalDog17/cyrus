import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createDebouncedCallback,
	snapshotTokenLengths,
	summarizeTokenLengthChanges,
} from "./envFileReload.js";

describe("snapshotTokenLengths", () => {
	it("records lengths and treats missing keys as 0", () => {
		expect(
			snapshotTokenLengths({ ATLASSIAN_MCP_TOKEN: "abc", OTHER: "x" }, [
				"ATLASSIAN_MCP_TOKEN",
				"MISSING",
			]),
		).toEqual({ ATLASSIAN_MCP_TOKEN: 3, MISSING: 0 });
	});
});

describe("summarizeTokenLengthChanges", () => {
	it("reports only keys whose length changed", () => {
		const before = { ATLASSIAN_MCP_TOKEN: 10, LINEAR_WEBHOOK_SECRET: 20 };
		const after = { ATLASSIAN_MCP_TOKEN: 12, LINEAR_WEBHOOK_SECRET: 20 };
		expect(summarizeTokenLengthChanges(before, after)).toEqual([
			"ATLASSIAN_MCP_TOKEN: 10 chars → 12 chars",
		]);
	});

	it("describes unset transitions", () => {
		expect(
			summarizeTokenLengthChanges(
				{ ATLASSIAN_MCP_TOKEN: 0 },
				{ ATLASSIAN_MCP_TOKEN: 8 },
			),
		).toEqual(["ATLASSIAN_MCP_TOKEN: unset → 8 chars"]);
	});
});

describe("createDebouncedCallback", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("coalesces rapid schedule calls into a single invoke", () => {
		vi.useFakeTimers();
		const fn = vi.fn();
		const debounced = createDebouncedCallback(fn, 200);

		debounced.schedule();
		debounced.schedule();
		debounced.schedule();
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(199);
		expect(fn).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("cancel prevents a pending invoke", () => {
		vi.useFakeTimers();
		const fn = vi.fn();
		const debounced = createDebouncedCallback(fn, 100);
		debounced.schedule();
		debounced.cancel();
		vi.advanceTimersByTime(200);
		expect(fn).not.toHaveBeenCalled();
	});
});
