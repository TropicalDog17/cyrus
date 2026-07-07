import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";
import {
	assistantText,
	statusMessage,
	systemInitMessage,
} from "./agent-message-builders";

/**
 * Tests that GitHub (non-Linear) sessions skip all Linear activity posting.
 *
 * When `platform: "github"` is passed to createCyrusAgentSession, the session
 * has no externalSessionId, so all postActivity calls should be skipped.
 */
describe("AgentSessionManager - GitHub Session", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: ReturnType<typeof vi.fn>;
	const sessionId = "github-session-123";
	const issueId = "issue-456";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			post: vi.fn().mockResolvedValue({ activityId: "activity-123" }),
			createAgentSession: vi.fn().mockResolvedValue("session-123"),
		};

		postActivitySpy = mockActivitySink.post as ReturnType<typeof vi.fn>;

		manager = new AgentSessionManager();
	});

	function createGitHubSession() {
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "GH-42",
				title: "GitHub Issue",
				description: "A GitHub issue",
				branchName: "fix/gh-42",
			},
			{ path: "/test/workspace", isGitWorktree: false },
			"github",
		);
		manager.setActivitySink(sessionId, mockActivitySink);
	}

	function createLinearSession() {
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "LIN-99",
				title: "Linear Issue",
				description: "A Linear issue",
				branchName: "fix/lin-99",
			},
			{ path: "/test/workspace", isGitWorktree: false },
			"linear",
		);
		manager.setActivitySink(sessionId, mockActivitySink);
	}

	// ── GitHub session tests ──────────────────────────────────────────────

	it("should skip postActivity for assistant messages in GitHub sessions", async () => {
		createGitHubSession();

		const assistantMessage = assistantText("Here is my response.", {
			sessionId: "claude-session-1",
		});

		await manager.handleClaudeMessage(sessionId, assistantMessage);

		expect(postActivitySpy).not.toHaveBeenCalled();
	});

	it("should skip model notification for GitHub sessions", async () => {
		createGitHubSession();

		const systemMessage = systemInitMessage({
			sessionId: "claude-session-1",
			model: "claude-sonnet-4-5-20250514",
			tools: ["bash", "grep", "edit"],
			permissionMode: "default",
			apiKeySource: "user",
		});

		await manager.handleClaudeMessage(sessionId, systemMessage);

		const modelNotificationCall = postActivitySpy.mock.calls.find(
			(call: any) =>
				call[1]?.type === "thought" && call[1]?.body?.includes("Using model:"),
		);

		expect(modelNotificationCall).toBeFalsy();
	});

	it("should skip status messages for GitHub sessions", async () => {
		createGitHubSession();

		const statusMsg = statusMessage("compacting", "claude-session-1");

		await manager.handleClaudeMessage(sessionId, statusMsg);

		expect(postActivitySpy).not.toHaveBeenCalled();
	});

	// ── Linear session regression tests ───────────────────────────────────

	it("should still sync assistant messages for Linear sessions", async () => {
		createLinearSession();

		const assistantMessage = assistantText("Here is my response.", {
			sessionId: "claude-session-1",
		});

		await manager.handleClaudeMessage(sessionId, assistantMessage);

		// Assistant text is held in the one-behind buffer until the next message
		// flushes it. Send a second assistant message to flush the first.
		const secondMessage = assistantText("Here is my response.", {
			sessionId: "claude-session-1",
		});
		await manager.handleClaudeMessage(sessionId, secondMessage);

		expect(postActivitySpy).toHaveBeenCalled();
	});

	it("should still post model notifications for Linear sessions", async () => {
		createLinearSession();

		const systemMessage = systemInitMessage({
			sessionId: "claude-session-1",
			model: "claude-sonnet-4-5-20250514",
			tools: ["bash", "grep", "edit"],
			permissionMode: "default",
			apiKeySource: "user",
		});

		await manager.handleClaudeMessage(sessionId, systemMessage);

		const modelNotificationCall = postActivitySpy.mock.calls.find(
			(call: any) =>
				call[1]?.type === "thought" && call[1]?.body?.includes("Using model:"),
		);

		expect(modelNotificationCall).toBeTruthy();
		expect(modelNotificationCall![0]).toBe(sessionId);
		expect(modelNotificationCall![1]).toEqual({
			type: "thought",
			body: "Using model: claude-sonnet-4-5-20250514",
		});
	});
});
