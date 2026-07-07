/**
 * Durable, concurrency-safe append to runs.jsonl — the ONLY writer of that file.
 * Ported from `pipeline/append_run.py`.
 *
 * Safety recipe (adapted from the Python/POSIX original to Node):
 *   * Every mutation is FULLY SYNCHRONOUS (openSync/writeSync/fsyncSync). Node's event
 *     loop cannot preempt synchronous code, so two "concurrent" appends from the same
 *     process can never interleave — the first runs to completion before the second
 *     starts. This replaces the Python in-process discipline; no async mutex is needed.
 *   * `proper-lockfile` advisory lock (`<file>.lock`) is the cross-process belt-and-
 *     suspenders for the occasional separate CLI invocation. It is uncontended in-process
 *     (the sync body already serializes us), so it acquires immediately.
 *   * `fsyncSync` after the write. NOTE: Node has no `F_FULLFSYNC`, so on macOS this
 *     reaches the drive cache but not necessarily through it — weaker than the Python
 *     original's `fcntl(F_FULLFSYNC)`. Acceptable for our single-process loop; documented.
 *   * validate BEFORE taking the lock, to keep lock hold time minimal and never touch the
 *     file for an invalid record.
 *
 * Never point runs.jsonl at a cloud-synced folder (iCloud/Dropbox): sync clients replace
 * files via temp-then-rename and will corrupt an open append target.
 */

import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { runsFile } from "./paths.js";
import {
	canonicalStringify,
	formatErrors,
	type RunRecord,
	SchemaValidationError,
	validate,
} from "./schemas.js";

const _SCHEMA = "runs" as const;

// The sync lock API forbids `retries`. It's uncontended in-process anyway: our fully
// synchronous append body already serializes same-process writers (the event loop cannot
// preempt sync code), so the advisory lock only ever guards a rare separate CLI process.
const LOCK_OPTS = {
	realpath: false,
	stale: 10_000,
} as const;

function writeAll(fd: number, data: Buffer, position?: number): void {
	let written = 0;
	while (written < data.length) {
		written += writeSync(
			fd,
			data,
			written,
			data.length - written,
			position === undefined ? null : position + written,
		);
	}
}

function fsyncDurable(fd: number): void {
	// Node has no F_FULLFSYNC; this reaches the drive cache only (see file header note).
	fsyncSync(fd);
}

/** Validate `record` against the runs schema, then atomically append one line. */
export function appendRun(
	record: RunRecord,
	opts: { path?: string; fsync?: boolean } = {},
): void {
	const fsync = opts.fsync ?? true;
	validate(
		_SCHEMA,
		record,
		`run ${(record as { run_id?: string }).run_id ?? "<no run_id>"}`,
	);

	const path = opts.path ?? runsFile();
	const line = `${canonicalStringify(record)}\n`;
	// canonicalStringify escapes embedded newlines to \n, so exactly one physical line.
	if (line.slice(0, -1).includes("\n")) {
		throw new Error("record serialized to more than one line");
	}
	const data = Buffer.from(line, "utf-8");

	mkdirSync(dirname(path), { recursive: true });
	// Touch so the advisory lock has a target even for the very first append.
	if (!existsSync(path)) closeSync(openSync(path, "a", 0o644));

	const release = lockfile.lockSync(path, LOCK_OPTS);
	try {
		// O_RDWR|O_APPEND (a+) so we can pread the last byte for the newline guard.
		const fd = openSync(path, "a+", 0o644);
		try {
			// Newline guard: if a crashed writer left a torn fragment with no trailing
			// newline, appending would glue our record onto it, and readRuns would then
			// discard the whole merged line as a "torn last line" — silently losing THIS
			// good record and every future one. Isolate the fragment on its own line.
			const size = fstatSync(fd).size;
			if (size > 0) {
				const last = Buffer.alloc(1);
				readSync(fd, last, 0, 1, size - 1);
				if (last[0] !== 0x0a) writeAll(fd, Buffer.from("\n"));
			}
			writeAll(fd, data);
			if (fsync) fsyncDurable(fd);
		} finally {
			closeSync(fd);
		}
	} finally {
		release();
	}
}

/**
 * Read + validate every run record. Tolerates a torn LAST line (the only line a
 * crashed/concurrent writer can leave partial). Mid-file corruption is a different
 * failure class and THROWS — silently skipping it would hide a real bug.
 */
export function readRuns(
	opts: { path?: string; skipInvalid?: boolean } = {},
): RunRecord[] {
	const path = opts.path ?? runsFile();
	const skipInvalid = opts.skipInvalid ?? false;
	if (!existsSync(path)) return [];

	const raw = readFileSync(path, "utf-8");
	const lines = raw.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const records: RunRecord[] = [];
	const last = lines.length - 1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim();
		if (!line) continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch (e) {
			if (i === last) {
				console.warn(
					`${path}: skipping torn last line (${e}); likely a crashed/concurrent writer`,
				);
				continue;
			}
			throw new Error(
				`${path}: corrupt line ${i + 1} (not the last line): ${e}`,
			);
		}
		const errors = formatErrors(_SCHEMA, record);
		if (errors.length > 0) {
			const msg = `${path}: line ${i + 1} failed schema validation:\n  ${errors.join(
				"\n  ",
			)}`;
			if (skipInvalid) {
				console.warn(msg);
				continue;
			}
			throw new SchemaValidationError(msg);
		}
		records.push(record as RunRecord);
	}
	return records;
}

/**
 * Backfill fields on an existing run (e.g. rework linkage). Rare, and the only non-append
 * mutation of runs.jsonl.
 *
 * Durability: we CANNOT rename a temp file over runs.jsonl — a blocked appender holding an
 * fd on the old inode would resume writing to the orphaned inode (lost write). So the append
 * target must keep its inode. We (1) stage the full rewritten content to a sibling temp file
 * and fsync it, then (2) truncate + rewrite the real file in place under the lock and fsync.
 * The temp file is deleted only on success; a crash in (2) leaves it as a recoverable copy.
 */
export function updateRun(
	runId: string,
	patch: Partial<RunRecord>,
	opts: { path?: string } = {},
): RunRecord {
	const path = opts.path ?? runsFile();
	const fd = openSync(path, "r+"); // O_RDWR; throws if missing, like the Python original
	let release: (() => void) | undefined;
	try {
		release = lockfile.lockSync(path, LOCK_OPTS);
		const raw = readFileSync(path, "utf-8");
		const lines = raw.split("\n").filter((ln) => ln.trim());
		let found: RunRecord | null = null;
		const out: string[] = [];
		const last = lines.length - 1;
		for (let i = 0; i < lines.length; i++) {
			let rec: Record<string, unknown>;
			try {
				rec = JSON.parse(lines[i]!);
			} catch (e) {
				if (i === last) {
					// torn tail from a crashed appender — drop it, as readRuns does
					console.warn(
						`${path}: dropping torn last line during updateRun (${e})`,
					);
					continue;
				}
				throw new Error(
					`${path}: corrupt line ${i + 1} (not the last line): ${e}`,
				);
			}
			if (rec.run_id === runId) {
				rec = { ...rec, ...patch };
				validate(_SCHEMA, rec, `run ${runId} (after patch)`);
				found = rec as RunRecord;
			}
			out.push(canonicalStringify(rec));
		}
		if (found === null) {
			throw new Error(`run_id ${runId} not found in ${path}`);
		}
		const newBytes = Buffer.from(`${out.join("\n")}\n`, "utf-8");

		// (1) stage to a durable temp copy first — the recovery source for a crash in (2).
		const tmp = `${path}.rewrite.tmp`;
		const tfd = openSync(tmp, "w", 0o644);
		try {
			writeAll(tfd, newBytes);
			fsyncDurable(tfd);
		} finally {
			closeSync(tfd);
		}

		// (2) truncate + rewrite the real file in place (same inode), then fsync.
		ftruncateSync(fd, 0);
		writeAll(fd, newBytes, 0);
		fsyncDurable(fd);
		unlinkSync(tmp); // only on success; a crash leaves it as a recoverable copy
		return found;
	} finally {
		if (release) release();
		closeSync(fd);
	}
}

export interface RepairSummary {
	kept: number;
	quarantined: number;
	quarantinePath: string | null;
}

/**
 * Quarantine corrupt lines and rewrite runs.jsonl with only valid records. A crashed
 * writer's isolated fragment (or any schema-invalid line) becomes fatal for readRuns/updateRun
 * the moment a later append pushes it off the last line — bricking every command until a human
 * hand-edits the file. This is that recovery path: it moves every non-JSON / schema-invalid
 * line into a `<file>.corrupt` sidecar and rewrites the file with the survivors, under the lock
 * and on the same inode.
 */
export function repairRuns(opts: { path?: string } = {}): RepairSummary {
	const path = opts.path ?? runsFile();
	if (!existsSync(path)) {
		return { kept: 0, quarantined: 0, quarantinePath: null };
	}
	const fd = openSync(path, "r+");
	let release: (() => void) | undefined;
	try {
		release = lockfile.lockSync(path, LOCK_OPTS);
		const lines = readFileSync(path, "utf-8")
			.split("\n")
			.filter((ln) => ln.trim());
		const kept: string[] = [];
		const bad: string[] = [];
		for (const ln of lines) {
			let rec: unknown;
			try {
				rec = JSON.parse(ln);
			} catch {
				bad.push(ln);
				continue;
			}
			if (formatErrors(_SCHEMA, rec).length > 0) {
				bad.push(ln);
			} else {
				kept.push(canonicalStringify(rec));
			}
		}
		let quarantinePath: string | null = null;
		if (bad.length > 0) {
			quarantinePath = `${path}.corrupt`;
			// Durable append — the sidecar is the only record of the quarantined lines.
			const qfd = openSync(quarantinePath, "a", 0o644);
			try {
				writeAll(qfd, Buffer.from(`${bad.join("\n")}\n`, "utf-8"));
				fsyncDurable(qfd);
			} finally {
				closeSync(qfd);
			}
			const newBytes = Buffer.from(
				kept.length > 0 ? `${kept.join("\n")}\n` : "",
				"utf-8",
			);
			const tmp = `${path}.rewrite.tmp`; // recovery source if we crash
			const tfd = openSync(tmp, "w", 0o644);
			try {
				writeAll(tfd, newBytes);
				fsyncDurable(tfd);
			} finally {
				closeSync(tfd);
			}
			ftruncateSync(fd, 0);
			writeAll(fd, newBytes, 0);
			fsyncDurable(fd);
			unlinkSync(tmp);
		}
		return {
			kept: kept.length,
			quarantined: bad.length,
			quarantinePath,
		};
	} finally {
		if (release) release();
		closeSync(fd);
	}
}
