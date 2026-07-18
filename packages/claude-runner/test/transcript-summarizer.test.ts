import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
	type ParsedTurn,
	renderCompactTurnLog,
	summarizeTranscript,
} from "../src/index.js";

const mockQuery = vi.mocked(query);

/** Build an async iterable that yields the provided messages. */
async function* messages(items: any[]) {
	for (const item of items) yield item;
}

function resultMessage(text: string) {
	return { type: "result", subtype: "success", result: text };
}

describe("renderCompactTurnLog", () => {
	test("returns the full log when under the char budget", () => {
		const turns: ParsedTurn[] = [
			{ role: "user", text: "hello", toolNames: [] },
			{ role: "assistant", text: "hi", toolNames: ["Bash"] },
		];
		const out = renderCompactTurnLog(turns, 10_000);
		expect(out).toBe("User: hello\n\nAssistant: hi\nAssistant tools: Bash");
	});

	test("keeps first turn as head anchor and takes the tail when over budget", () => {
		const turns: ParsedTurn[] = [
			{ role: "user", text: "FIRST ORIGINAL ASK", toolNames: [] },
		];
		// Add many bulky middle turns plus a distinctive last turn.
		for (let i = 0; i < 50; i++) {
			turns.push({ role: "assistant", text: "x".repeat(500), toolNames: [] });
		}
		turns.push({ role: "assistant", text: "LAST TURN MARKER", toolNames: [] });

		const out = renderCompactTurnLog(turns, 2000);

		expect(out.startsWith("User: FIRST ORIGINAL ASK")).toBe(true);
		expect(out).toContain("[…earlier turns omitted…]");
		expect(out).toContain("LAST TURN MARKER");
		expect(out.length).toBeLessThanOrEqual(2000);
	});
});

describe("summarizeTranscript", () => {
	let dir: string;
	let transcriptPath: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		dir = await mkdtemp(join(tmpdir(), "cyrus-summarizer-"));
		transcriptPath = join(dir, "session.jsonl");
		await writeFile(
			transcriptPath,
			[
				JSON.stringify({
					type: "user",
					message: { role: "user", content: "Add a feature" },
				}),
				JSON.stringify({
					type: "assistant",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "Done" },
							{ type: "tool_use", name: "Edit", input: {} },
						],
					},
				}),
			].join("\n"),
		);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("calls query with the one-shot Haiku summarizer options and returns the summary", async () => {
		mockQuery.mockReturnValue(
			messages([resultMessage("A concise summary")]) as any,
		);

		const summary = await summarizeTranscript({ transcriptPath });
		expect(summary).toBe("A concise summary");

		expect(mockQuery).toHaveBeenCalledTimes(1);
		const opts = (mockQuery.mock.calls[0]![0] as any).options;
		expect(opts.model).toBe("haiku");
		expect(opts.maxTurns).toBe(1);
		expect(opts.effort).toBe("low");
		expect(opts.maxBudgetUsd).toBe(0.5);
		expect(opts.tools).toEqual([]);
		expect(opts.strictMcpConfig).toBe(true);
		// Custom string systemPrompt — NOT the claude_code preset object.
		expect(typeof opts.systemPrompt).toBe("string");
	});

	test("falls back to assistant text when no result payload is emitted", async () => {
		mockQuery.mockReturnValue(
			messages([
				{
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Assistant summary" }],
					},
				},
			]) as any,
		);

		const summary = await summarizeTranscript({ transcriptPath });
		expect(summary).toBe("Assistant summary");
	});

	test("throws when the query returns an empty summary", async () => {
		mockQuery.mockReturnValue(messages([resultMessage("   ")]) as any);
		await expect(summarizeTranscript({ transcriptPath })).rejects.toThrow(
			/empty summary/,
		);
	});

	test("throws a timeout error when the query is aborted by the timeout", async () => {
		mockQuery.mockImplementation((args: any) => {
			const signal: AbortSignal = args.options.abortController.signal;
			async function* hang() {
				await new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () =>
						reject(new Error("The operation was aborted")),
					);
				});
				yield resultMessage("never");
			}
			return hang() as any;
		});

		await expect(
			summarizeTranscript({ transcriptPath, timeoutMs: 20 }),
		).rejects.toThrow(/timed out/);
	});

	test("throws when the transcript has no summarizable turns", async () => {
		const emptyPath = join(dir, "empty.jsonl");
		await writeFile(emptyPath, "\n\n");
		await expect(
			summarizeTranscript({ transcriptPath: emptyPath }),
		).rejects.toThrow(/empty turn log/);
	});
});
