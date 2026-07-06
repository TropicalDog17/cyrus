/**
 * Parse a spec (Scope's output contract, templates/spec.md) into sections (ported from
 * `pipeline/spec.py`).
 *
 * Deterministic markdown parsing — the spec is a fenced set of `##` sections. We need
 * `Files expected` for the E4 diffscan and `Acceptance` for cross-referencing ledger
 * entries, so parsing stays small and forgiving (missing sections -> empty).
 */

// re.MULTILINE -> `m`; a global flag is added so we can iterate every header (finditer).
const HEADER_RE = /^\s*##\s+(.+?)\s*$/gm;
const BULLET_RE = /^\s*[-*]\s+(?:\[.\]\s*)?(.+?)\s*$/;
// A bullet "looks like a path" if it has a slash OR a trailing file extension.
const EXT_RE = /\.\w{1,8}$/;

function norm(title: string): string {
	return title.trim().toLowerCase();
}

/** Return {normalized-section-title: raw body text}. Comments/HTML kept as-is. */
export function parseSpec(text: string): Record<string, string> {
	const sections: Record<string, string> = {};
	const matches = [...text.matchAll(HEADER_RE)];
	for (let i = 0; i < matches.length; i++) {
		const m = matches[i]!;
		const start = m.index! + m[0]!.length;
		const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
		sections[norm(m[1]!)] = text.slice(start, end).trim();
	}
	return sections;
}

function bullets(body: string): string[] {
	const out: string[] = [];
	for (const line of body.split(/\r\n|\r|\n/)) {
		if (line.trimStart().startsWith("<!--")) continue;
		const m = BULLET_RE.exec(line);
		if (m) {
			const item = m[1]!.trim();
			if (item && !item.startsWith("<!--")) out.push(item);
		}
	}
	return out;
}

/** The best-guess file list that feeds the E4 diffscan (amendable mid-run). */
export function filesExpected(text: string): string[] {
	const sections = parseSpec(text);
	const body = sections["files expected"] ?? "";
	// Keep only things that look like paths (drop prose bullets).
	return bullets(body).filter((b) => b.includes("/") || EXT_RE.test(b));
}

export function acceptance(text: string): string[] {
	return bullets(parseSpec(text).acceptance ?? "");
}
