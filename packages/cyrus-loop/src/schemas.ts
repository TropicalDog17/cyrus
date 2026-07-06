/**
 * Zod schemas — the source of truth for run / ledger / judge records (ported from
 * `pipeline/schema.py` + `schemas/*.json`).
 *
 * Design notes carried over from the Python port:
 *  - Constraints are encoded as regex `pattern`s, NOT JSON-Schema `format`/`.datetime()`.
 *    The original deliberately avoided `format` (jsonschema's FormatChecker silently
 *    no-ops on `date-time`). We keep the exact regexes so validation behaviour is identical.
 *  - `additionalProperties: false` → `z.strictObject(...)`.
 *  - `validate()` collects EVERY failing path (not fail-fast) so a bad LM/pipeline record
 *    reports all violations at once.
 *  - `canonicalStringify` reproduces Python `json.dumps(sort_keys=True, ensure_ascii=False)`
 *    byte-for-byte (recursively sorted keys, `", "` / `": "` separators) so run/ledger lines
 *    are stable and comparable across tools.
 */

import { z } from "zod";

// --- Regex patterns, copied VERBATIM from schemas/*.json ---------------------------------
export const RUN_ID_PATTERN =
	/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[A-Za-z][A-Za-z0-9]*-[0-9]+(-pr[0-9]+)?$/;
export const ISSUE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/;
export const ISO_DATETIME_PATTERN =
	/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?([+-][0-9]{2}:[0-9]{2}|Z)?$/;
export const EVIDENCE_ID_PATTERN = /^E[0-9]+$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

// --- runs.schema.json --------------------------------------------------------------------
const AmendmentSchema = z.strictObject({
	note: z.string(),
	files_expected_added: z.array(z.string()).optional(),
	created_at: z.string().regex(ISO_DATETIME_PATTERN).optional(),
	approved: z.boolean().optional(),
});

const DiffStatsSchema = z.strictObject({
	files: z.number().int().min(0),
	loc: z.number().int().min(0),
});

const VerifySchema = z.strictObject({
	mechanical: z.enum(["pass", "fail", "skip"]),
	judge_verdict: z.enum(["pass", "fail", "cannot-verify", "skip"]),
	judge_evidence_ids: z.array(z.string().regex(EVIDENCE_ID_PATTERN)).optional(),
});

const FindingSchema = z.strictObject({
	text: z.string(),
	tag: z.enum(["recurring", "one-off"]),
	rule_ineffective: z.string().nullable().optional(),
	matched_rule_not_loaded: z.string().nullable().optional(),
});

const DiffGateSchema = z.strictObject({
	verdict: z.enum(["approved", "rejected", "needs-rework"]),
	findings: z.array(FindingSchema).optional(),
	recorded_at: z.string().regex(ISO_DATETIME_PATTERN).nullable().optional(),
});

export const RunRecordSchema = z.strictObject({
	run_id: z.string().regex(RUN_ID_PATTERN),
	issue_id: z.string().regex(ISSUE_ID_PATTERN),
	repo: z.string().min(1),
	tier: z.enum(["chore", "small", "feature", "full"]),
	spec_proposed: z.string(),
	spec_approved: z.string().nullable().optional(),
	spec_gate: z.enum(["approved", "edited", "rejected", "auto"]),
	amendments: z.array(AmendmentSchema).optional(),
	context_manifest: z.array(z.string()).optional(),
	scope_prompt_version: z.string().min(1),
	judge_prompt_version: z.string().min(1),
	executor_model: z.string().nullable().optional(),
	judge_model: z.string().nullable().optional(),
	tokens_total: z.number().int().min(0).nullable().optional(),
	diff_stats: DiffStatsSchema.nullable().optional(),
	ledger_sha: z.string().regex(SHA256_PATTERN).nullable().optional(),
	verify: VerifySchema.nullable().optional(),
	diff_gate: DiffGateSchema.nullable().optional(),
	judge_eval: z
		.enum([
			"true_pass",
			"true_fail",
			"missed_fail",
			"false_alarm",
			"cv_on_pass",
			"cv_on_fail",
		])
		.nullable()
		.optional(),
	chore_audit: z.enum(["clean", "should_have_gated"]).nullable().optional(),
	outcome: z.enum(["merged", "rework", "abandoned"]),
	rework_issue: z.string().nullable().optional(),
	retries: z.number().int().min(0).optional(),
	agent_minutes: z.number().min(0).nullable().optional(),
	waiting_minutes: z.number().min(0).nullable().optional(),
});

// --- ledger.schema.json ------------------------------------------------------------------
export const LedgerEntrySchema = z.strictObject({
	id: z.string().regex(EVIDENCE_ID_PATTERN),
	kind: z.enum([
		"tests",
		"lint",
		"build",
		"typecheck",
		"diffscan",
		"coverage",
		"custom",
	]),
	attempt: z.number().int().min(1).nullable().optional(),
	cmd: z.string().nullable().optional(),
	exit: z.number().int().nullable().optional(),
	result: z.enum(["pass", "fail", "warn", "skip"]).nullable().optional(),
	summary: z.string().optional(),
	artifact: z.string().nullable().optional(),
});

// --- judge.schema.json -------------------------------------------------------------------
const ClaimSchema = z.strictObject({
	claim: z.string().min(1),
	evidence: z.string().regex(EVIDENCE_ID_PATTERN),
});

const ConcernSchema = z.strictObject({
	text: z.string().min(1),
	evidence: z.string().regex(EVIDENCE_ID_PATTERN),
});

export const JudgeOutputSchema = z.strictObject({
	verdict: z.enum(["pass", "fail", "cannot-verify"]),
	claims: z.array(ClaimSchema),
	concerns: z.array(ConcernSchema),
});

// --- Inferred types ----------------------------------------------------------------------
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

// --- Registry + validation API (mirrors pipeline/schema.py) ------------------------------
export const SCHEMAS = {
	runs: RunRecordSchema,
	ledger: LedgerEntrySchema,
	judge: JudgeOutputSchema,
} as const;

export type SchemaName = keyof typeof SCHEMAS;

/** A record failed validation against its schema (lists every failing path). */
export class SchemaValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SchemaValidationError";
	}
}

function jsonPath(path: ReadonlyArray<PropertyKey>): string {
	let out = "$";
	for (const p of path) {
		if (typeof p === "number") out += `[${p}]`;
		else out += `.${String(p)}`;
	}
	return out;
}

/** Return every violation as `json_path: message`, sorted by path. Empty == valid. */
export function formatErrors(name: SchemaName, instance: unknown): string[] {
	const result = SCHEMAS[name].safeParse(instance);
	if (result.success) return [];
	return result.error.issues
		.map((issue) => `${jsonPath(issue.path)}: ${issue.message}`)
		.sort();
}

/** Throw SchemaValidationError listing all violations; return void if valid. */
export function validate(
	name: SchemaName,
	instance: unknown,
	label = "record",
): void {
	const errors = formatErrors(name, instance);
	if (errors.length > 0) {
		throw new SchemaValidationError(
			`${label} failed '${name}' schema validation:\n  ${errors.join("\n  ")}`,
		);
	}
}

/**
 * Serialize `obj` to match Python `json.dumps(obj, ensure_ascii=False, sort_keys=True)`
 * byte-for-byte: keys recursively sorted, `", "` between items and `": "` between key and
 * value. Used as the on-disk canonical form for runs.jsonl / ledger lines.
 *
 * Caveat: JS cannot distinguish `1.0` from `1`, so a Python-authored float like `1.0`
 * re-serializes here as `1`. Run values in practice are integers or JSON round-tripped
 * numbers, so this does not bite; noted for the cross-language byte-parity spot check.
 */
export function canonicalStringify(obj: unknown): string {
	return serialize(obj);
}

function serialize(value: unknown): string {
	if (value === null || value === undefined) return "null";
	const t = typeof value;
	if (t === "number") {
		if (!Number.isFinite(value as number)) {
			throw new TypeError(`cannot serialize non-finite number: ${value}`);
		}
		return JSON.stringify(value);
	}
	if (t === "boolean") return value ? "true" : "false";
	if (t === "string") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map(serialize).join(", ")}]`;
	}
	if (t === "object") {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		return `{${keys
			.map((k) => `${JSON.stringify(k)}: ${serialize(obj[k])}`)
			.join(", ")}}`;
	}
	throw new TypeError(`cannot serialize value of type ${t}`);
}
