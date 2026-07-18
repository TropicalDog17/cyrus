/**
 * Cold-resume summarize-and-restart decision logic.
 *
 * Exercises the trigger helpers wired into `EdgeWorker.resumeAgentSession`:
 * - `resolveColdResumeThreshold` (unset = disabled; below-min = warn + ignore)
 * - `maybeSummarizeColdResume` (above threshold summarizes; below/unset/failure
 *   fall through to a normal resume by returning undefined)
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cyrus-claude-runner", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		findTranscriptPath: vi.fn(),
		summarizeTranscript: vi.fn(),
	};
});

import { findTranscriptPath, summarizeTranscript } from "cyrus-claude-runner";
import { createLogger, LogLevel } from "cyrus-core";
import { EdgeWorker } from "../src/EdgeWorker.js";

const mockFindTranscriptPath = vi.mocked(findTranscriptPath);
const mockSummarizeTranscript = vi.mocked(summarizeTranscript);

const CLAUDE_SESSION_ID = "claude-session-123";
const WORKSPACE_ID = "workspace-1";

// The cold-resume helpers are private methods that only touch `this.config`,
// `this.logger`, `this.postThought`, and each other — never the full
// collaborator graph. So rather than stand up a real EdgeWorker (which needs
// heavy FS/collaborator mocking that would clobber the `stat`-based estimate
// test), we invoke the prototype methods against a minimal hand-built `this`.
const proto = EdgeWorker.prototype as any;

function createTestWorker() {
	const logger = createLogger({
		component: "cold-resume-test",
		level: LogLevel.SILENT,
	});
	return {
		config: {} as Record<string, unknown>,
		logger,
		postThought: vi.fn().mockResolvedValue(undefined),
		resolveColdResumeThreshold: proto.resolveColdResumeThreshold,
		estimateResumeContextTokens: proto.estimateResumeContextTokens,
		maybeSummarizeColdResume: proto.maybeSummarizeColdResume,
	};
}

function makeSession(usage?: Record<string, number>) {
	return {
		id: "session-1",
		claudeSessionId: CLAUDE_SESSION_ID,
		repositories: [{ branchName: "feature/x" }],
		workspace: { path: "/test/repo" },
		metadata: usage ? { usage } : {},
	} as any;
}

function setThreshold(worker: any, value: number | undefined) {
	worker.config.claudeColdResumeSummarizeThresholdTokens = value;
}

describe("EdgeWorker cold-resume summarize", () => {
	let worker: any;

	beforeEach(() => {
		vi.clearAllMocks();
		worker = createTestWorker();
	});

	describe("resolveColdResumeThreshold", () => {
		it("returns undefined when unset (disabled)", () => {
			setThreshold(worker, undefined);
			expect(worker.resolveColdResumeThreshold()).toBeUndefined();
		});

		it("warns and ignores values below the 20k minimum", () => {
			setThreshold(worker, 5000);
			const warn = vi.spyOn(worker.logger, "warn").mockImplementation(() => {});
			expect(worker.resolveColdResumeThreshold()).toBeUndefined();
			expect(warn).toHaveBeenCalled();
		});

		it("returns the configured value when at/above the minimum", () => {
			setThreshold(worker, 60000);
			expect(worker.resolveColdResumeThreshold()).toBe(60000);
		});
	});

	describe("maybeSummarizeColdResume", () => {
		it("summarizes and posts a thought when usage exceeds the threshold", async () => {
			setThreshold(worker, 60000);
			mockFindTranscriptPath.mockResolvedValue("/tmp/transcript.jsonl");
			mockSummarizeTranscript.mockResolvedValue("A summary");
			const postThought = vi
				.spyOn(worker, "postThought")
				.mockResolvedValue(undefined);

			const session = makeSession({
				input_tokens: 50000,
				cache_read_input_tokens: 40000,
				cache_creation_input_tokens: 10000,
			});

			const summary = await worker.maybeSummarizeColdResume(
				session,
				"linear-session-1",
				CLAUDE_SESSION_ID,
				WORKSPACE_ID,
			);

			expect(summary).toBe("A summary");
			expect(mockSummarizeTranscript).toHaveBeenCalledTimes(1);
			expect(postThought).toHaveBeenCalledTimes(1);
			// Invariant: never clear the Claude session ID on success.
			expect(session.claudeSessionId).toBe(CLAUDE_SESSION_ID);
		});

		it("returns undefined without summarizing when disabled (unset)", async () => {
			setThreshold(worker, undefined);
			const session = makeSession({ input_tokens: 1_000_000 });

			const summary = await worker.maybeSummarizeColdResume(
				session,
				"linear-session-1",
				CLAUDE_SESSION_ID,
				WORKSPACE_ID,
			);

			expect(summary).toBeUndefined();
			expect(mockFindTranscriptPath).not.toHaveBeenCalled();
			expect(mockSummarizeTranscript).not.toHaveBeenCalled();
		});

		it("returns undefined when the estimate is at/below the threshold", async () => {
			setThreshold(worker, 60000);
			mockFindTranscriptPath.mockResolvedValue("/tmp/transcript.jsonl");
			const session = makeSession({ input_tokens: 10000 });

			const summary = await worker.maybeSummarizeColdResume(
				session,
				"linear-session-1",
				CLAUDE_SESSION_ID,
				WORKSPACE_ID,
			);

			expect(summary).toBeUndefined();
			expect(mockSummarizeTranscript).not.toHaveBeenCalled();
		});

		it("returns undefined when no transcript is found", async () => {
			setThreshold(worker, 60000);
			mockFindTranscriptPath.mockResolvedValue(null);
			const session = makeSession({ input_tokens: 1_000_000 });

			const summary = await worker.maybeSummarizeColdResume(
				session,
				"linear-session-1",
				CLAUDE_SESSION_ID,
				WORKSPACE_ID,
			);

			expect(summary).toBeUndefined();
			expect(mockSummarizeTranscript).not.toHaveBeenCalled();
		});

		it("falls through (returns undefined) when summarization throws", async () => {
			setThreshold(worker, 60000);
			mockFindTranscriptPath.mockResolvedValue("/tmp/transcript.jsonl");
			mockSummarizeTranscript.mockRejectedValue(new Error("haiku boom"));
			vi.spyOn(worker, "postThought").mockResolvedValue(undefined);
			const session = makeSession({ input_tokens: 1_000_000 });

			const summary = await worker.maybeSummarizeColdResume(
				session,
				"linear-session-1",
				CLAUDE_SESSION_ID,
				WORKSPACE_ID,
			);

			expect(summary).toBeUndefined();
		});
	});

	describe("estimateResumeContextTokens", () => {
		let dir: string;

		beforeEach(async () => {
			dir = await mkdtemp(join(tmpdir(), "cyrus-estimate-"));
		});

		afterEach(async () => {
			await rm(dir, { recursive: true, force: true });
		});

		it("falls back to transcript file size / 4 when no usage is present", async () => {
			const path = join(dir, "t.jsonl");
			await writeFile(path, "x".repeat(4000));
			const session = makeSession();

			const estimate = await worker.estimateResumeContextTokens(session, path);
			expect(estimate).toBe(1000);
		});
	});
});
