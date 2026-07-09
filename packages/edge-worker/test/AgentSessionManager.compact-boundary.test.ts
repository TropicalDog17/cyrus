import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";
import {
	compactBoundaryMessage,
	statusMessage,
} from "./agent-message-builders";

describe("AgentSessionManager - Compact Boundary", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: any;
	const sessionId = "test-session-123";
	const issueId = "issue-123";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			post: vi.fn().mockResolvedValue({ activityId: "activity-123" }),
			createAgentSession: vi.fn().mockResolvedValue("session-123"),
		};
		postActivitySpy = vi.spyOn(mockActivitySink, "post");

		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-123",
				title: "Test Issue",
				description: "Test description",
				branchName: "test-branch",
			},
			{ path: "/test/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, mockActivitySink);
	});

	it("reports how much conversation the compaction traded away", async () => {
		await manager.handleClaudeMessage(sessionId, compactBoundaryMessage());

		expect(postActivitySpy).toHaveBeenCalledWith(sessionId, {
			type: "thought",
			body: "Compacted conversation: 210k → 45k tokens (auto)",
			ephemeral: false,
		});
	});

	it("names the trigger and omits the arrow when no post-token count is reported", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			compactBoundaryMessage({
				trigger: "manual",
				preTokens: 406100,
				postTokens: undefined,
			}),
		);

		expect(postActivitySpy).toHaveBeenCalledWith(sessionId, {
			type: "thought",
			body: "Compacted conversation (manual, was 406k tokens)",
			ephemeral: false,
		});
	});

	it("renders sub-1k counts verbatim rather than rounding to 0k", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			compactBoundaryMessage({ preTokens: 1500, postTokens: 840 }),
		);

		expect(postActivitySpy).toHaveBeenCalledWith(sessionId, {
			type: "thought",
			body: "Compacted conversation: 2k → 840 tokens (auto)",
			ephemeral: false,
		});
	});

	it("suppresses the vaguer status-clear thought that follows a boundary", async () => {
		await manager.handleClaudeMessage(sessionId, statusMessage("compacting"));
		await manager.handleClaudeMessage(sessionId, compactBoundaryMessage());
		postActivitySpy.mockClear();

		await manager.handleClaudeMessage(sessionId, statusMessage(null));

		expect(postActivitySpy).not.toHaveBeenCalled();
	});

	it("still posts the generic thought when the boundary never arrives", async () => {
		await manager.handleClaudeMessage(sessionId, statusMessage("compacting"));
		postActivitySpy.mockClear();

		await manager.handleClaudeMessage(sessionId, statusMessage(null));

		expect(postActivitySpy).toHaveBeenCalledWith(sessionId, {
			type: "thought",
			body: "Conversation history compacted",
			ephemeral: false,
		});
	});

	it("does not let one compaction suppress the next cycle's status thought", async () => {
		await manager.handleClaudeMessage(sessionId, statusMessage("compacting"));
		await manager.handleClaudeMessage(sessionId, compactBoundaryMessage());
		await manager.handleClaudeMessage(sessionId, statusMessage(null));

		// Second compaction, this time with no boundary message.
		await manager.handleClaudeMessage(sessionId, statusMessage("compacting"));
		postActivitySpy.mockClear();
		await manager.handleClaudeMessage(sessionId, statusMessage(null));

		expect(postActivitySpy).toHaveBeenCalledWith(sessionId, {
			type: "thought",
			body: "Conversation history compacted",
			ephemeral: false,
		});
	});

	it("skips posting when the session has no external session id", async () => {
		const orphan = new AgentSessionManager();
		await expect(
			orphan.handleClaudeMessage("unknown-session", compactBoundaryMessage()),
		).resolves.not.toThrow();
	});
});
