import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger, type ILogger } from "cyrus-core";
import {
	type ParsedTurn,
	parseTranscript,
	readRecords,
} from "./transcript-parser.js";

/**
 * One-shot summarization of a Claude Code session transcript, used by the
 * cold-resume-summarize-and-restart flow: instead of resuming a giant
 * transcript (which rewrites the entire thing to the prompt cache), we
 * summarize it with a cheap Haiku call and seed a fresh session with the
 * summary.
 */

export interface SummarizeTranscriptOptions {
	/** Absolute path to the transcript `.jsonl` file. */
	transcriptPath: string;
	/** Model to summarize with. Defaults to `"haiku"`. */
	model?: string;
	/** Abort timeout for the summarization query, in ms. Defaults to 90s. */
	timeoutMs?: number;
	/**
	 * Maximum number of characters of rendered turn log to feed the model.
	 * The tail is kept (most recent turns) with the first user turn preserved
	 * as a head anchor. Defaults to ~150k chars.
	 */
	maxInputChars?: number;
	/** Logger for diagnostics. Defaults to a module logger. */
	logger?: ILogger;
}

/** Per-turn text budget when rendering the compact turn log. */
const MAX_TURN_TEXT_CHARS = 2000;
const DEFAULT_MAX_INPUT_CHARS = 150_000;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MODEL = "haiku";

const SYSTEM_PROMPT = `You are summarizing a software-engineering agent's work session so a fresh agent can pick up where it left off without re-reading the whole transcript.

Produce a concise handoff summary in markdown (no more than ~800 words) covering:
- What the user asked for.
- What was done, in order (key steps and reasoning).
- Which files were created, modified, or deleted.
- Branch, pull request, and commit state (names/numbers if known).
- Decisions made and any constraints or trade-offs agreed on.
- What is still unfinished, and the concrete next steps to complete it.

Be factual and specific. Do not invent details that are not present in the transcript. Prefer bullet points over prose.`;

/**
 * Render a single normalized turn into a compact log line, truncating long
 * text and appending the tool names invoked.
 */
function renderTurn(turn: ParsedTurn): string {
	const role = turn.role === "user" ? "User" : "Assistant";
	let text = turn.text;
	if (text.length > MAX_TURN_TEXT_CHARS) {
		text = `${text.slice(0, MAX_TURN_TEXT_CHARS)}… [truncated]`;
	}
	const lines: string[] = [];
	if (text) {
		lines.push(`${role}: ${text}`);
	}
	if (turn.toolNames.length > 0) {
		lines.push(`${role} tools: ${turn.toolNames.join(", ")}`);
	}
	return lines.join("\n");
}

/**
 * Build the compact turn-log string fed to the summarizer.
 *
 * Keeps the tail (most recent turns) up to `maxInputChars`, always preserving
 * the very first user turn as a head anchor so the summary knows the original
 * ask even when the middle of a long session is dropped.
 */
export function renderCompactTurnLog(
	turns: ParsedTurn[],
	maxInputChars: number = DEFAULT_MAX_INPUT_CHARS,
): string {
	if (turns.length === 0) return "";

	const rendered = turns.map(renderTurn).filter(Boolean);
	const full = rendered.join("\n\n");
	if (full.length <= maxInputChars) {
		return full;
	}

	// Preserve the first turn as a head anchor, then take as much of the tail
	// as fits in the remaining budget.
	const head = rendered[0]!;
	const separator = "\n\n[…earlier turns omitted…]\n\n";
	const tailBudget = maxInputChars - head.length - separator.length;

	const tailParts: string[] = [];
	let used = 0;
	for (let i = rendered.length - 1; i >= 1; i--) {
		const part = rendered[i]!;
		if (used + part.length + 2 > tailBudget) break;
		tailParts.unshift(part);
		used += part.length + 2;
	}

	if (tailParts.length === 0) {
		// Head alone already exceeds budget — hard-truncate it.
		return head.slice(0, maxInputChars);
	}

	return `${head}${separator}${tailParts.join("\n\n")}`;
}

/**
 * Summarize a Claude Code transcript with a one-shot Haiku query.
 *
 * @throws if the transcript is empty/unparseable, or if the query times out or
 *   returns no text. Callers treat any throw as "fall through to a normal
 *   resume" — summarization must never break a resume that would have worked.
 */
export async function summarizeTranscript(
	options: SummarizeTranscriptOptions,
): Promise<string> {
	const {
		transcriptPath,
		model = DEFAULT_MODEL,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		maxInputChars = DEFAULT_MAX_INPUT_CHARS,
		logger = createLogger({ component: "TranscriptSummarizer" }),
	} = options;

	const records = readRecords(transcriptPath);
	const turns = parseTranscript(records);
	const turnLog = renderCompactTurnLog(turns, maxInputChars);

	if (!turnLog.trim()) {
		throw new Error(
			`Transcript at ${transcriptPath} produced an empty turn log`,
		);
	}

	const prompt = `Here is the compact log of the prior session's turns. Summarize it per your instructions.\n\n<turn_log>\n${turnLog}\n</turn_log>`;

	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort(), timeoutMs);

	let summary = "";
	try {
		const response = query({
			prompt,
			options: {
				model,
				// A custom string systemPrompt intentionally bypasses the
				// `claude_code` preset — we want a lightweight summarizer, not a
				// coding agent with the full tool-use system prompt.
				systemPrompt: SYSTEM_PROMPT,
				tools: [],
				maxTurns: 1,
				effort: "low",
				maxBudgetUsd: 0.5,
				strictMcpConfig: true,
				abortController,
			},
		});

		for await (const message of response) {
			if (message.type === "result") {
				if (message.subtype === "success" && "result" in message) {
					summary = String(message.result ?? "").trim();
				}
			} else if (
				message.type === "assistant" &&
				Array.isArray(message.message?.content)
			) {
				// Fallback: accumulate assistant text if no result payload arrives.
				if (!summary) {
					const blocks = message.message.content as Array<{
						type?: string;
						text?: string;
					}>;
					const text = blocks
						.filter((b) => b.type === "text")
						.map((b) => b.text ?? "")
						.join("");
					if (text.trim()) summary = text.trim();
				}
			}
		}
	} catch (error) {
		if (abortController.signal.aborted) {
			throw new Error(
				`Transcript summarization timed out after ${timeoutMs}ms`,
			);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}

	if (!summary) {
		throw new Error("Transcript summarization returned an empty summary");
	}

	logger.debug(
		`Summarized transcript ${transcriptPath} (${turns.length} turns) into ${summary.length} chars`,
	);
	return summary;
}
