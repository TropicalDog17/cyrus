import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";
import { systemInitMessage } from "./agent-message-builders";

/**
 * Phase B replaced the deleted `constructor.name === "CursorRunner"` sniff with
 * `IAgentRunner.provider` dispatch. A neutral system/init message must record
 * its session id against the field matching the runner's provider.
 */
describe("AgentSessionManager - provider-based session id routing", () => {
	let manager: AgentSessionManager;
	const sessionId = "session-provider";
	const issueId = "issue-provider";

	function setup(provider: "claude" | "cursor" | "codex" | "pi") {
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

	it("records the session id on claudeSessionId for a claude runner", async () => {
		setup("claude");
		await manager.handleClaudeMessage(
			sessionId,
			systemInitMessage({ sessionId: "runner-abc" }),
		);
		const session = manager.getSession(sessionId);
		expect(session?.claudeSessionId).toBe("runner-abc");
		expect(session?.cursorSessionId).toBeUndefined();
	});

	it("records the session id on cursorSessionId for a cursor runner", async () => {
		setup("cursor");
		await manager.handleClaudeMessage(
			sessionId,
			systemInitMessage({ sessionId: "runner-xyz" }),
		);
		const session = manager.getSession(sessionId);
		expect(session?.cursorSessionId).toBe("runner-xyz");
		expect(session?.claudeSessionId).toBeUndefined();
	});

	it("records the session id on codexSessionId for a codex runner", async () => {
		setup("codex");
		await manager.handleClaudeMessage(
			sessionId,
			systemInitMessage({ sessionId: "runner-codex" }),
		);
		expect(manager.getSession(sessionId)?.codexSessionId).toBe("runner-codex");
	});

	it("records the session id on piSessionId for a Pi runner", async () => {
		setup("pi");
		await manager.handleClaudeMessage(
			sessionId,
			systemInitMessage({ sessionId: "runner-pi" }),
		);
		expect(manager.getSession(sessionId)?.piSessionId).toBe("runner-pi");
	});
});
