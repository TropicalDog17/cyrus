/**
 * Route — deterministic tier + gate policy (ported from `pipeline/route.py`,
 * DESIGN.md §Route decision table).
 *
 * A plain function over a plain table. NEVER an LM call (anti-goal #1). The chore rule in
 * particular must be decided by inspectable predicates, not a model.
 *
 * Output is the tier + gate behavior + verify level. The per-tier `allowedTools` boundary is
 * NOT decided here — it is read from Cyrus's own resolution chain, so the boundary is provably
 * identical to what Cyrus passes the executor.
 */

import { loadYaml } from "./config.js";

// A "concrete target" is a file, dependency, or config key. Heuristic, deliberately simple and
// readable — a chore that doesn't name one of these does NOT auto-approve. Ported verbatim from
// route.py (a literal `/` only needs escaping outside a character class in a JS regex literal).
export const FILE_RE = /(?:^|\s|`|['"(])([\w./-]+\.[A-Za-z][\w]{0,7})\b/g; // foo/bar.py
export const PATH_RE = /(?:^|\s|`|['"(])(\/?[\w-]+(?:\/[\w.-]+)+)\b/g; // a/b/c path
export const DEP_RE = /\b[\w@./-]+(?:==|@|>=|~=|\^)\s*[\dvV]/; // left-pad@1.2, foo==2
// Prose dependency bump ("bump lodash from 4.17.20 to 4.17.21", "upgrade left-pad to 1.2.0").
// Requires a bump VERB + a package token + a dotted target version, so ordinary prose like
// "move the parsing logic to 2.0" or "upgrade to 2.0" does NOT forge a dependency hit.
export const DEP_PHRASE_RE =
	/\b(?:bump|upgrade|downgrade|pin|update|migrate)\s+[\w@/.-]+\s+(?:from\s+v?\d[\w.-]*\s+)?to\s+v?\d+(?:\.\d+){1,3}\b/i;
export const CONFIG_KEY_RE =
	/\b(?:[a-z][\w-]*\.){1,}[a-z][\w-]*\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
export const BACKTICK_RE = /`[^`]+`/g;

// Common Latin abbreviations and slash idioms the path/file/config regexes would otherwise
// mistake for a target ("e.g." -> file "e.g"; "and/or" -> path). A chore body whose ONLY
// "target" is one of these names nothing concrete — it must NOT auto-skip the spec gate.
// Stored dot-stripped + lowercased to match normCandidate.
export const NOT_TARGETS: ReadonlySet<string> = new Set([
	"e.g",
	"i.e",
	"a.k.a",
	"etc",
	"vs",
	"aka",
	"et.al",
	"and/or",
	"true/false",
	"read/write",
	"yes/no",
	"n/a",
	"either/or",
	"input/output",
	"on/off",
	"pass/fail",
	"before/after",
	"min/max",
	"w/o",
]);

export function wordCount(text: string): number {
	const t = text.trim();
	return t === "" ? 0 : t.split(/\s+/).length;
}

function normCandidate(raw: string): string {
	return raw
		.trim()
		.replace(/^[`"'()]+/, "")
		.replace(/[`"'()]+$/, "")
		.replace(/\.+$/, "")
		.toLowerCase();
}

/**
 * Every concrete-target candidate in `text`, minus the abbreviation/idiom false-positives in
 * NOT_TARGETS. Empty list == names nothing concrete.
 */
function concreteTargets(text: string): string[] {
	const hits: string[] = [];
	for (const rx of [FILE_RE, PATH_RE, CONFIG_KEY_RE]) {
		for (const m of text.matchAll(rx)) {
			// FILE_RE/PATH_RE capture group 1; CONFIG_KEY_RE has no group -> use the whole match.
			const cand = normCandidate(m[1] !== undefined ? m[1] : m[0]!);
			if (cand && !NOT_TARGETS.has(cand)) hits.push(cand);
		}
	}
	if (DEP_RE.test(text) || DEP_PHRASE_RE.test(text)) hits.push("<dependency>");
	for (const m of text.matchAll(BACKTICK_RE)) {
		// A backtick span is an explicit literal code/file token (e.g. `etc`, `vs`), so it counts
		// regardless of the abbreviation denylist (which targets bare Latin/slug prose).
		const cand = normCandidate(m[0]!.replace(/^`+/, "").replace(/`+$/, ""));
		if (cand) hits.push(cand);
	}
	return hits;
}

/** True if the text points at a specific file, dependency, or config key. */
export function namesConcreteTarget(text: string): boolean {
	return concreteTargets(text).length > 0;
}

export class Issue {
	repo: string;
	labels: string[];
	body: string;
	estimate: number | null;
	multi_repo: boolean;

	constructor(opts: {
		repo: string;
		labels?: string[];
		body?: string;
		estimate?: number | null;
		multi_repo?: boolean;
	}) {
		this.repo = opts.repo;
		this.labels = opts.labels ?? [];
		this.body = opts.body ?? "";
		this.estimate = opts.estimate ?? null;
		this.multi_repo = opts.multi_repo ?? false;
	}

	get labelsLower(): Set<string> {
		return new Set(this.labels.map((label) => label.trim().toLowerCase()));
	}
}

export interface RouteDecision {
	tier: string; // chore | small | feature | full
	spec_gate: string; // auto | manual
	diff_gate: string; // always "manual" — never skipped, any tier
	verify: string; // mechanical | mechanical+judge | full
	reason: string; // which table row matched (for the run log / debugging)
}

export interface RouteConfig {
	work_repos?: string[];
	chore?: { max_body_words?: number; require_concrete_target?: boolean };
	small?: { max_estimate_points?: number };
	audit?: { sample_every?: number };
	[key: string]: unknown;
}

/** All must hold — the skip is decided by predicates, never a model. */
export function choreRuleFires(issue: Issue, cfg: RouteConfig): boolean {
	const choreCfg = cfg.chore ?? {};
	const workRepos = new Set(cfg.work_repos ?? []);
	if (workRepos.has(issue.repo)) return false;
	// a multi-repo chore has higher blast radius — mirror the small-tier fence
	if (issue.multi_repo) return false;
	if (!issue.labelsLower.has("chore")) return false;
	if (wordCount(issue.body) > (choreCfg.max_body_words ?? 50)) return false;
	if (
		(choreCfg.require_concrete_target ?? true) &&
		!namesConcreteTarget(issue.body)
	) {
		return false;
	}
	return true;
}

/**
 * For a `chore`-labeled issue that did NOT auto-approve, return the first failing predicate as a
 * human sentence (else null). Pure re-statement of choreRuleFires for explainability — never
 * changes the decision, just narrates it.
 */
export function choreBlockReason(
	issue: Issue,
	cfg: RouteConfig,
): string | null {
	if (!issue.labelsLower.has("chore")) {
		return null; // not a chore claim, so nothing to explain
	}
	const choreCfg = cfg.chore ?? {};
	const workRepos = new Set(cfg.work_repos ?? []);
	if (workRepos.has(issue.repo)) {
		return `repo '${issue.repo}' is a work repo — work repos never auto-approve`;
	}
	if (issue.multi_repo) {
		return "multi-repo issue — spans repos, so it never auto-approves (blast radius)";
	}
	const maxWords = choreCfg.max_body_words ?? 50;
	const words = wordCount(issue.body);
	if (words > maxWords) {
		return `body is ${words} words (chore limit is ${maxWords})`;
	}
	if (
		(choreCfg.require_concrete_target ?? true) &&
		!namesConcreteTarget(issue.body)
	) {
		return "body names no concrete target (a file, dependency, or config key)";
	}
	return null;
}

export function route(issue: Issue, cfg?: RouteConfig | null): RouteDecision {
	const c = cfg ?? (loadYaml("route.yaml") as RouteConfig);
	const workRepos = new Set(c.work_repos ?? []);
	const maxPts = c.small?.max_estimate_points ?? 2;

	// First match wins — order matters (DESIGN.md table).
	if (workRepos.has(issue.repo)) {
		return {
			tier: "full",
			spec_gate: "manual",
			diff_gate: "manual",
			verify: "full", // + CI + team conventions injected in Context
			reason: "repo in work_repos",
		};
	}
	if (choreRuleFires(issue, c)) {
		return {
			tier: "chore",
			spec_gate: "auto", // the ONLY gate a chore skips
			diff_gate: "manual",
			verify: "mechanical",
			reason: "chore rule fired",
		};
	}
	if (
		issue.estimate !== null &&
		issue.estimate <= maxPts &&
		!issue.multi_repo
	) {
		return {
			tier: "small",
			spec_gate: "manual",
			diff_gate: "manual",
			verify: "mechanical+judge",
			reason: `estimate ${issue.estimate} <= ${maxPts}, single-repo`,
		};
	}
	return {
		tier: "feature",
		spec_gate: "manual",
		diff_gate: "manual",
		verify: "full",
		reason: "default (no earlier row matched)",
	};
}

// --- Interactive gathering (injected `ask` / `fetchLabels` keep it testable) ----------------

export type Ask = (prompt: string) => string;
export type FetchLabels = () => string[] | null;

/** Python `int(tok)`: a valid signed integer only (no "1.5", no "1abc"). null == not an int. */
function parseIntStrict(tok: string): number | null {
	if (!/^[+-]?\d+$/.test(tok)) return null;
	return Number.parseInt(tok, 10);
}

/**
 * Parse a label-picker reply: comma-separated tokens, each a 1-based menu number OR a literal
 * label name (so you can pick from the list AND type an unlisted one). Out-of-range numbers are
 * ignored; order and de-duplication are preserved.
 */
export function parseLabelSelection(
	reply: string,
	choices: string[],
): string[] {
	const selected: string[] = [];
	for (const raw of reply.split(",")) {
		const tok = raw.trim();
		if (!tok) continue;
		let name: string;
		const idx = parseIntStrict(tok);
		if (idx === null) {
			name = tok; // a literal label name (may be one not in the offered list)
		} else {
			if (!(idx >= 1 && idx <= choices.length)) continue; // bad menu number — ignore
			name = choices[idx - 1]!;
		}
		if (!selected.includes(name)) selected.push(name);
	}
	return selected;
}

function promptLabels(ask: Ask, fetchLabels: FetchLabels): string[] {
	const choices = fetchLabels();
	if (choices && choices.length > 0) {
		let menu =
			"labels — pick numbers and/or type names (comma-separated) []:\n";
		menu += choices.map((name, i) => `  ${i + 1}) ${name}\n`).join("");
		return parseLabelSelection(ask(`${menu}> `), choices);
	}
	const hint = "labels (comma-separated; only `chore` affects routing) []: ";
	return ask(hint)
		.split(",")
		.map((x) => x.trim())
		.filter((x) => x);
}

/**
 * Interactively gather an Issue. `ask(prompt) -> stripped line` and `fetchLabels() -> list|null`
 * are injected so the flow is testable without a TTY or network.
 */
export function promptIssue(ask: Ask, fetchLabels: FetchLabels): Issue {
	let repo = "";
	while (!repo) {
		repo = ask("repo (required): ");
		if (!repo) {
			process.stderr.write("  repo is required — please enter a value.\n");
		}
	}
	const labels = promptLabels(ask, fetchLabels);
	const body = ask("body (one line) []: ");
	let estimate: number | null = null;
	while (true) {
		const raw = ask("estimate points (integer; blank = none) []: ");
		if (!raw) break;
		const parsed = parseIntStrict(raw);
		if (parsed !== null) {
			estimate = parsed;
			break;
		}
		process.stderr.write("  estimate must be an integer or blank.\n");
	}
	const multiRepo = ["y", "yes"].includes(
		ask("multi-repo? [y/N]: ").toLowerCase(),
	);
	return new Issue({ repo, labels, body, estimate, multi_repo: multiRepo });
}

/** Minimal JSON payload (defaults dropped) that reproduces `issue` via stdin. */
export function issuePayload(issue: Issue): Record<string, unknown> {
	const payload: Record<string, unknown> = { repo: issue.repo };
	if (issue.labels.length) payload.labels = issue.labels;
	if (issue.body) payload.body = issue.body;
	if (issue.estimate !== null) payload.estimate = issue.estimate;
	if (issue.multi_repo) payload.multi_repo = true;
	return payload;
}

/** Python json.dumps default: insertion order, ", " / ": " separators (used by explain). */
function pyJson(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj)
		.map((k) => `${JSON.stringify(k)}: ${pyJson(obj[k])}`)
		.join(", ")}}`;
}

/**
 * Human-readable decision for interactive use, incl. why a chore didn't auto-skip and a
 * copy-pasteable non-interactive invocation.
 */
export function explain(
	issue: Issue,
	decision: RouteDecision,
	cfg: RouteConfig,
): string {
	const lines = [
		`tier:      ${decision.tier}`,
		`spec_gate: ${decision.spec_gate}`,
		`diff_gate: ${decision.diff_gate}  (never skipped, any tier)`,
		`verify:    ${decision.verify}`,
		`reason:    ${decision.reason}`,
	];
	const blocked = choreBlockReason(issue, cfg);
	if (blocked) {
		lines.push(`note:      chore-labeled but not auto-approved — ${blocked}`);
	}
	lines.push(
		"",
		`reuse:     echo '${pyJson(issuePayload(issue))}' | uv run route`,
	);
	return lines.join("\n");
}
