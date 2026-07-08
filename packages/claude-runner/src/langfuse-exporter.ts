/**
 * Langfuse LLMOps export for Claude Code sessions.
 *
 * ## Why this exists (and why the previous OTLP approach did not work)
 *
 * The first cut of this feature (see git history for `telemetry-env.ts`) set
 * `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus `OTEL_*` exporter variables and pointed
 * them at Langfuse's OTLP receiver, on the assumption that the Claude Agent SDK
 * emits OpenTelemetry **spans** around each model request. That assumption is
 * wrong for shipped Claude Code: with telemetry enabled it exports OTLP
 * **logs** (`/v1/logs`) and **metrics** (`/v1/metrics`) only — never traces
 * (`/v1/traces`). Langfuse's OTLP endpoint, in turn, only ingests **spans**;
 * `/v1/logs` 404s and `/v1/metrics` is accepted-but-discarded. The two sides
 * therefore never overlap and nothing is ever ingested (verified empirically
 * against Claude Code 2.1.x and Langfuse v3.206).
 *
 * ## What this does instead
 *
 * Langfuse's own Claude Code integration reconstructs a trace from the session
 * **transcript** rather than from OTLP. We do the same, but natively in
 * TypeScript against Langfuse's first-class ingestion API (which every Langfuse
 * version supports), so there is no Python runtime, no vendored hook script,
 * and no private-SDK-attribute dependency. `ClaudeRunner` registers a
 * `SessionEnd` hook that hands us the transcript path; we parse the JSONL and
 * emit one Langfuse trace per Claude Code session:
 *   - one `generation` per assistant turn (model, token usage, prompt, output),
 *   - one child `span` per tool call (input + matched tool_result output).
 *
 * All Langfuse object IDs are derived deterministically from stable transcript
 * IDs (session id, assistant message uuid, tool_use id), so a re-export upserts
 * the same objects instead of duplicating them — safe to call more than once.
 *
 * Reference: https://langfuse.com/integrations/other/claude-code
 */

import { readFileSync } from "node:fs";
import type { ILogger } from "cyrus-core";

/** Default Langfuse Cloud host (EU region), used when none is configured. */
const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com";

/** Resolved credentials + endpoint for a Langfuse project. */
export interface LangfuseConfig {
	publicKey: string;
	secretKey: string;
	baseUrl: string;
}

function isTruthyEnv(value: string | undefined): boolean {
	if (!value) return false;
	const v = value.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Resolve the Langfuse configuration from Cyrus-friendly env vars.
 *
 * Returns `null` (export stays off) when `CYRUS_TELEMETRY_DISABLED` is truthy
 * or when either key is missing — so this is safe to call for every session and
 * is a no-op until an operator pastes their Langfuse keys into `~/.cyrus/.env`.
 *
 * `LANGFUSE_HOST` is preferred (matches the name Cyrus already documents);
 * `LANGFUSE_BASE_URL` is accepted as an alias for parity with Langfuse's own
 * SDK naming.
 */
export function resolveLangfuseConfig(
	env: NodeJS.ProcessEnv = process.env,
): LangfuseConfig | null {
	if (isTruthyEnv(env.CYRUS_TELEMETRY_DISABLED)) return null;
	const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
	const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
	if (!publicKey || !secretKey) return null;
	const baseUrl =
		env.LANGFUSE_HOST?.trim() ||
		env.LANGFUSE_BASE_URL?.trim() ||
		DEFAULT_LANGFUSE_HOST;
	return { publicKey, secretKey, baseUrl: baseUrl.replace(/\/+$/, "") };
}

/** A single JSONL record from a Claude Code transcript (loosely typed). */
interface TranscriptRecord {
	type?: string;
	uuid?: string;
	timestamp?: string;
	message?: {
		id?: string;
		role?: string;
		model?: string;
		content?: unknown;
		usage?: Record<string, unknown>;
		stop_reason?: string | null;
	};
}

interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	id?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
}

/** Coerce a message `content` field into an array of blocks. */
function asBlocks(content: unknown): ContentBlock[] {
	if (Array.isArray(content)) return content as ContentBlock[];
	if (typeof content === "string") return [{ type: "text", text: content }];
	return [];
}

/** Join all text blocks of a content array into a single string. */
function textOf(content: unknown): string {
	return asBlocks(content)
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

/** Render a tool_result block's content to a string for span output. */
function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((b: ContentBlock) =>
				b?.type === "text" && typeof b.text === "string"
					? b.text
					: JSON.stringify(b),
			)
			.join("\n");
	}
	return content == null ? "" : JSON.stringify(content);
}

function toDate(ts: string | undefined): Date | undefined {
	if (!ts) return undefined;
	const d = new Date(ts);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export interface ExportOptions {
	transcriptPath: string;
	sessionId: string;
	config: LangfuseConfig;
	/** Optional human name for the trace (e.g. the Cyrus workspace/issue). */
	traceName?: string;
	/** Extra metadata merged onto the trace (issue id, platform, cwd, …). */
	metadata?: Record<string, unknown>;
	logger?: ILogger;
	/** Injectable Langfuse client constructor for tests. */
	clientFactory?: (config: LangfuseConfig) => LangfuseLike;
}

/**
 * Minimal structural type for the bits of the Langfuse SDK we use. Keeping our
 * own interface (rather than importing the SDK's types) lets tests inject a
 * fake and keeps the SDK an ordinary runtime dependency.
 */
export interface LangfuseLike {
	trace(body: Record<string, unknown>): {
		generation(body: Record<string, unknown>): unknown;
		span(body: Record<string, unknown>): unknown;
	};
	flushAsync(): Promise<unknown>;
	shutdownAsync?(): Promise<unknown>;
}

async function defaultClientFactory(
	config: LangfuseConfig,
): Promise<LangfuseLike> {
	// Imported lazily so the dependency is only touched when export is enabled.
	const { Langfuse } = await import("langfuse");
	return new Langfuse({
		publicKey: config.publicKey,
		secretKey: config.secretKey,
		baseUrl: config.baseUrl,
	}) as unknown as LangfuseLike;
}

/** Result summary for logging/tests. */
export interface ExportResult {
	generations: number;
	toolSpans: number;
}

/**
 * Parse a Claude Code transcript and emit a single Langfuse trace for the
 * session. Never throws for malformed transcript lines — bad lines are skipped.
 * IO/network failures propagate so the caller can log them.
 */
export async function exportTranscriptToLangfuse(
	options: ExportOptions,
): Promise<ExportResult> {
	const { transcriptPath, sessionId, config, metadata } = options;

	const raw = readFileSync(transcriptPath, "utf8");
	const records: TranscriptRecord[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed) as TranscriptRecord);
		} catch {
			// Skip partial/corrupt lines rather than fail the whole export.
		}
	}

	// Pre-pass: map tool_use_id -> tool_result text (results live in later
	// `user` turns, so we resolve them before emitting spans).
	const toolResults = new Map<string, string>();
	for (const rec of records) {
		if (rec.type !== "user") continue;
		for (const block of asBlocks(rec.message?.content)) {
			if (block.type === "tool_result" && block.tool_use_id) {
				toolResults.set(block.tool_use_id, resultText(block.content));
			}
		}
	}

	const client = await (options.clientFactory
		? options.clientFactory(config)
		: defaultClientFactory(config));

	const firstTs = records.find((r) => r.timestamp)?.timestamp;
	const trace = client.trace({
		id: `cyrus-${sessionId}`,
		name: options.traceName || `cyrus-session-${sessionId.slice(0, 8)}`,
		sessionId,
		timestamp: toDate(firstTs),
		metadata: { source: "cyrus", claudeSessionId: sessionId, ...metadata },
	});

	let lastUserText = "";
	let generations = 0;
	let toolSpans = 0;

	for (const rec of records) {
		if (rec.type === "user") {
			const t = textOf(rec.message?.content);
			// Ignore pure tool_result turns — they are not a human/agent prompt.
			if (t) lastUserText = t;
			continue;
		}
		if (rec.type !== "assistant" || !rec.message) continue;

		const msg = rec.message;
		const blocks = asBlocks(msg.content);
		const usage = msg.usage ?? {};
		const inputTokens =
			num(usage.input_tokens) +
			num(usage.cache_creation_input_tokens) +
			num(usage.cache_read_input_tokens);
		const outputTokens = num(usage.output_tokens);
		const startTime = toDate(rec.timestamp);

		trace.generation({
			id: `gen-${rec.uuid ?? msg.id ?? generations}`,
			name: "assistant-turn",
			model: msg.model,
			input: lastUserText || undefined,
			output: textOf(msg.content) || undefined,
			usage: {
				input: inputTokens,
				output: outputTokens,
				total: inputTokens + outputTokens,
				unit: "TOKENS",
			},
			startTime,
			endTime: startTime,
			metadata: {
				stopReason: msg.stop_reason ?? undefined,
				rawUsage: usage,
			},
		});
		generations++;

		// One span per tool call, with its matched result as output.
		for (const block of blocks) {
			if (block.type !== "tool_use") continue;
			trace.span({
				id: `tool-${block.id ?? `${rec.uuid}-${toolSpans}`}`,
				name: `tool:${block.name ?? "unknown"}`,
				input: block.input,
				output: block.id ? toolResults.get(block.id) : undefined,
				startTime,
				endTime: startTime,
			});
			toolSpans++;
		}
	}

	await client.flushAsync();
	if (client.shutdownAsync) await client.shutdownAsync();

	options.logger?.debug?.(
		`Langfuse export complete: ${generations} generations, ${toolSpans} tool spans`,
	);
	return { generations, toolSpans };
}
