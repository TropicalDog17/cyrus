import { readFileSync } from "node:fs";

/**
 * Parsing utilities for Claude Code session transcripts (`~/.claude/projects/<slug>/<sessionId>.jsonl`).
 *
 * Each line of a transcript file is a standalone JSON record emitted by the
 * Claude Code CLI. This module turns those raw records into a normalized,
 * compact list of conversational turns that downstream consumers (e.g. the
 * cold-resume summarizer) can render without re-implementing the CLI's
 * on-disk schema.
 *
 * The parsing here is intentionally defensive: transcript files can contain
 * partial lines, tool-result plumbing, meta/system entries, and schema drift
 * between Claude Code versions. Malformed lines are skipped rather than
 * throwing so a single bad record never breaks summarization.
 */

/** A single raw JSON record from a transcript `.jsonl` file. */
export interface TranscriptRecord {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
	[key: string]: unknown;
}

/** A normalized conversational turn extracted from the transcript. */
export interface ParsedTurn {
	role: "user" | "assistant";
	/** Concatenated text blocks for this turn (may be empty for tool-only turns). */
	text: string;
	/** Names of tools invoked in this turn, in order (assistant turns only). */
	toolNames: string[];
}

/**
 * Read and JSON-parse every line of a transcript file.
 *
 * Blank lines and lines that fail to parse are silently skipped — transcripts
 * are appended to line-by-line and can be truncated mid-write.
 */
export function readRecords(transcriptPath: string): TranscriptRecord[] {
	const raw = readFileSync(transcriptPath, "utf-8");
	const records: TranscriptRecord[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed) as TranscriptRecord);
		} catch {
			// Skip malformed / partial lines.
		}
	}
	return records;
}

/**
 * Extract the plain-text portion of a message `content` field.
 *
 * Content may be a bare string (older transcripts) or an array of typed
 * blocks (`text`, `tool_use`, `tool_result`, `thinking`, ...). Only human /
 * model text is returned here; tool metadata is surfaced separately via
 * {@link collectToolNames}.
 */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object") {
			const b = block as { type?: string; text?: unknown };
			if (b.type === "text" && typeof b.text === "string") {
				parts.push(b.text);
			}
		}
	}
	return parts.join("\n").trim();
}

/** Collect the ordered list of tool names invoked in a message's content. */
function collectToolNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const names: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object") {
			const b = block as { type?: string; name?: unknown };
			if (b.type === "tool_use" && typeof b.name === "string") {
				names.push(b.name);
			}
		}
	}
	return names;
}

/**
 * Normalize raw transcript records into an ordered list of user/assistant
 * turns. Records that are not user/assistant messages (system, summary, meta,
 * tool-result-only user turns) are dropped, as are turns that carry neither
 * text nor a tool call.
 */
export function parseTranscript(records: TranscriptRecord[]): ParsedTurn[] {
	const turns: ParsedTurn[] = [];
	for (const record of records) {
		const role = record.message?.role ?? record.type;
		if (role !== "user" && role !== "assistant") continue;

		const content = record.message?.content;
		const text = extractText(content);
		const toolNames = role === "assistant" ? collectToolNames(content) : [];

		if (!text && toolNames.length === 0) continue;

		turns.push({ role, text, toolNames });
	}
	return turns;
}
