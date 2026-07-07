import { AgentSessionStatus } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";
import { resultSuccess } from "./agent-message-builders";

describe("AgentSessionManager failSession (runner-crash surfacing)", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: any;
	const sessionId = "test-session-fail";
	const issueId = "issue-fail";

	const seedSession = () => {
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-FAIL",
				title: "Fail Session Test",
				description: "test",
				branchName: "test-fail",
			},
			{
				path: "/tmp/workspace",
				isGitWorktree: false,
			},
		);
		manager.setActivitySink(sessionId, mockActivitySink);
	};

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("session-1"),
		};
		postActivitySpy = vi.spyOn(mockActivitySink, "postActivity");
		manager = new AgentSessionManager();
	});

	it("posts an error activity and transitions the session to Error", async () => {
		seedSession();

		await manager.failSession(sessionId, "boom: subprocess exited with code 1");

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Error,
		);

		const errorActivity = postActivitySpy.mock.calls.find(
			(call: any[]) => call[1]?.type === "error",
		);
		expect(errorActivity).toBeDefined();
		expect(errorActivity![1].body).toContain(
			"boom: subprocess exited with code 1",
		);
	});

	it("is a no-op for an unknown session (does not throw, posts nothing)", async () => {
		await expect(
			manager.failSession("nonexistent-session", "boom"),
		).resolves.toBeUndefined();
		expect(postActivitySpy).not.toHaveBeenCalled();
	});

	it("does not clobber a session that already completed successfully", async () => {
		seedSession();
		await manager.completeSession(
			sessionId,
			resultSuccess("done", { sessionId: "sdk-session" }),
		);
		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Complete,
		);

		postActivitySpy.mockClear();
		await manager.failSession(sessionId, "late crash after success");

		// Terminal status preserved, no additional error activity posted.
		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Complete,
		);
		expect(postActivitySpy).not.toHaveBeenCalled();
	});

	it("does not post twice when called repeatedly (idempotent once errored)", async () => {
		seedSession();

		await manager.failSession(sessionId, "first crash");
		const callsAfterFirst = postActivitySpy.mock.calls.filter(
			(call: any[]) => call[1]?.type === "error",
		).length;
		expect(callsAfterFirst).toBe(1);

		await manager.failSession(sessionId, "second crash");
		const callsAfterSecond = postActivitySpy.mock.calls.filter(
			(call: any[]) => call[1]?.type === "error",
		).length;
		expect(callsAfterSecond).toBe(1);
		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Error,
		);
	});
});
