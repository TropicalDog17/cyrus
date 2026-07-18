import type { AgentAssistantMessage } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";
import {
	assistantText,
	assistantToolUse,
	systemInitMessage,
} from "./agent-message-builders";

/**
 * Regression test for CYPACK-1112 / CYPACK-978 follow-up:
 * When Claude emits an assistant turn whose only text block is empty (or
 * whitespace), we previously buffered it and later posted it to Linear as a
 * blank `thought` activity. That blank thought rendered as an extra empty
 * line between the "Using model: ..." notification and the first real tool
 * activity — visible as gratuitous whitespace in CYPACK-978's activity log.
 *
 * The fix skips empty/whitespace-only text turns at buffer time (and
 * defensively inside flushBufferedAssistant).
 */
describe("AgentSessionManager - empty assistant thought suppression", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: ReturnType<typeof vi.fn>;
	const sessionId = "test-session-empty-thought";
	const issueId = "issue-empty-thought";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			post: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("ext-session-1"),
		};
		postActivitySpy = mockActivitySink.post as ReturnType<typeof vi.fn>;

		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "CYPACK-978",
				title: "Empty thought regression",
				description: "",
				branchName: "test-branch",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, mockActivitySink);

		// Register a minimal IAgentRunner stub — the mapper renders tool
		// activities; the runner only supplies its provider tag.
		const runnerStub = {
			provider: "claude",
		} as unknown as Parameters<typeof manager.addAgentRunner>[1];
		manager.addAgentRunner(sessionId, runnerStub);
	});

	function buildEmptyTextAssistantMessage(
		_uuid: string,
	): AgentAssistantMessage {
		return assistantText("");
	}

	function buildWhitespaceTextAssistantMessage(
		_uuid: string,
	): AgentAssistantMessage {
		return assistantText("\n \n\t");
	}

	function buildToolUseAssistantMessage(
		_uuid: string,
		toolUseId: string,
	): AgentAssistantMessage {
		return assistantToolUse(toolUseId, "Bash", {
			command: "ls",
			description: "List files",
		});
	}

	it("does not post a blank thought when an assistant message has empty text", async () => {
		// Simulate the real sequence seen in CYPACK-978:
		//   system init (posts "Using model: ...")
		//   assistant [text=""]   <-- should NOT produce a blank thought
		//   assistant [tool_use Bash]
		await manager.handleClaudeMessage(sessionId, systemInitMessage());
		await manager.handleClaudeMessage(
			sessionId,
			buildEmptyTextAssistantMessage("uuid-empty"),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildToolUseAssistantMessage("uuid-tool", "toolu_1"),
		);

		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);

		// "Using model: ..." should be posted.
		expect(
			postedContents.some(
				(c: any) =>
					c?.type === "thought" &&
					typeof c.body === "string" &&
					c.body.startsWith("Using model:"),
			),
		).toBe(true);

		// Tool-use action should be posted.
		expect(
			postedContents.some(
				(c: any) => c?.type === "action" && c.action === "Bash",
			),
		).toBe(true);

		// No blank thought should ever be posted.
		const blankThoughts = postedContents.filter(
			(c: any) =>
				c?.type === "thought" &&
				(c.body === undefined ||
					c.body === null ||
					(typeof c.body === "string" && c.body.trim() === "")),
		);
		expect(blankThoughts).toEqual([]);
	});

	it("does not post a blank thought for whitespace-only text", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			buildWhitespaceTextAssistantMessage("uuid-ws"),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildToolUseAssistantMessage("uuid-tool", "toolu_2"),
		);

		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);

		const blankThoughts = postedContents.filter(
			(c: any) =>
				c?.type === "thought" &&
				(c.body === undefined ||
					c.body === null ||
					(typeof c.body === "string" && c.body.trim() === "")),
		);
		expect(blankThoughts).toEqual([]);
	});
});
