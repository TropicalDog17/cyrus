import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Locate the on-disk transcript for a Claude Code session.
 *
 * Claude Code writes each session to
 * `~/.claude/projects/<sanitized-cwd-slug>/<sessionId>.jsonl`. The slug is
 * derived from the session's working directory via an undocumented
 * sanitization rule, so rather than reconstruct that path we scan the two-level
 * `projects/*` tree for the `<sessionId>.jsonl` file directly. This is robust
 * to the sanitization rule changing between Claude Code versions.
 *
 * @param claudeSessionId The Claude session ID (transcript file basename).
 * @param baseDir Override for `~/.claude` (primarily for tests).
 * @returns Absolute path to the transcript, or `null` if not found.
 */
export async function findTranscriptPath(
	claudeSessionId: string,
	baseDir: string = join(homedir(), ".claude"),
): Promise<string | null> {
	const projectsDir = join(baseDir, "projects");
	const target = `${claudeSessionId}.jsonl`;

	let projectDirs: string[];
	try {
		const entries = await readdir(projectsDir, { withFileTypes: true });
		projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		// projects/ missing or unreadable — nothing to locate.
		return null;
	}

	for (const projectDir of projectDirs) {
		const dirPath = join(projectsDir, projectDir);
		let files: string[];
		try {
			files = await readdir(dirPath);
		} catch {
			continue;
		}
		if (files.includes(target)) {
			return join(dirPath, target);
		}
	}

	return null;
}
