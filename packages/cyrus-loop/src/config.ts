/**
 * Tiny YAML config loader for the inspectable policy files under config/ (ported from
 * `pipeline/config.py`). Policy (route table, budgets) lives in YAML on purpose —
 * "ugly-but-inspectable" beats config baked into code. These are read, never written.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { configDir } from "./paths.js";

// Cache keyed on the RESOLVED path, not on `name` — so a different AGENTIC_PIPELINE_ROOT
// in the same process (tests, a notebook, a persistent service) invalidates automatically
// instead of serving another root's stale config.
const _cache = new Map<string, Record<string, unknown>>();

function loadYamlAt(path: string): Record<string, unknown> {
	const hit = _cache.get(path);
	if (hit) return hit;
	const parsed =
		(yaml.load(readFileSync(path, "utf-8")) as Record<string, unknown>) ?? {};
	_cache.set(path, parsed);
	return parsed;
}

/** `name` is a filename under config/, e.g. 'budgets.yaml'. */
export function loadYaml(name: string): Record<string, unknown> {
	return loadYamlAt(join(configDir(), name));
}

/** Clear the config cache — for tests that repoint AGENTIC_PIPELINE_ROOT. */
export function clearConfigCache(): void {
	_cache.clear();
}
