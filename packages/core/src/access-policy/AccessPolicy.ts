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

// ─── Adapter: OMP tool policy ───────────────────────────────────────────────

/**
 * The OMP permission-policy render: operation names OMP permission requests
 * surface as `allow` / `deny` entries (see {@link renderOmpToolPolicy}).
 */
export interface OmpToolPolicyRender {
	/** OMP operation names that are allowed (lowercase, exact or prefix). */
	allow: string[];
	/** OMP operation names denied (lowercase, exact or prefix). */
	deny: string[];
	/**
	 * Path-scoped denials that cannot be expressed as bare operation names
	 * (e.g. `Read(//home/u/.ssh/**)`). Enforced by matching the permission
	 * request detail; never dropped.
	 */
	denyDetails: { operation: string; needle: string }[];
}

/**
 * OMP's MCP tool-name sanitizer (mirrors OMP's own `xLi`): lowercase,
 * non-alphanumeric/underscore → `_`, collapsed. Server names go through this;
 * tool names keep their real casing/characters.
 */
export function sanitizeOmpServerName(name: string): string {
	const normalized = name
		.toLowerCase()
		.replace(/[^a-z_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	return normalized.length > 0 ? normalized : "server";
}

/**
 * Cyrus built-in tool names → the OMP permission-operation names they map to.
 * OMP surfaces built-ins under ACP tool kinds (`read`, `edit`, `execute`,
 * `search`, `fetch`, …); a Cyrus allow entry must cover the kind its tool
 * triggers. Keys and values are lowercase.
 */
const BUILTIN_TO_OMP_OPERATIONS: Record<string, string[]> = {
	read: ["read"],
	edit: ["edit"],
	write: ["edit"],
	bash: ["execute"],
	grep: ["search"],
	glob: ["search"],
	websearch: ["fetch"],
	webfetch: ["fetch"],
	fetch: ["fetch"],
	think: ["think"],
	task: ["task"],
	taskupdate: ["task"],
	taskget: ["task"],
	todowrite: ["todo"],
	askuserquestion: ["askuserquestion"],
	agent: ["agent"],
	exitplanmode: ["exitplanmode"],
	killshell: ["execute"],
	notebookedit: ["edit"],
};

/**
 * Translate one Cyrus tool name into the OMP operation name(s) a permission
 * request for it surfaces as. MCP names (`mcp__linear__create_attachment`)
 * become OMP's `mcp__<sanitized-server>_<tool>` shape. Unknown built-ins keep
 * their lowercased name (OMP falls back to the real title for those).
 */
export function cyrusToolToOmpOperations(tool: string): string[] {
	const trimmed = tool.trim();
	if (trimmed.length === 0) return [];

	if (trimmed.toLowerCase().startsWith("mcp__")) {
		const rest = trimmed.slice(5);
		const separator = rest.indexOf("_");
		if (separator < 0) {
			return [`mcp__${sanitizeOmpServerName(rest)}`];
		}
		const server = sanitizeOmpServerName(rest.slice(0, separator));
		const toolName = rest.slice(separator).replace(/^_+/, "");
		if (toolName.length === 0) {
			return [`mcp__${server}`];
		}
		return [`mcp__${server}_${toolName.toLowerCase()}`];
	}

	// A path-scoped pattern like `Read(//home/u/.ssh/**)`: the tool name is
	// everything before the first `(`.
	const parenIndex = trimmed.indexOf("(");
	const base = (
		parenIndex >= 0 ? trimmed.slice(0, parenIndex) : trimmed
	).trim();
	const lower = base.toLowerCase();
	const aliased = BUILTIN_TO_OMP_OPERATIONS[lower];
	return aliased ?? (lower.length > 0 ? [lower] : []);
}

/**
 * Render the policy into the OMP permission-policy vocabulary (ADR 0005).
 *
 * The session's tool allow/deny lists (Cyrus names, e.g. `Read`, `Bash`,
 * `mcp__linear_issue`) are translated to the OMP operation names permission
 * requests surface as. Path-scoped denials (the home sibling-exclusion walk
 * plus config `Read(…/**)` patterns) are NOT expressible as bare operations:
 * they are captured as `denyDetails` (matched against the request detail) —
 * an untranslatable denial is a rendering error, never silently dropped.
 */
export function renderOmpToolPolicy(
	policy: EffectiveAccessPolicy,
	toolLists: { allowedTools: string[]; disallowedTools: string[] },
): OmpToolPolicyRender {
	const allow = new Set<string>();
	for (const tool of toolLists.allowedTools ?? []) {
		for (const op of cyrusToolToOmpOperations(tool)) {
			allow.add(op);
		}
	}

	const deny = new Set<string>();
	const denyDetails: { operation: string; needle: string }[] = [];

	const addDeny = (tool: string, source: string): void => {
		const parenIndex = tool.indexOf("(");
		if (parenIndex >= 0) {
			const operations = cyrusToolToOmpOperations(tool);
			if (operations.length === 0) {
				throw new Error(
					`Cannot render OMP tool policy: untranslatable deny pattern "${tool}" (from ${source})`,
				);
			}
			// Path-scoped denial: keep the operation denied only when the request
			// detail names the restricted path.
			const needle = tool
				.slice(parenIndex + 1, tool.lastIndexOf(")"))
				.replace(/^\//, "");
			for (const op of operations) {
				denyDetails.push({ operation: op, needle: needle || tool });
			}
			return;
		}

		const operations = cyrusToolToOmpOperations(tool);
		if (operations.length === 0) {
			throw new Error(
				`Cannot render OMP tool policy: untranslatable deny pattern "${tool}" (from ${source})`,
			);
		}
		for (const op of operations) {
			deny.add(op);
		}
	};

	for (const tool of [...policy.toolDisallow, ...toolLists.disallowedTools]) {
		addDeny(
			tool,
			toolLists.disallowedTools.includes(tool)
				? "session disallowedTools"
				: "policy.toolDisallow",
		);
	}

	return { allow: [...allow], deny: [...deny], denyDetails };
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
