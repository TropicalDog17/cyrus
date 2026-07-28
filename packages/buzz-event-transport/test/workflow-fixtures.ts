import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WORKFLOWS_DIR = fileURLToPath(
	new URL("../workflows/", import.meta.url),
);

export interface WorkflowFixture {
	/** The single trigger event the file declares under `trigger.on`. */
	trigger: string;
	/** The `body:` folded scalar, templates still unsubstituted. */
	bodyTemplate: string;
}

/**
 * Extract the `on:` trigger and the `body:` folded scalar from a workflow file.
 *
 * Deliberately not a YAML parser. These files are ours, they are tiny, and the
 * property under test is narrow: exactly one trigger per file, and a body that
 * is still valid JSON once buzz-workflow has substituted the templates. A file
 * that drifts out of this shape throws here rather than being waved through.
 */
export function readWorkflow(fileName: string): WorkflowFixture {
	const source = readFileSync(`${WORKFLOWS_DIR}${fileName}`, "utf8");

	const triggerMatch = source.match(/^ {2}on: (\S+)$/m);
	if (!triggerMatch?.[1]) {
		throw new Error(`${fileName} declares no 'on:' trigger`);
	}

	const marker = "body: >-\n";
	const bodyStart = source.indexOf(marker);
	if (bodyStart === -1) {
		throw new Error(`${fileName} has no folded 'body: >-' scalar`);
	}

	// A `>-` scalar folds its line breaks into single spaces.
	const bodyTemplate = source
		.slice(bodyStart + marker.length)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join(" ");

	return { trigger: triggerMatch[1], bodyTemplate };
}

/**
 * Render a workflow body the way buzz-workflow's `resolve_template` does:
 * raw, unescaped string substitution of `{{trigger.<field>}}`. Parsing the
 * result is the point — an unescapable value produces invalid JSON here for
 * exactly the reason it produces a dropped 400 in production.
 */
export function renderWorkflowBody(
	fileName: string,
	trigger: Record<string, string>,
): unknown {
	let rendered = readWorkflow(fileName).bodyTemplate;
	for (const [field, value] of Object.entries(trigger)) {
		rendered = rendered.split(`{{trigger.${field}}}`).join(value);
	}
	return JSON.parse(rendered);
}
