// AccessPolicy — the single owner of a session's effective read/write access.
//
// One deterministic `compute(input)` answers "what may this session read/write"
// and three render adapters project that single answer into each enforcement
// layer:
//   - `toClaudeToolPatterns`  → Claude Code `allowedTools` / `disallowedTools`
//   - `toSandboxFilesystem`   → Claude Agent SDK `SandboxSettings.filesystem`
//   - `toCursorPermissions`   → Cursor `.cursor` hook allow/deny (+ warnings)
//
// `compute` performs NO filesystem or OS calls: `homeDir` and `dirLister` are
// injected, so the policy is fully unit-testable and the cold path
// (ClaudeRunner.start) and warm path (EdgeWorker.warmupSessions) can call the
// identical `compute()` + adapter — closing the historical hand-re-derivation
// drift hole where the two paths could disagree about which home-directory
// reads to deny.
//
// The home-directory sibling-exclusion walk relocated here from
// cyrus-claude-runner's `home-directory-restrictions.ts`; that file now keeps
// only a thin compat wrapper that calls `toClaudeToolPatterns(compute(...))`.

import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** A single directory entry as seen by {@link DirLister}. */
export interface DirEntry {
	name: string;
	isDirectory: boolean;
}

/**
 * Lists the immediate children of a directory. Implementations MUST return an
 * empty array when the directory is unreadable / missing (ENOENT is swallowed),
 * mirroring the original `try { readdirSync } catch { return }` behavior.
 */
export type DirLister = (dir: string) => DirEntry[];

/** Input to {@link compute}. Deterministic given `homeDir` + `dirLister`. */
export interface AccessPolicyInput {
	/** Injected home directory (replaces `os.homedir()`). */
	homeDir: string;
	/** Injected directory lister (replaces `readdirSync` + `statSync`). */
	dirLister: DirLister;
	/** Working directory of the session (the worktree). */
	cwd: string;
	/**
	 * Directories that must remain readable: attachments dir, repository
	 * path(s), git-metadata dirs, extra sub-worktrees, etc.
	 */
	allowReadDirectories: string[];
	/** OS-write roots. Defaults to `[cwd]` when omitted. */
	writeDirectories?: string[];
	/** Config-level `disallowedTools` (non-path tool denials pass through). */
	toolDisallow?: string[];
	/** Config-level `allowedTools` (non-path tool allowances pass through). */
	toolAllowExtra?: string[];
}

/** An enumerated path targeted by a policy, with its directory-ness recorded. */
export interface PolicyPath {
	path: string;
	isDirectory: boolean;
}

/** The single computed answer to "what may this session read/write". */
export interface EffectiveAccessPolicy {
	/** Retained so single-arg adapters can render the `denyRead` root. */
	homeDir: string;
	/** Home siblings NOT on the path to any allowed directory. */
	denyReadPaths: PolicyPath[];
	/**
	 * Directories that get an EXPLICIT read grant rendered into each layer:
	 * `dedup(allowReadDirectories)`. The cwd is deliberately excluded — it is
	 * always readable, so no redundant grant is emitted for it.
	 */
	allowReadPaths: string[];
	/** Absolute directories that may be written: `writeDirectories ?? [cwd]`. */
	allowWritePaths: string[];
	/** Config-level tool denials, passed through verbatim. */
	toolDisallow: string[];
	/** Config-level tool allowances, passed through verbatim. */
	toolAllowExtra: string[];
}

function dedup(values: string[]): string[] {
	return [...new Set(values)];
}

/**
 * Walk the home directory and enumerate every sibling that is NOT on the path
 * to (or equal to) one of the `readSources`. Relocated verbatim (modulo the
 * injected `dirLister`) from `home-directory-restrictions.ts`.
 */
function computeHomeDenials(
	home: string,
	dirLister: DirLister,
	readSources: string[],
): PolicyPath[] {
	// Collect the accessible paths as segment arrays relative to home. Paths
	// outside home are ignored — they cannot restrict anything under home.
	const allRelPaths: string[][] = readSources
		.map((p) => resolve(p))
		.map((p) => relative(home, p))
		.filter((rel) => !rel.startsWith("..") && rel !== "")
		.map((rel) => rel.split("/").filter(Boolean));

	if (allRelPaths.length === 0) {
		return [];
	}

	const denied: PolicyPath[] = [];

	// Recursively process a directory. `relevantPaths` holds the remaining path
	// segments (relative to `dir`) for each allowed destination. An entry in
	// `dir` is denied if it is not an ancestor of any allowed path.
	function processDir(dir: string, relevantPaths: string[][]): void {
		const allowedNames = new Set(
			relevantPaths.map((segs) => segs[0]).filter(Boolean),
		);

		for (const entry of dirLister(dir)) {
			const fullPath = join(dir, entry.name);

			if (allowedNames.has(entry.name)) {
				// Leads toward one or more allowed paths.
				const childPaths = relevantPaths
					.filter((segs) => segs[0] === entry.name)
					.map((segs) => segs.slice(1));

				// If any child path is now empty, this entry IS one of the allowed
				// destinations — its whole subtree is accessible, so don't deny it
				// and don't recurse (no restricted siblings inside).
				if (childPaths.some((segs) => segs.length === 0)) {
					continue;
				}

				// Passthrough directory — recurse to deny its useless siblings.
				processDir(fullPath, childPaths);
				continue;
			}

			// Not on the path to any allowed destination — deny it.
			denied.push({ path: fullPath, isDirectory: entry.isDirectory });
		}
	}

	processDir(home, allRelPaths);

	return denied;
}

/**
 * Compute the effective access policy for a session. Pure and deterministic
 * given `homeDir` + `dirLister`; performs no I/O of its own.
 */
export function compute(input: AccessPolicyInput): EffectiveAccessPolicy {
	const {
		homeDir,
		dirLister,
		cwd,
		allowReadDirectories,
		writeDirectories,
		toolDisallow,
		toolAllowExtra,
	} = input;

	const extraReadDirs = (allowReadDirectories ?? []).filter((p): p is string =>
		Boolean(p),
	);

	// The home-directory sibling-exclusion walk keeps every ancestor of the cwd
	// AND of each extra read directory traversable. `cwd` first, then the extra
	// dirs; a missing working directory degrades gracefully (matches the old
	// `workingDirectory ? ... : []` guard at the cold-path call site).
	const readSources = [cwd, ...extraReadDirs].filter((p): p is string =>
		Boolean(p),
	);
	const denyReadPaths = computeHomeDenials(homeDir, dirLister, readSources);

	// `allowReadPaths` are the directories that get an EXPLICIT read grant
	// rendered into each layer. The cwd is intentionally NOT included: it is
	// always readable (the OS sandbox represents it as ".", and the walk above
	// never denies the path to cwd), so adding a redundant `Read(cwd/**)` grant
	// would change the exact tool-pattern output for no behavioral gain.
	const allowReadPaths = dedup(extraReadDirs);
	const allowWritePaths = dedup(
		(writeDirectories ?? (cwd ? [cwd] : [])).filter((p): p is string =>
			Boolean(p),
		),
	);

	return {
		homeDir,
		denyReadPaths,
		allowReadPaths,
		allowWritePaths,
		toolDisallow: [...(toolDisallow ?? [])],
		toolAllowExtra: [...(toolAllowExtra ?? [])],
	};
}

// ─── Adapter: Claude Code tool patterns ─────────────────────────────────────

export interface ClaudeToolPatterns {
	allowedTools: string[];
	disallowedTools: string[];
}

/**
 * Render the policy into Claude Code `allowedTools` / `disallowedTools`.
 *
 * Two distinct double-slash conventions are preserved EXACTLY:
 *   - deny paths use `/${fullPath}` (from home-directory-restrictions.ts) →
 *     an absolute path like `/home/a/.ssh` renders as `Read(//home/a/.ssh/**)`.
 *   - allow paths use `dir.startsWith('/') ? /${dir} : dir` (from
 *     ClaudeRunner.ts) → same double-slash for absolute, bare for relative.
 */
export function toClaudeToolPatterns(
	p: EffectiveAccessPolicy,
): ClaudeToolPatterns {
	const disallowedTools = dedup([
		...p.toolDisallow,
		...p.denyReadPaths.map((e) =>
			e.isDirectory ? `Read(/${e.path}/**)` : `Read(/${e.path})`,
		),
	]);

	const allowedTools = dedup([
		...p.toolAllowExtra,
		...p.allowReadPaths.map((dir) =>
			dir.startsWith("/") ? `Read(/${dir}/**)` : `Read(${dir}/**)`,
		),
	]);

	return { allowedTools, disallowedTools };
}

// ─── Adapter: Claude Agent SDK sandbox filesystem ───────────────────────────

export interface SandboxFilesystem {
	allowRead: string[];
	denyRead: string[];
	allowWrite: string[];
}

/**
 * Render the policy into the OS-sandbox `filesystem` shape.
 *
 * `denyRead` keeps the literal `'~/'` token: bubblewrap / macOS sandbox honor
 * it as a true deny+whitelist root (confirmed in CLAUDE.md). The injected
 * absolute `homeDir` is used ONLY for the Claude tool-pattern enumeration, not
 * here, so the OS-level deny semantics stay unchanged. `'.'` resolves to the
 * primary folder Claude is working in.
 */
export function toSandboxFilesystem(
	p: EffectiveAccessPolicy,
): SandboxFilesystem {
	return {
		allowRead: dedup([".", ...p.allowReadPaths]),
		denyRead: ["~/"],
		allowWrite: [...p.allowWritePaths],
	};
}

// ─── Adapter: Cursor permissions ────────────────────────────────────────────

export interface CursorPermissions {
	allow: string[];
	deny: string[];
	warnings: string[];
}

/**
 * Render the policy into Cursor `.cursor` hook vocabulary.
 *
 * Cursor's sandbox cannot enforce per-path `denyRead` under its default
 * `workspace_readwrite` profile, so home-directory read denials CANNOT be
 * projected as OS-level denies. Rather than silently dropping them (the old
 * behavior), they are surfaced as `warnings` so the caller can log them and
 * operators understand that the `.cursor` permission hook — not the OS sandbox
 * — is what blocks sensitive reads.
 *
 * `deny` is intentionally left empty: injecting the un-enforceable home denials
 * as hook deny patterns would risk the fail-closed helper blocking legitimate
 * reads. Positive `allow` entries (which can never fail-closed) are emitted for
 * the read directories as additive coverage.
 */
export function toCursorPermissions(
	p: EffectiveAccessPolicy,
): CursorPermissions {
	const warnings: string[] = [];
	if (p.denyReadPaths.length > 0) {
		warnings.push(
			`${p.denyReadPaths.length} home-directory read denial(s) cannot be enforced by Cursor's sandbox under workspace_readwrite; ` +
				"relying on the .cursor permission hook to block sensitive reads instead of OS-level denyRead.",
		);
	}

	const allow = dedup(p.allowReadPaths.map((dir) => `Read(${dir}/**)`));

	return { allow, deny: [], warnings };
}

// ─── Default fs-backed DirLister ────────────────────────────────────────────

/**
 * Default {@link DirLister} backed by `node:fs`. Lists a directory's immediate
 * children and resolves each entry's directory-ness. Returns `[]` when the
 * directory is unreadable (ENOENT swallowed); individual entries whose `stat`
 * fails (e.g. broken symlinks) are dropped, matching the original
 * `home-directory-restrictions.ts` behavior of skipping un-stat-able siblings.
 */
export const nodeDirLister: DirLister = (dir: string): DirEntry[] => {
	let names: string[];
	try {
		names = readdirSync(dir).map((n) => String(n));
	} catch {
		return [];
	}

	const entries: DirEntry[] = [];
	for (const name of names) {
		const full = join(dir, name);
		try {
			entries.push({ name, isDirectory: statSync(full).isDirectory() });
		} catch {
			// Un-stat-able entry (broken symlink, race) — skip, as before.
		}
	}
	return entries;
};
