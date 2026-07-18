import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	parseTranscript,
	readRecords,
	type TranscriptRecord,
} from "../src/transcript-parser.js";

describe("readRecords", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "cyrus-parser-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("parses one JSON record per non-empty line and skips malformed lines", async () => {
		const path = join(dir, "t.jsonl");
		await writeFile(
			path,
			[
				JSON.stringify({ type: "user", message: { role: "user" } }),
				"",
				"   ",
				"{ not valid json",
				JSON.stringify({ type: "assistant", message: { role: "assistant" } }),
			].join("\n"),
		);

		const records = readRecords(path);
		expect(records).toHaveLength(2);
		expect(records[0]?.type).toBe("user");
		expect(records[1]?.type).toBe("assistant");
	});
});

describe("parseTranscript", () => {
	test("extracts user/assistant text and assistant tool names in order", () => {
		const records: TranscriptRecord[] = [
			{
				type: "user",
				message: { role: "user", content: "Implement the feature" },
			},
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Working on it" },
						{ type: "tool_use", name: "Edit", input: {} },
						{ type: "tool_use", name: "Bash", input: {} },
					],
				},
			},
		];

		const turns = parseTranscript(records);
		expect(turns).toEqual([
			{ role: "user", text: "Implement the feature", toolNames: [] },
			{ role: "assistant", text: "Working on it", toolNames: ["Edit", "Bash"] },
		]);
	});

	test("drops non-conversational records and empty turns", () => {
		const records: TranscriptRecord[] = [
			{ type: "system", message: { role: "system", content: "boot" } },
			{ type: "summary", subject: "x" },
			// tool-result-only user turn (array content with no text) → dropped
			{
				type: "user",
				message: {
					role: "user",
					content: [{ type: "tool_result", content: "ok" }],
				},
			},
			{ type: "assistant", message: { role: "assistant", content: [] } },
			{ type: "user", message: { role: "user", content: "real question" } },
		];

		const turns = parseTranscript(records);
		expect(turns).toEqual([
			{ role: "user", text: "real question", toolNames: [] },
		]);
	});
});
