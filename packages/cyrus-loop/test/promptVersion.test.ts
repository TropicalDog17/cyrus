import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { promptsDir } from "../src/paths.js";
import {
	currentVersions,
	getPromptVersion,
	MissingPromptVersion,
} from "../src/promptVersion.js";

// Ported from tests/test_misc.py (prompts section)
describe("promptVersion", () => {
	it("reads the version tag from the bundled prompt files", () => {
		expect(getPromptVersion(join(promptsDir(), "scope-v1.md"))).toBe(
			"scope-v1",
		);
		expect(getPromptVersion(join(promptsDir(), "judge-v1.md"))).toBe(
			"judge-v1",
		);
	});

	it("prefers frontmatter over an inline comment", () => {
		const dir = mkdtempSync(join(tmpdir(), "cyrus-loop-pv-"));
		const p = join(dir, "p.md");
		writeFileSync(
			p,
			"---\nversion: scope-v9\n---\n<!-- version: scope-v1 -->\nbody",
		);
		expect(getPromptVersion(p)).toBe("scope-v9");
	});

	it("falls back to an inline comment when there is no frontmatter", () => {
		const dir = mkdtempSync(join(tmpdir(), "cyrus-loop-pv-"));
		const p = join(dir, "p.md");
		writeFileSync(p, "<!-- version: judge-v2 -->\nbody");
		expect(getPromptVersion(p)).toBe("judge-v2");
	});

	it("throws MissingPromptVersion when no tag is present", () => {
		const dir = mkdtempSync(join(tmpdir(), "cyrus-loop-pv-"));
		const p = join(dir, "p.md");
		writeFileSync(p, "no version here");
		expect(() => getPromptVersion(p)).toThrow(MissingPromptVersion);
	});

	it("currentVersions reads the live prompt files", () => {
		expect(currentVersions()).toEqual({
			scope_prompt_version: "scope-v1",
			judge_prompt_version: "judge-v1",
		});
	});
});
