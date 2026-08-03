import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";
import { resultSuccess, systemInitMessage } from "./agent-message-builders";

/**
 * Persistence v6 replaced the provider-specific session id fields
 * (`claudeSessionId` / `cursorSessionId` / `codexSessionId`) with the generic
 * pair `agentProfileId` + `runnerSessionId`. A neutral system/init message must
 * record its runner session id generically, and the profile identity is derived
 * from the runner at attach time (never branched per provider).
 */
describe("AgentSessionManager - generic runner session identity", () => {
	let manager: AgentSessionManager;
	const sessionId = "session-provider";
	const issueId = "issue-provider";

	function setup(provider: "claude" | "cursor") {
		const mockActivitySink: IActivitySink = {
			id: "test-workspace",
			post: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("ext-session-1"),
		};
		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "PROV-1",
				title: "Provider routing",
				description: "",
				branchName: "test-branch",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, mockActivitySink);
		const runnerStub = {
			getFormatter: () => ({}),
			provider,
		} as unknown as Parameters<typeof manager.addAgentRunner>[1];
		manager.addAgentRunner(sessionId, runnerStub);
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("records the runner session id generically for a claude runner", async () => {
		setup("claude");
		await manager.handleClaudeMessage(
			sessionId,
			systemInitMessage({ sessionId: "runner-abc" }),
		);
		const session = manager.getSession(sessionId);
		expect(session?.runnerSessionId).toBe("runner-abc");
		expect(session?.agentProfileId).toBe("claude");
	});

	it("records the runner session id generically for a cursor runner", async () => {
		setup("cursor");
		await manager.handleClaudeMessage(
			sessionId,
			systemInitMessage({ sessionId: "runner-xyz" }),
		);
		const session = manager.getSession(sessionId);
		expect(session?.runnerSessionId).toBe("runner-xyz");
		expect(session?.agentProfileId).toBe("cursor");
	});

	it("keeps an explicit agentProfileId over the runner-derived one", async () => {
		setup("cursor");
		const session = manager.getSession(sessionId);
		session!.agentProfileId = "codex";
		await manager.handleClaudeMessage(
			sessionId,
			systemInitMessage({ sessionId: "runner-xyz" }),
		);
		expect(manager.getSession(sessionId)?.agentProfileId).toBe("codex");
		expect(manager.getSession(sessionId)?.runnerSessionId).toBe("runner-xyz");
	});

	it("records the generic pair on result entries", async () => {
		setup("claude");
		await manager.handleClaudeMessage(
			sessionId,
			resultSuccess("done", { sessionId: "runner-abc" }),
		);
		const entries = manager.getSessionEntries(sessionId);
		expect(entries[0]).toMatchObject({
			agentProfileId: "claude",
			runnerSessionId: "runner-abc",
			type: "result",
		});
		expect(
			(entries[0] as Record<string, unknown>).claudeSessionId,
		).toBeUndefined();
	});
});
