import { describe, expect, it } from "vitest";
import {
	type ParkedSession,
	ParkedSessionRegistry,
} from "../src/ParkedSessionRegistry.js";

/**
 * Pure state-machine unit tests for {@link ParkedSessionRegistry}. No EdgeWorker,
 * no I/O — just park/isParked/get/wake/resolveBlocker/setBlockers transitions.
 */

function makeParked(
	issueId: string,
	blockingIssueIds: string[],
): ParkedSession {
	return {
		agentSession: {
			id: `agent-${issueId}`,
			issue: { id: issueId, identifier: issueId },
		} as unknown as ParkedSession["agentSession"],
		repositories: [
			{ id: "repo-1" } as unknown as ParkedSession["repositories"][number],
		],
		linearWorkspaceId: "ws-1",
		blockingIssueIds,
	};
}

describe("ParkedSessionRegistry", () => {
	it("park then isParked/get returns the stored entry", () => {
		const reg = new ParkedSessionRegistry();
		const parked = makeParked("ISSUE-1", ["BLOCKER-1"]);

		expect(reg.isParked("ISSUE-1")).toBe(false);
		reg.park("ISSUE-1", parked);

		expect(reg.isParked("ISSUE-1")).toBe(true);
		expect(reg.get("ISSUE-1")).toBe(parked);
	});

	it("wake returns and removes the entry", () => {
		const reg = new ParkedSessionRegistry();
		const parked = makeParked("ISSUE-1", ["BLOCKER-1"]);
		reg.park("ISSUE-1", parked);

		const woken = reg.wake("ISSUE-1");
		expect(woken).toBe(parked);
		expect(reg.isParked("ISSUE-1")).toBe(false);
		expect(reg.get("ISSUE-1")).toBeUndefined();
		// Waking a second time yields nothing.
		expect(reg.wake("ISSUE-1")).toBeUndefined();
	});

	it("resolveBlocker with a single blocker returns the issueId and empties its list", () => {
		const reg = new ParkedSessionRegistry();
		reg.park("ISSUE-1", makeParked("ISSUE-1", ["BLOCKER-1"]));

		const ready = reg.resolveBlocker("BLOCKER-1");

		expect(ready).toEqual(["ISSUE-1"]);
		// resolveBlocker does NOT delete — the entry is still parked (caller wakes).
		expect(reg.isParked("ISSUE-1")).toBe(true);
		expect(reg.get("ISSUE-1")?.blockingIssueIds).toEqual([]);
	});

	it("resolveBlocker with two blockers returns nothing until both resolve", () => {
		const reg = new ParkedSessionRegistry();
		reg.park("ISSUE-1", makeParked("ISSUE-1", ["BLOCKER-1", "BLOCKER-2"]));

		// First blocker resolved — still blocked by BLOCKER-2, not ready.
		expect(reg.resolveBlocker("BLOCKER-1")).toEqual([]);
		expect(reg.get("ISSUE-1")?.blockingIssueIds).toEqual(["BLOCKER-2"]);

		// Second blocker resolved — now ready.
		expect(reg.resolveBlocker("BLOCKER-2")).toEqual(["ISSUE-1"]);
		expect(reg.get("ISSUE-1")?.blockingIssueIds).toEqual([]);
	});

	it("resolveBlocker for an unrelated completed issue returns [] and mutates nothing", () => {
		const reg = new ParkedSessionRegistry();
		reg.park("ISSUE-1", makeParked("ISSUE-1", ["BLOCKER-1"]));

		expect(reg.resolveBlocker("SOMETHING-ELSE")).toEqual([]);
		expect(reg.get("ISSUE-1")?.blockingIssueIds).toEqual(["BLOCKER-1"]);
	});

	it("resolveBlocker only wakes the entries that become empty", () => {
		const reg = new ParkedSessionRegistry();
		reg.park("ISSUE-1", makeParked("ISSUE-1", ["BLOCKER-1"]));
		reg.park("ISSUE-2", makeParked("ISSUE-2", ["BLOCKER-1", "BLOCKER-2"]));

		const ready = reg.resolveBlocker("BLOCKER-1");

		expect(ready).toEqual(["ISSUE-1"]);
		expect(reg.get("ISSUE-2")?.blockingIssueIds).toEqual(["BLOCKER-2"]);
	});

	it("setBlockers overwrites the blocker list (reprompt re-check path)", () => {
		const reg = new ParkedSessionRegistry();
		reg.park("ISSUE-1", makeParked("ISSUE-1", ["BLOCKER-1"]));

		reg.setBlockers("ISSUE-1", ["BLOCKER-2", "BLOCKER-3"]);

		expect(reg.get("ISSUE-1")?.blockingIssueIds).toEqual([
			"BLOCKER-2",
			"BLOCKER-3",
		]);
		// No-op for an unknown issue.
		reg.setBlockers("UNKNOWN", ["X"]);
		expect(reg.isParked("UNKNOWN")).toBe(false);
	});

	it("getAll is a read-only snapshot of parked entries", () => {
		const reg = new ParkedSessionRegistry();
		const parked = makeParked("ISSUE-1", ["BLOCKER-1"]);
		reg.park("ISSUE-1", parked);

		const all = reg.getAll();
		expect(all.size).toBe(1);
		expect(all.get("ISSUE-1")).toBe(parked);
	});
});
