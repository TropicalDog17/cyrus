/**
 * Verify judge — citation-locked (ported from `pipeline/judge.py`).
 *
 * The judge may cite ONLY evidence-ledger ids (E1..En) produced by deterministic runners.
 * Any claim/concern with a missing, malformed, or dangling (not-in-this-ledger) citation
 * invalidates the WHOLE response → forced to `cannot-verify`. One fabricated citation is an
 * integrity failure, not a droppable typo. `cannot-verify` is a first-class honest outcome.
 *
 * Enforcement lives HERE, in deterministic code, not in the prompt. When actually calling a
 * model we use the raw Anthropic SDK with a tool (structured output) for SHAPE, but keep this
 * validator regardless: a schema can't cross-check that a cited id EXISTS in this run's ledger.
 */

import { formatErrors, type LedgerEntry } from "./schemas.js";

const _EVID_RE = /^E[0-9]+$/;

// Human diff-gate verdicts that count as "the human would reject this diff".
const _REJECTED = new Set(["rejected", "needs-rework"]);

// The canonical valid vocabularies (gate re-exports HUMAN_VERDICTS from here — gate depends on
// judge, not the reverse). Used for input validation; deriveJudgeEval itself is lenient.
export const HUMAN_VERDICTS = new Set(["approved", "rejected", "needs-rework"]);
export const JUDGE_VERDICTS = new Set([
	"pass",
	"fail",
	"cannot-verify",
	"skip",
]);

export interface JudgeVerdictResult {
	verdict: string;
	claims: Array<{ claim: string; evidence: string }>;
	concerns: Array<{ text: string; evidence: string }>;
	_validation_error?: string;
	_audit?: Record<string, unknown>;
}

/**
 * The set of citable ids for a run — always rebuilt from that run's actual ledger entries,
 * never hardcoded (else a hallucinated E6 vs a 5-entry ledger could pass by coincidence).
 */
export function ledgerIds(entries: Iterable<{ id?: string }>): Set<string> {
	const ids = new Set<string>();
	for (const e of entries) {
		if (e && typeof e === "object" && typeof e.id === "string") ids.add(e.id);
	}
	return ids;
}

/**
 * The sorted set of evidence ids the judge actually cited across claims+concerns — for the run
 * record's verify.judge_evidence_ids. Derived from the validated output so it always matches.
 */
export function evidenceIdsCited(validated: {
	claims?: Array<{ evidence?: unknown }>;
	concerns?: Array<{ evidence?: unknown }>;
}): string[] {
	const ids = new Set<string>();
	for (const bucket of ["claims", "concerns"] as const) {
		for (const item of validated[bucket] ?? []) {
			if (
				item &&
				typeof item === "object" &&
				typeof item.evidence === "string"
			) {
				ids.add(item.evidence);
			}
		}
	}
	return [...ids].sort();
}

function forcedCv(
	reason: string,
	audit: Record<string, unknown> = {},
): JudgeVerdictResult {
	return {
		verdict: "cannot-verify",
		claims: [],
		concerns: [],
		_validation_error: reason,
		_audit: audit,
	};
}

/**
 * Return a trusted verdict dict. Any integrity problem → forced cannot-verify. `raw` may be the
 * model's JSON string or an already-parsed object. `citable` is the set of evidence ids that
 * actually exist in this run's ledger.
 */
export function validateJudgeOutput(
	raw: string | unknown,
	citable: Set<string>,
): JudgeVerdictResult {
	let obj: unknown;
	if (typeof raw === "string") {
		try {
			obj = JSON.parse(raw);
		} catch (e) {
			return forcedCv("invalid_json", { detail: String(e) });
		}
	} else {
		obj = raw;
	}

	// Defend against every non-dict shape the model might emit (array, scalar, null).
	if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
		return forcedCv("not_an_object", {
			got: obj === null ? "null" : Array.isArray(obj) ? "array" : typeof obj,
		});
	}

	// Structural shape (enums, required keys, evidence pattern, no extra keys).
	const shapeErrors = formatErrors("judge", obj);
	if (shapeErrors.length > 0) {
		return forcedCv("schema_violation", { errors: shapeErrors, original: obj });
	}

	const record = obj as {
		verdict: string;
		claims: Array<Record<string, unknown>>;
		concerns: Array<Record<string, unknown>>;
	};

	// Cross-check citations against THIS run's ledger — the check a schema can't do.
	const violations: Array<Record<string, unknown>> = [];
	for (const bucket of ["claims", "concerns"] as const) {
		for (const item of record[bucket] ?? []) {
			if (item === null || typeof item !== "object") {
				violations.push({ bucket, item, why: "not_an_object" });
				continue;
			}
			const eid = (item as { evidence?: unknown }).evidence;
			if (typeof eid !== "string" || !_EVID_RE.test(eid) || !citable.has(eid)) {
				violations.push({ bucket, item, why: "ungrounded_citation" });
			}
		}
	}
	if (violations.length > 0) {
		return forcedCv("ungrounded_citation", { violations, original: obj });
	}

	// A verdict must be backed: pass needs a supporting claim; fail needs a concern.
	if (record.verdict === "pass" && (record.claims?.length ?? 0) === 0) {
		return forcedCv("pass_without_claims", { original: obj });
	}
	if (record.verdict === "fail" && (record.concerns?.length ?? 0) === 0) {
		return forcedCv("fail_without_concerns", { original: obj });
	}

	return record as JudgeVerdictResult;
}

/**
 * Confusion-matrix cell from (judge × human). null when verify was skipped. missed_fail
 * (judge=pass, human=rejected) is the costly cell. cv_* rows exist because cannot-verify is
 * first-class.
 */
export function deriveJudgeEval(
	judgeVerdict: string | null,
	humanVerdict: string | null,
): string | null {
	if (
		judgeVerdict === null ||
		judgeVerdict === "skip" ||
		humanVerdict === null
	) {
		return null;
	}
	const humanRejected = _REJECTED.has(humanVerdict);
	const table: Record<string, string> = {
		"pass|false": "true_pass",
		"pass|true": "missed_fail",
		"fail|true": "true_fail",
		"fail|false": "false_alarm",
		"cannot-verify|false": "cv_on_pass",
		"cannot-verify|true": "cv_on_fail",
	};
	return table[`${judgeVerdict}|${humanRejected}`] ?? null;
}

// --- LM backend (pluggable; deliberately not wired to a key by default) ----------

export type LMBackend = (
	prompt: string,
	outputSchema: Record<string, unknown>,
) => Promise<string> | string;

const _unconfiguredBackend: LMBackend = () => {
	throw new Error(
		"No judge LM backend configured. Wire an Anthropic client using the raw SDK with a " +
			"structured-output tool (model 'claude-opus-4-8'), then pass it to runJudge(..., " +
			"{backend}). The deterministic validator (validateJudgeOutput) runs regardless.",
	);
};

/** JSON Schema for the judge's structured-output tool (mirrors schemas/judge.schema.json). */
export const JUDGE_JSON_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["verdict", "claims", "concerns"],
	properties: {
		verdict: { enum: ["pass", "fail", "cannot-verify"] },
		claims: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["claim", "evidence"],
				properties: {
					claim: { type: "string", minLength: 1 },
					evidence: { type: "string", pattern: "^E[0-9]+$" },
				},
			},
		},
		concerns: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["text", "evidence"],
				properties: {
					text: { type: "string", minLength: 1 },
					evidence: { type: "string", pattern: "^E[0-9]+$" },
				},
			},
		},
	},
} as const;

/**
 * A judge backend backed by the raw Anthropic SDK (decision 4). Uses a forced tool call for
 * structured output. The returned JSON string is still run through validateJudgeOutput.
 */
export function createAnthropicJudgeBackend(
	opts: { client?: unknown; model?: string; maxTokens?: number } = {},
): LMBackend {
	return async (prompt: string): Promise<string> => {
		const { default: Anthropic } = await import("@anthropic-ai/sdk");
		const client =
			(opts.client as InstanceType<typeof Anthropic> | undefined) ??
			new Anthropic();
		const resp = await client.messages.create({
			model: opts.model ?? "claude-opus-4-8",
			max_tokens: opts.maxTokens ?? 2048,
			tools: [
				{
					name: "submit_verdict",
					description:
						"Submit the citation-locked verify verdict. Every claim and concern MUST " +
						"cite an evidence id (E1..En) from the run's ledger.",
					input_schema: JUDGE_JSON_SCHEMA as unknown as Record<string, unknown>,
				},
			],
			tool_choice: { type: "tool", name: "submit_verdict" },
			messages: [{ role: "user", content: prompt }],
		} as Parameters<InstanceType<typeof Anthropic>["messages"]["create"]>[0]);
		const block = (
			resp as { content: Array<{ type: string; input?: unknown }> }
		).content.find((b) => b.type === "tool_use");
		return block ? JSON.stringify(block.input) : "{}";
	};
}

/** Call the LM, then hard-validate against this run's ledger before trusting it. */
export async function runJudge(
	prompt: string,
	entries: LedgerEntry[],
	opts: { backend?: LMBackend } = {},
): Promise<JudgeVerdictResult> {
	const backend = opts.backend ?? _unconfiguredBackend;
	const raw = await backend(
		prompt,
		JUDGE_JSON_SCHEMA as unknown as Record<string, unknown>,
	);
	return validateJudgeOutput(raw, ledgerIds(entries));
}
