import type { AgentUsage } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";
import { addUsage } from "../src/usage-footer";
import {
	resultError,
	resultSuccess,
	systemInitMessage,
	zeroUsage,
} from "./agent-message-builders";

const usage = (partial: Partial<AgentUsage>): AgentUsage => ({
	...zeroUsage,
	...partial,
});

const sessionId = "session-usage";
const issueId = "issue-usage";

function makeManager(showUsageFooter?: boolean): {
	manager: AgentSessionManager;
	postSpy: ReturnType<typeof vi.fn>;
} {
	const sink: IActivitySink = {
		id: "test-workspace",
		post: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
		createAgentSession: vi.fn().mockResolvedValue("session-1"),
	};
	const manager =
		showUsageFooter === undefined
			? new AgentSessionManager()
			: new AgentSessionManager(
					undefined,
					undefined,
					undefined,
					showUsageFooter,
				);
	manager.createCyrusAgentSession(
		sessionId,
		issueId,
		{
			id: issueId,
			identifier: "TEST-1",
			title: "Test",
			description: "",
			branchName: "test-branch",
		},
		{ path: "/test/workspace", isGitWorktree: false },
	);
	manager.setActivitySink(sessionId, sink);
	return { manager, postSpy: sink.post as ReturnType<typeof vi.fn> };
}

describe("AgentSessionManager - usage accumulation", () => {
	let manager: AgentSessionManager;

	beforeEach(() => {
		({ manager } = makeManager());
	});

	it("deltas within one warm process; metadata.usage stays last-turn", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			systemInitMessage({ sessionId: "cs-1" }),
		);

		// Turn 1: process-cumulative usage so far.
		const turn1 = usage({
			inputTokens: 100,
			outputTokens: 10,
			cacheReadTokens: 50,
			costUsd: 0.1,
		});
		await manager.handleClaudeMessage(
			sessionId,
			resultSuccess("turn 1", { usage: turn1 }),
		);

		let meta = manager.getSession(sessionId)?.metadata;
		expect(meta?.cumulativeUsage).toEqual(turn1);
		expect(meta?.usage).toEqual(turn1);
		expect(meta?.turnCount).toBe(1);

		// Turn 2 in the SAME process: result.usage is the running process total
		// (turn1 + turn2), not turn 2 alone. Accumulating the delta must yield
		// exactly this cumulative — naive summation would double-count turn 1.
		const cumulativeAfter2 = usage({
			inputTokens: 250,
			outputTokens: 35,
			cacheReadTokens: 120,
			costUsd: 0.3,
		});
		await manager.handleClaudeMessage(
			sessionId,
			resultSuccess("turn 2", { usage: cumulativeAfter2 }),
		);

		meta = manager.getSession(sessionId)?.metadata;
		expect(meta?.cumulativeUsage).toEqual(cumulativeAfter2);
		expect(meta?.usage).toEqual(cumulativeAfter2);
		expect(meta?.turnCount).toBe(2);
	});

	it("resets the per-process baseline on a new init (cold resume)", async () => {
		// Process 1.
		await manager.handleClaudeMessage(
			sessionId,
			systemInitMessage({ sessionId: "cs-1" }),
		);
		const proc1 = usage({
			inputTokens: 200,
			outputTokens: 20,
			cacheReadTokens: 100,
			costUsd: 0.2,
		});
		await manager.handleClaudeMessage(
			sessionId,
			resultSuccess("t1", { usage: proc1 }),
		);

		// Process 2 (cold resume): a fresh init resets the baseline, so this
		// result's usage counts up from zero again and must be ADDED, not deltaed
		// against process 1's total.
		await manager.handleClaudeMessage(
			sessionId,
			systemInitMessage({ sessionId: "cs-2" }),
		);
		const proc2 = usage({
			inputTokens: 80,
			outputTokens: 8,
			cacheReadTokens: 300,
			costUsd: 0.15,
		});
		await manager.handleClaudeMessage(
			sessionId,
			resultSuccess("t2", { usage: proc2 }),
		);

		const meta = manager.getSession(sessionId)?.metadata;
		expect(meta?.cumulativeUsage).toEqual(addUsage(proc1, proc2));
		expect(meta?.usage).toEqual(proc2);
		expect(meta?.turnCount).toBe(2);
	});
});

describe("AgentSessionManager - usage footer", () => {
	it("appends the cumulative usage footer to a successful response", async () => {
		const { manager, postSpy } = makeManager();
		await manager.handleClaudeMessage(
			sessionId,
			systemInitMessage({ sessionId: "cs-1" }),
		);
		await manager.handleClaudeMessage(
			sessionId,
			resultSuccess("All done.", {
				usage: usage({
					inputTokens: 12345,
					outputTokens: 3100,
					cacheReadTokens: 70000,
					costUsd: 0.42,
				}),
			}),
		);

		const responseCall = postSpy.mock.calls.find(
			(call) => call[1]?.type === "response",
		);
		expect(responseCall?.[1].body).toBe(
			"All done.\n\n---\n$0.42 · 12.3k in / 3.1k out · 85% cached",
		);
	});

	it("suppresses the footer when showUsageFooter is false", async () => {
		const { manager, postSpy } = makeManager(false);
		await manager.handleClaudeMessage(
			sessionId,
			systemInitMessage({ sessionId: "cs-1" }),
		);
		await manager.handleClaudeMessage(
			sessionId,
			resultSuccess("All done.", {
				usage: usage({ inputTokens: 12345, outputTokens: 3100, costUsd: 0.42 }),
			}),
		);

		const responseCall = postSpy.mock.calls.find(
			(call) => call[1]?.type === "response",
		);
		expect(responseCall?.[1].body).toBe("All done.");
	});

	it("never appends a footer to error responses", async () => {
		const { manager, postSpy } = makeManager();
		await manager.handleClaudeMessage(
			sessionId,
			systemInitMessage({ sessionId: "cs-1" }),
		);
		await manager.handleClaudeMessage(
			sessionId,
			resultError(["Something broke"], {
				usage: usage({ inputTokens: 500, outputTokens: 50, costUsd: 0.05 }),
			}),
		);

		const errorCall = postSpy.mock.calls.find(
			(call) => call[1]?.type === "error",
		);
		expect(errorCall?.[1].body).toBe("Something broke");
		expect(errorCall?.[1].body).not.toContain("$");
	});
});
