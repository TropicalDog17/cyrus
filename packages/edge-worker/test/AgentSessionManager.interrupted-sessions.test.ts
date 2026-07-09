import { AgentSessionStatus } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * Serialized-session shape accepted by restoreState. We only populate the
 * fields the reconciliation logic reads (status, agentRunner is never
 * serialized) plus the minimum for the session to be well-formed.
 */
const serializedSession = (id: string, status: AgentSessionStatus) => ({
	id,
	issueId: `issue-${id}`,
	status,
	createdAt: 1,
	updatedAt: 1,
	issueContext: {
		issueId: `issue-${id}`,
		issueIdentifier: id.toUpperCase(),
	},
	metadata: {},
	repositories: [],
});

describe("AgentSessionManager.markInterruptedSessions", () => {
	let manager: AgentSessionManager;

	beforeEach(() => {
		manager = new AgentSessionManager();
	});

	it("transitions restored Active and AwaitingInput sessions (no runner) to Error", () => {
		manager.restoreState(
			{
				active1: serializedSession("active1", AgentSessionStatus.Active) as any,
				awaiting1: serializedSession(
					"awaiting1",
					AgentSessionStatus.AwaitingInput,
				) as any,
			},
			{},
		);

		const interrupted = manager.markInterruptedSessions();

		expect(interrupted.sort()).toEqual(["active1", "awaiting1"]);
		expect(manager.getSession("active1")?.status).toBe(
			AgentSessionStatus.Error,
		);
		expect(manager.getSession("awaiting1")?.status).toBe(
			AgentSessionStatus.Error,
		);
	});

	it("leaves already-terminal sessions untouched", () => {
		manager.restoreState(
			{
				done: serializedSession("done", AgentSessionStatus.Complete) as any,
				failed: serializedSession("failed", AgentSessionStatus.Error) as any,
			},
			{},
		);

		const interrupted = manager.markInterruptedSessions();

		expect(interrupted).toEqual([]);
		expect(manager.getSession("done")?.status).toBe(
			AgentSessionStatus.Complete,
		);
		expect(manager.getSession("failed")?.status).toBe(AgentSessionStatus.Error);
	});

	it("does not touch an Active session that has a live runner", () => {
		manager.restoreState(
			{ live: serializedSession("live", AgentSessionStatus.Active) as any },
			{},
		);
		// Simulate a runner having been (re)attached after restore.
		const fakeRunner = { isStreaming: () => true } as any;
		manager.addAgentRunner("live", fakeRunner);

		const interrupted = manager.markInterruptedSessions();

		expect(interrupted).toEqual([]);
		expect(manager.getSession("live")?.status).toBe(AgentSessionStatus.Active);
	});

	it("is a no-op when there are no sessions", () => {
		expect(manager.markInterruptedSessions()).toEqual([]);
	});

	it("reconciled sessions no longer count as active", () => {
		const sink: IActivitySink = {
			id: "ws",
			post: vi.fn().mockResolvedValue({ activityId: "a1" }),
			createAgentSession: vi.fn().mockResolvedValue("s1"),
		};
		manager.restoreState(
			{ a: serializedSession("a", AgentSessionStatus.Active) as any },
			{},
		);
		manager.setActivitySink("a", sink);
		expect(manager.getActiveSessions()).toHaveLength(1);

		manager.markInterruptedSessions();

		expect(manager.getActiveSessions()).toHaveLength(0);
	});
});
