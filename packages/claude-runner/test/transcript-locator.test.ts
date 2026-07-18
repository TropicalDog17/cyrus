import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findTranscriptPath } from "../src/transcript-locator.js";

describe("findTranscriptPath", () => {
	let baseDir: string;

	beforeEach(async () => {
		baseDir = await mkdtemp(join(tmpdir(), "cyrus-locator-"));
	});

	afterEach(async () => {
		await rm(baseDir, { recursive: true, force: true });
	});

	async function seedProject(slug: string, files: string[]) {
		const dir = join(baseDir, "projects", slug);
		await mkdir(dir, { recursive: true });
		for (const file of files) {
			await writeFile(join(dir, file), "{}\n");
		}
		return dir;
	}

	test("finds a transcript nested under projects/<slug>/", async () => {
		const dir = await seedProject("-home-user-repo", [
			"session-abc.jsonl",
			"session-def.jsonl",
		]);

		const found = await findTranscriptPath("session-abc", baseDir);
		expect(found).toBe(join(dir, "session-abc.jsonl"));
	});

	test("scans across multiple project directories", async () => {
		await seedProject("-home-user-repo-a", ["other.jsonl"]);
		const target = await seedProject("-home-user-repo-b", ["wanted.jsonl"]);

		const found = await findTranscriptPath("wanted", baseDir);
		expect(found).toBe(join(target, "wanted.jsonl"));
	});

	test("returns null when the session transcript is absent", async () => {
		await seedProject("-home-user-repo", ["session-abc.jsonl"]);

		const found = await findTranscriptPath("does-not-exist", baseDir);
		expect(found).toBeNull();
	});

	test("returns null when projects/ does not exist", async () => {
		const found = await findTranscriptPath("anything", baseDir);
		expect(found).toBeNull();
	});
});
