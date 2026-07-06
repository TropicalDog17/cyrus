/**
 * Evidence ledger — deterministic runners only (ported from `pipeline/ledger.py`).
 *
 * The ledger is the ONLY thing the judge may cite. It is written exclusively by the
 * deterministic runners here (never by an LM), append-only, and hashed into the run record
 * (`ledger_sha`) so a verdict is pinned to the exact evidence it saw.
 *
 * E4 diffscan WARNS, never fails: agents legitimately touch files nobody predicted, and a
 * hard fail would feed the judge false alarms on healthy runs.
 *
 * Adaptation note: `runCommand` is async here (Python's is sync). Killing the WHOLE process
 * group on timeout requires a detached spawn + `process.kill(-pid)`; Node's `spawnSync`
 * timeout only reaps the direct child, leaving detached grandchildren alive to contend with
 * the reused retry worktree. Callers run commands sequentially (await), matching the Python
 * single-threaded model.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { loadYaml } from "./config.js";
import { ledgerFile, logsDir } from "./paths.js";
import { canonicalStringify, type LedgerEntry, validate } from "./schemas.js";

const _COMMAND_KINDS = new Set(["tests", "lint", "build", "typecheck"]);
const LOCK_OPTS = { realpath: false, stale: 10_000 } as const;

export interface CommandStep {
	kind: string;
	cmd: string;
}

/**
 * Accumulates deterministic evidence for one run_id. Retries reuse the run_id and APPEND to
 * the same ledger, so construction does NOT truncate — it replays existing entries and starts
 * a new `attempt`. mechanicalResult reflects the LATEST attempt.
 */
export class EvidenceLedger {
	readonly runId: string;
	readonly path: string;
	readonly entries: LedgerEntry[] = [];
	readonly attempt: number;

	constructor(runId: string, opts: { path?: string } = {}) {
		this.runId = runId;
		this.path = opts.path ?? ledgerFile(runId);
		if (existsSync(this.path)) {
			for (const ln of readFileSync(this.path, "utf-8").split("\n")) {
				if (ln.trim()) this.entries.push(JSON.parse(ln) as LedgerEntry);
			}
		}
		const priorAttempts = this.entries.map((e) => e.attempt ?? 1);
		this.attempt =
			priorAttempts.length > 0 ? Math.max(...priorAttempts) + 1 : 1;
	}

	private nextId(): string {
		return `E${this.entries.length + 1}`;
	}

	private append(entry: LedgerEntry): LedgerEntry {
		if (entry.attempt === undefined || entry.attempt === null) {
			entry.attempt = this.attempt;
		}
		validate("ledger", entry, `ledger entry ${entry.id}`);
		this.entries.push(entry);
		// Advisory lock the append so overlapping ledger writers (e.g. a stale first-attempt
		// process) can't interleave partial lines, matching runLog's discipline.
		if (!existsSync(this.path)) closeSync(openSync(this.path, "a", 0o644));
		const release = lockfile.lockSync(this.path, LOCK_OPTS);
		try {
			const fd = openSync(this.path, "a", 0o644);
			try {
				const data = Buffer.from(`${canonicalStringify(entry)}\n`, "utf-8");
				let written = 0;
				while (written < data.length) {
					written += writeSync(fd, data, written, data.length - written);
				}
			} finally {
				closeSync(fd);
			}
		} finally {
			release();
		}
		return entry;
	}

	async runCommand(
		kind: string,
		cmd: string,
		opts: { cwd: string; timeout?: number },
	): Promise<LedgerEntry> {
		const timeout = opts.timeout ?? 900;
		const eid = this.nextId();
		const artifactRel = `${this.runId}/logs/${eid}.txt`;
		const artifactAbs = join(logsDir(this.runId), `${eid}.txt`);

		const res = await spawnCollect(cmd, opts.cwd, timeout);
		let output: string;
		let exitCode: number | null;
		let result: "pass" | "fail";
		let summary: string;
		if (res.timedOut) {
			// Preserve whatever the command printed before it hung — for a hang that's the only
			// diagnostic there is, and it's the failure mode most in need of evidence.
			const partial = res.out + res.err;
			const marker = `(timed out after ${timeout}s)`;
			output = partial ? `${partial}\n${marker}` : marker;
			exitCode = null;
			result = "fail";
			const partialLines = partial
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter(Boolean);
			summary = `timeout after ${timeout}s`;
			if (partialLines.length > 0) {
				summary = `${summary} — last output: ${partialLines[partialLines.length - 1]}`;
			}
			summary = summary.slice(0, 280);
		} else {
			output = res.out + res.err;
			exitCode = res.exitCode;
			result = exitCode === 0 ? "pass" : "fail";
			summary = summarize(output, exitCode);
			if (exitCode === 127) {
				summary = `command not found (check tooling / verify.yaml) — ${summary}`;
			}
		}
		writeFileSync(artifactAbs, output, "utf-8");
		return this.append({
			id: eid,
			kind: kind as LedgerEntry["kind"],
			cmd,
			exit: exitCode,
			result,
			summary,
			artifact: artifactRel,
		});
	}

	/** E4: warn if any changed file is outside filesExpected; else pass. Never fail. */
	diffscan(changedFiles: string[], expectedFiles: string[]): LedgerEntry {
		const eid = this.nextId();
		if (expectedFiles.length === 0) {
			// No scope declared. Flagging every changed file as "outside" would warn on 100%
			// of such runs — the very false alarm E4 exists to avoid.
			return this.append({
				id: eid,
				kind: "diffscan",
				exit: null,
				result: "pass",
				summary: `${changedFiles.length} files; no files_expected declared`,
			});
		}
		const expected = new Set(expectedFiles);
		const outside = changedFiles.filter((f) => !expected.has(f));
		let result: "warn" | "pass";
		let summary: string;
		if (outside.length > 0) {
			result = "warn";
			const preview =
				outside.slice(0, 5).join(", ") + (outside.length > 5 ? "…" : "");
			summary = `${changedFiles.length} files; ${outside.length} outside spec.files_expected: ${preview}`;
		} else {
			result = "pass";
			summary = `${changedFiles.length} files, all within spec.files_expected`;
		}
		return this.append({
			id: eid,
			kind: "diffscan",
			exit: null,
			result,
			summary,
		});
	}

	/**
	 * pass iff every command runner (tests/lint/build/typecheck) in the LATEST attempt passed.
	 * Earlier attempts' failures stay as evidence but don't gate the current verdict; diffscan
	 * warns never gate it either.
	 */
	mechanicalResult(): "pass" | "fail" | "skip" {
		const cmds = this.entries.filter(
			(e) => _COMMAND_KINDS.has(e.kind) && (e.attempt ?? 1) === this.attempt,
		);
		if (cmds.length === 0) return "skip";
		return cmds.every((e) => e.result === "pass") ? "pass" : "fail";
	}

	/** The LATEST attempt's diffscan verdict (warn | pass | skip). */
	diffscanResult(): "warn" | "pass" | "skip" {
		const scans = this.entries.filter(
			(e) => e.kind === "diffscan" && (e.attempt ?? 1) === this.attempt,
		);
		if (scans.length === 0) return "skip";
		return scans.some((e) => e.result === "warn") ? "warn" : "pass";
	}

	sha256(): string {
		return createHash("sha256").update(readFileSync(this.path)).digest("hex");
	}
}

interface SpawnResult {
	out: string;
	err: string;
	exitCode: number | null;
	timedOut: boolean;
}

function killGroup(child: ChildProcess): void {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, "SIGKILL"); // negative pid → the whole process group
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return; // the group already exited — nothing to kill
		try {
			child.kill("SIGKILL"); // fall back to the direct process only
		} catch {
			/* ignore */
		}
		console.error(
			`warning: group-kill of pid ${child.pid} failed (${e}); killed only the direct ` +
				"process — a detached child may survive into the reused worktree",
		);
	}
}

function spawnCollect(
	cmd: string,
	cwd: string,
	timeoutSec: number,
): Promise<SpawnResult> {
	return new Promise((resolve) => {
		// detached:true → the child leads its own process group (setsid), so a timeout can
		// SIGKILL the WHOLE tree via process.kill(-pid).
		const child = spawn(cmd, {
			shell: true,
			cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout?.on("data", (d) => {
			out += d.toString();
		});
		child.stderr?.on("data", (d) => {
			err += d.toString();
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(child);
		}, timeoutSec * 1000);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ out, err, exitCode: code, timedOut });
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ out, err: err + String(e), exitCode: 127, timedOut });
		});
	});
}

const _FAIL_MARKERS =
	/(?:\b(?:error|fail(?:ed|ure)?|exception|assert\w*)\b|:\d+:)/i;

/**
 * A citable one-liner for the ledger. On failure, prefer lines that actually NAME the failure
 * (error/fail/file:line) over the last line, which for many tools is just a count.
 */
export function summarize(
	output: string,
	exitCode: number | null,
	limit = 280,
): string {
	const lines = output
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	let prefix: string;
	if (exitCode === 0) prefix = "ok";
	else if (exitCode === null) prefix = "no-exit";
	else prefix = `exit ${exitCode}`;
	if (lines.length === 0) return prefix;
	let body: string;
	if (exitCode === 0) {
		body = lines[lines.length - 1]!;
	} else {
		const marked = lines.filter((l) => _FAIL_MARKERS.test(l));
		body = (marked.length > 0 ? marked : lines).slice(-3).join(" | ");
	}
	return `${prefix}: ${body}`.slice(0, limit);
}

/**
 * A ref usable as a diff base inside `repoDir`. A Cyrus git worktree has NO local ref for the
 * base branch (only the remote-tracking `origin/<base>`), so try the local name, then
 * `origin/<base>`. Returns null if `base` is falsy or neither resolves.
 */
export function resolveBaseRef(
	repoDir: string,
	base: string | null,
): string | null {
	if (!base) return null;
	for (const ref of [base, `origin/${base}`]) {
		const proc = spawnSync(
			"git",
			["-C", repoDir, "rev-parse", "--verify", "--quiet", ref],
			{ encoding: "utf-8" },
		);
		if (proc.status === 0) return ref;
	}
	return null;
}

function gitDiffRef(repoDir: string, base: string | null): string {
	const ref = resolveBaseRef(repoDir, base);
	return ref ? `${ref}...HEAD` : "HEAD";
}

/**
 * Files changed on the worktree branch relative to base (or working tree). `--relative` makes
 * paths relative to repoDir, so a monorepo subdir checkout's paths match a filesExpected list
 * authored relative to that subdir (else E4 warns on every file).
 */
export function gitChangedFiles(
	repoDir: string,
	base: string | null,
): string[] {
	const ref = gitDiffRef(repoDir, base);
	const proc = spawnSync(
		"git",
		["-C", repoDir, "diff", "--name-only", "--relative", ref],
		{ encoding: "utf-8" },
	);
	return (proc.stdout ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

/** {files, loc} for the run's diff via `git diff --numstat`; loc = added + deleted. */
export function gitDiffStats(
	repoDir: string,
	base: string | null,
): { files: number; loc: number } {
	const ref = gitDiffRef(repoDir, base);
	const proc = spawnSync(
		"git",
		["-C", repoDir, "diff", "--numstat", "--relative", ref],
		{ encoding: "utf-8" },
	);
	let files = 0;
	let loc = 0;
	for (const ln of (proc.stdout ?? "").split("\n")) {
		const parts = ln.split("\t");
		if (parts.length >= 3) {
			files += 1;
			const add = parts[0]!;
			const del = parts[1]!;
			loc +=
				(/^\d+$/.test(add) ? Number(add) : 0) +
				(/^\d+$/.test(del) ? Number(del) : 0);
		}
	}
	return { files, loc };
}

export interface LedgerSummary {
	ledger_sha: string | null;
	mechanical: "pass" | "fail" | "skip";
	diffscan: "warn" | "pass" | "skip";
	entries: LedgerEntry[];
}

/**
 * Read-only view of an EXISTING ledger — sha + latest-attempt mechanical/diffscan — WITHOUT
 * constructing an EvidenceLedger (which would bump `attempt` and make the attempt-scoped
 * accessors report `skip`). For `learn`, which reads finished runs.
 */
export function ledgerSummary(runId: string): LedgerSummary {
	const path = ledgerFile(runId);
	if (!existsSync(path)) {
		return {
			ledger_sha: null,
			mechanical: "skip",
			diffscan: "skip",
			entries: [],
		};
	}
	const entries = readFileSync(path, "utf-8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as LedgerEntry);
	const latest = entries.reduce((m, e) => Math.max(m, e.attempt ?? 1), 1);
	const cmds = entries.filter(
		(e) => _COMMAND_KINDS.has(e.kind) && (e.attempt ?? 1) === latest,
	);
	const scans = entries.filter(
		(e) => e.kind === "diffscan" && (e.attempt ?? 1) === latest,
	);
	const mechanical =
		cmds.length === 0
			? "skip"
			: cmds.every((e) => e.result === "pass")
				? "pass"
				: "fail";
	const diffscan =
		scans.length === 0
			? "skip"
			: scans.some((e) => e.result === "warn")
				? "warn"
				: "pass";
	return {
		ledger_sha: createHash("sha256").update(readFileSync(path)).digest("hex"),
		mechanical,
		diffscan,
		entries,
	};
}

/**
 * {files, loc} parsed from a saved unified diff — so `learn` can fill diff_stats after the
 * worktree is gone. loc counts +/- content lines (excluding the +++/--- file headers).
 */
export function diffStatsFromFile(
	diffPath: string,
): { files: number; loc: number } | null {
	if (!existsSync(diffPath)) return null;
	let files = 0;
	let loc = 0;
	let inHunk = false;
	for (const ln of readFileSync(diffPath, "utf-8").split(/\r?\n/)) {
		if (ln.startsWith("diff --git ")) {
			files += 1;
			inHunk = false;
		} else if (ln.startsWith("@@")) {
			inHunk = true; // everything after the hunk header is content until the next file
		} else if (inHunk && (ln[0] === "+" || ln[0] === "-")) {
			// Inside a hunk a leading +/- is unambiguously an added/removed CONTENT line —
			// counting by structural position avoids miscounting content that itself starts
			// with '---'/'+++' (a SQL '-- comment', a YAML '---') as a file header.
			loc += 1;
		}
	}
	return { files, loc };
}

export function verifyCommands(repo: string): CommandStep[] {
	const cfg = loadYaml("verify.yaml") as {
		repos?: Record<string, CommandStep[]>;
		default?: CommandStep[];
	};
	return cfg.repos?.[repo] ?? cfg.default ?? [];
}

/**
 * True when `repo` has no explicit verify.yaml entry and falls back to `default` (make
 * test/lint/build) — which silently fails for a non-make repo.
 */
export function usesDefaultVerify(repo: string): boolean {
	const cfg = loadYaml("verify.yaml") as { repos?: Record<string, unknown> };
	return !(repo in (cfg.repos ?? {}));
}

export interface RunLedgerResult {
	run_id: string;
	ledger_path: string;
	ledger_sha: string;
	mechanical: "pass" | "fail" | "skip";
	diffscan: "warn" | "pass" | "skip";
	diff_stats: { files: number; loc: number };
	entries: LedgerEntry[];
}

/**
 * Run all mechanical checks + diffscan for a run; return a summary dict.
 *
 * `extraFilesExpected` is unioned into the spec's `Files expected` before the E4 scan — this
 * is where approved spec amendments (files_expected_added) enter.
 */
export async function runLedger(
	runId: string,
	repo: string,
	repoDir: string,
	base: string | null,
	specText: string,
	opts: { extraFilesExpected?: string[] } = {},
): Promise<RunLedgerResult> {
	// Lazy import breaks the ledger→spec load-time coupling (and any cycle risk); spec is
	// only needed when actually running a full ledger pass.
	const { filesExpected } = await import("./spec.js");
	const led = new EvidenceLedger(runId);
	for (const step of verifyCommands(repo)) {
		await led.runCommand(step.kind, step.cmd, { cwd: repoDir });
	}
	const expected = [
		...filesExpected(specText),
		...(opts.extraFilesExpected ?? []),
	];
	led.diffscan(gitChangedFiles(repoDir, base), expected);
	return {
		run_id: runId,
		ledger_path: led.path,
		ledger_sha: led.sha256(),
		mechanical: led.mechanicalResult(),
		diffscan: led.diffscanResult(),
		diff_stats: gitDiffStats(repoDir, base),
		entries: led.entries,
	};
}
