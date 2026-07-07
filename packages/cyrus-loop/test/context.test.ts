import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	buildBundle,
	ensureFailuresFile,
	GLOBAL_NAME,
	repoFailuresPath,
} from "../src/context.js";
import { failuresDir } from "../src/paths.js";

// No tests/test_context.py existed; these are derived from context.py's documented invariants:
// AGENTS.md first, the repo failures file pinned by a content hash, and _global.md riding along
// ONLY for non-work repos. Each test gets an isolated runtime data dir so failures files start
// empty and never touch the real ~/.cyrus/loop.
const ORIG_DATA = process.env.AGENTIC_PIPELINE_DATA;

beforeEach(() => {
	process.env.AGENTIC_PIPELINE_DATA = mkdtempSync(
		join(tmpdir(), "cyrus-loop-ctx-"),
	);
});

afterAll(() => {
	if (ORIG_DATA === undefined) delete process.env.AGENTIC_PIPELINE_DATA;
	else process.env.AGENTIC_PIPELINE_DATA = ORIG_DATA;
});

describe("buildBundle", () => {
	it("lists AGENTS.md first, then the repo failures file pinned by content hash", () => {
		const b = buildBundle("myrepo", { work_repos: [] });
		expect(b.manifest[0]).toBe("AGENTS.md");
		expect(b.manifest[1]).toMatch(/^failures\/myrepo\.md@[0-9a-f]{8}$/);
		expect(b.files[0]).toBe(repoFailuresPath("myrepo"));
	});

	it("pins the content hash to the first 8 hex of the file's sha256", () => {
		// Pre-create the repo failures file with known content so ensure* won't overwrite it.
		const p = join(failuresDir(), "hashrepo.md");
		writeFileSync(p, "known content\n", "utf-8");
		const b = buildBundle("hashrepo", { work_repos: [] });
		const expectedHash = createHash("sha256")
			.update(readFileSync(p))
			.digest("hex")
			.slice(0, 8);
		expect(b.manifest).toContain(`failures/hashrepo.md@${expectedHash}`);
	});

	it("includes _global.md ONLY for non-work repos", () => {
		writeFileSync(join(failuresDir(), GLOBAL_NAME), "global rules\n", "utf-8");

		const personal = buildBundle("personalrepo", {
			work_repos: ["work-monorepo"],
		});
		expect(
			personal.manifest.some((m) => m.startsWith(`failures/${GLOBAL_NAME}@`)),
		).toBe(true);
		expect(personal.text).toContain("global rules");

		// A work repo loads ONLY its own failures file — never the personal _global.md.
		const work = buildBundle("work-monorepo", {
			work_repos: ["work-monorepo"],
		});
		expect(
			work.manifest.some((m) => m.startsWith(`failures/${GLOBAL_NAME}@`)),
		).toBe(false);
		expect(work.text).not.toContain("global rules");
	});
});

describe("ensureFailuresFile", () => {
	it("creates the repo file from the template with <repo> substituted", () => {
		const p = ensureFailuresFile("myrepo");
		const content = readFileSync(p, "utf-8");
		expect(content.startsWith("# Failure rules")).toBe(true);
		expect(content).toContain("myrepo");
		expect(content).not.toContain("<repo>");
	});
});
