import { describe, expect, it } from "vitest";
import {
	compute,
	type DirEntry,
	type DirLister,
	type EffectiveAccessPolicy,
	toClaudeToolPatterns,
	toCursorPermissions,
	toSandboxFilesystem,
} from "../src/access-policy/AccessPolicy.js";

// ─── In-memory filesystem DSL (NO vi.mock — dirLister is injected) ───────────

type FsEntry = { kind: "dir"; children: FsTree } | { kind: "file" };
type FsTree = Record<string, FsEntry>;

const dir = (children: FsTree = {}): FsEntry => ({ kind: "dir", children });
const file = (): FsEntry => ({ kind: "file" });

/** Build a deterministic DirLister over an in-memory tree rooted at `home`. */
function makeDirLister(home: string, tree: FsTree): DirLister {
	const dirs = new Map<string, DirEntry[]>();

	function populate(path: string, entry: FsEntry): void {
		if (entry.kind === "file") return;
		const entries: DirEntry[] = [];
		for (const [name, child] of Object.entries(entry.children)) {
			entries.push({ name, isDirectory: child.kind === "dir" });
			populate(`${path}/${name}`, child);
		}
		dirs.set(path, entries);
	}

	const rootEntries: DirEntry[] = [];
	for (const [name, child] of Object.entries(tree)) {
		rootEntries.push({ name, isDirectory: child.kind === "dir" });
		populate(`${home}/${name}`, child);
	}
	dirs.set(home, rootEntries);

	return (d: string): DirEntry[] => dirs.get(d) ?? [];
}

// ─── Deny/allow assertion DSL over the computed policy ───────────────────────

const HOME = "/home/alice";

function denyReadHas(p: EffectiveAccessPolicy, relPath: string): boolean {
	const abs = `${HOME}/${relPath}`;
	return p.denyReadPaths.some((e) => e.path === abs);
}

class Assertions {
	constructor(private readonly policy: EffectiveAccessPolicy) {}
	denies(relPath: string): this {
		expect(
			denyReadHas(this.policy, relPath),
			`"${relPath}" should be denied`,
		).toBe(true);
		return this;
	}
	allows(relPath: string): this {
		expect(
			denyReadHas(this.policy, relPath),
			`"${relPath}" should not be denied`,
		).toBe(false);
		return this;
	}
}
const check = (p: EffectiveAccessPolicy) => new Assertions(p);

function computeIn(
	tree: FsTree,
	cwd: string,
	allowReadDirectories: string[] = [],
): EffectiveAccessPolicy {
	return compute({
		homeDir: HOME,
		dirLister: makeDirLister(HOME, tree),
		cwd,
		allowReadDirectories,
	});
}

// ─── compute(): home-directory sibling exclusion ─────────────────────────────

describe("compute — single cwd", () => {
	it("denies everything in home that is not an ancestor of cwd", () => {
		const policy = computeIn(
			{
				".ssh": dir({ id_rsa: file() }),
				".aws": dir({ credentials: file() }),
				".gitconfig": file(),
				Documents: dir(),
				".cyrus": dir({ worktrees: dir({ "ENG-1": dir({ repo: dir() }) }) }),
			},
			`${HOME}/.cyrus/worktrees/ENG-1/repo`,
		);

		check(policy)
			.denies(".ssh")
			.denies(".aws")
			.denies(".gitconfig")
			.denies("Documents")
			.allows(".cyrus")
			.allows(".cyrus/worktrees")
			.allows(".cyrus/worktrees/ENG-1")
			.allows(".cyrus/worktrees/ENG-1/repo");
	});

	it("denies siblings at every level of the path, not just at home", () => {
		const policy = computeIn(
			{
				".cyrus": dir({
					worktrees: dir({
						"ENG-1": dir({ repo: dir() }),
						"ENG-2": dir({ repo: dir() }),
					}),
					certs: dir(),
					logs: dir(),
				}),
				".gitconfig": file(),
			},
			`${HOME}/.cyrus/worktrees/ENG-1/repo`,
		);

		check(policy)
			.denies(".gitconfig")
			.denies(".cyrus/certs")
			.denies(".cyrus/logs")
			.denies(".cyrus/worktrees/ENG-2")
			.allows(".cyrus")
			.allows(".cyrus/worktrees")
			.allows(".cyrus/worktrees/ENG-1")
			.allows(".cyrus/worktrees/ENG-1/repo");
	});

	it("records directory-ness so files and dirs render differently", () => {
		const policy = computeIn(
			{
				".ssh": dir({ id_rsa: file() }),
				".gitconfig": file(),
				".cyrus": dir({ "ENG-1": dir() }),
			},
			`${HOME}/.cyrus/ENG-1`,
		);

		const ssh = policy.denyReadPaths.find((e) => e.path === `${HOME}/.ssh`);
		const gitconfig = policy.denyReadPaths.find(
			(e) => e.path === `${HOME}/.gitconfig`,
		);
		expect(ssh?.isDirectory).toBe(true);
		expect(gitconfig?.isDirectory).toBe(false);
	});

	it("returns no home denials when cwd is outside home", () => {
		const policy = computeIn({ ".ssh": dir() }, "/tmp/some-repo");
		expect(policy.denyReadPaths).toEqual([]);
	});
});

describe("compute — with allowReadDirectories", () => {
	it("allows the attachments dir even though it is a sibling of worktrees", () => {
		const tree: FsTree = {
			".ssh": dir({ id_rsa: file() }),
			".cyrus": dir({
				worktrees: dir({ "ENG-1": dir({ repo: dir() }) }),
				"ENG-1": dir({ attachments: dir() }),
				certs: dir(),
			}),
		};
		const cwd = `${HOME}/.cyrus/worktrees/ENG-1/repo`;
		const attachments = `${HOME}/.cyrus/ENG-1/attachments`;
		const policy = computeIn(tree, cwd, [attachments]);

		check(policy)
			.denies(".ssh")
			.denies(".cyrus/certs")
			.allows(".cyrus/worktrees/ENG-1/repo")
			.allows(".cyrus/ENG-1")
			.allows(".cyrus/ENG-1/attachments");
	});

	it("allows multiple disjoint additional paths within home", () => {
		const tree: FsTree = {
			".ssh": dir(),
			".aws": dir(),
			repos: dir({
				"project-a": dir(),
				"project-b": dir(),
				"project-c": dir(),
			}),
			".cyrus": dir({ "ENG-1": dir({ attachments: dir() }) }),
		};
		const policy = computeIn(tree, `${HOME}/repos/project-a`, [
			`${HOME}/.cyrus/ENG-1/attachments`,
			`${HOME}/repos/project-b`,
		]);

		check(policy)
			.denies(".ssh")
			.denies(".aws")
			.denies("repos/project-c")
			.allows("repos/project-a")
			.allows("repos/project-b")
			.allows(".cyrus/ENG-1/attachments");
	});

	it("ignores additional paths outside home", () => {
		const policy = computeIn(
			{
				".ssh": dir(),
				".cyrus": dir({ worktrees: dir({ "ENG-1": dir({ repo: dir() }) }) }),
			},
			`${HOME}/.cyrus/worktrees/ENG-1/repo`,
			["/tmp/outside-home"],
		);

		check(policy).denies(".ssh").allows(".cyrus/worktrees/ENG-1/repo");
	});
});

describe("compute — read/write path aggregation", () => {
	it("allowReadPaths is the deduped read directories, excluding cwd", () => {
		const policy = compute({
			homeDir: HOME,
			dirLister: () => [],
			cwd: "/ws/root",
			allowReadDirectories: ["/repos/a", "/repos/b", "/repos/a"],
		});
		// cwd is NOT folded in — it is always readable and needs no grant.
		expect(policy.allowReadPaths).toEqual(["/repos/a", "/repos/b"]);
	});

	it("allowWritePaths defaults to [cwd]", () => {
		const policy = compute({
			homeDir: HOME,
			dirLister: () => [],
			cwd: "/ws/root",
			allowReadDirectories: [],
		});
		expect(policy.allowWritePaths).toEqual(["/ws/root"]);
	});

	it("allowWritePaths honors an explicit writeDirectories override", () => {
		const policy = compute({
			homeDir: HOME,
			dirLister: () => [],
			cwd: "/ws/root",
			allowReadDirectories: [],
			writeDirectories: ["/ws/root", "/ws/extra"],
		});
		expect(policy.allowWritePaths).toEqual(["/ws/root", "/ws/extra"]);
	});
});

// ─── Adapters ────────────────────────────────────────────────────────────────

describe("toClaudeToolPatterns", () => {
	it("emits //double-slash absolute Read denials for home siblings", () => {
		const policy = computeIn(
			{
				".ssh": dir({ id_rsa: file() }),
				".gitconfig": file(),
				".cyrus": dir({ "ENG-1": dir({ repo: dir() }) }),
			},
			`${HOME}/.cyrus/ENG-1/repo`,
		);
		const { disallowedTools } = toClaudeToolPatterns(policy);

		// Directory → trailing /** ; file → no glob. Both prefixed with the
		// extra leading slash Claude Code needs for absolute paths.
		expect(disallowedTools).toContain(`Read(//home/alice/.ssh/**)`);
		expect(disallowedTools).toContain(`Read(//home/alice/.gitconfig)`);
	});

	it("emits Read allow patterns for the read dirs (double-slash absolute), not cwd", () => {
		const policy = compute({
			homeDir: HOME,
			dirLister: () => [],
			cwd: "/ws/root",
			allowReadDirectories: ["/repos/a"],
		});
		const { allowedTools } = toClaudeToolPatterns(policy);
		expect(allowedTools).toEqual([`Read(//repos/a/**)`]);
		expect(allowedTools).not.toContain(`Read(//ws/root/**)`);
	});

	it("folds toolDisallow and toolAllowExtra in verbatim, denials first-in-order", () => {
		const policy = compute({
			homeDir: HOME,
			dirLister: makeDirLister(HOME, {
				".ssh": dir(),
				".cyrus": dir({ "ENG-1": dir() }),
			}),
			cwd: `${HOME}/.cyrus/ENG-1`,
			allowReadDirectories: [],
			toolDisallow: ["Bash", "WebFetch"],
			toolAllowExtra: ["Read", "Edit"],
		});
		const { allowedTools, disallowedTools } = toClaudeToolPatterns(policy);

		// No extra read dirs → allowedTools is exactly the config allowances
		// (cwd contributes no grant).
		expect(allowedTools).toEqual(["Read", "Edit"]);

		// Config-level denials come first, then the enumerated home denials.
		expect(disallowedTools[0]).toBe("Bash");
		expect(disallowedTools[1]).toBe("WebFetch");
		expect(disallowedTools).toContain(`Read(//home/alice/.ssh/**)`);
	});

	it("returns empty arrays for an empty policy", () => {
		const policy = compute({
			homeDir: HOME,
			dirLister: () => [],
			cwd: "/tmp/outside",
			allowReadDirectories: [],
		});
		const { allowedTools, disallowedTools } = toClaudeToolPatterns(policy);
		// cwd outside home → no denials; no extra read dirs → no allow grants.
		expect(disallowedTools).toEqual([]);
		expect(allowedTools).toEqual([]);
	});
});

describe("toSandboxFilesystem", () => {
	it("emits {allowRead:['.',...], denyRead:['~/'], allowWrite:[cwd]}", () => {
		const policy = compute({
			homeDir: HOME,
			dirLister: () => [],
			cwd: "/ws/root",
			allowReadDirectories: ["/repos/a"],
			writeDirectories: ["/ws/root"],
		});
		const fs = toSandboxFilesystem(policy);
		// cwd is represented by "."; only the extra read dirs are added.
		expect(fs.allowRead).toEqual([".", "/repos/a"]);
		expect(fs.denyRead).toEqual(["~/"]);
		expect(fs.allowWrite).toEqual(["/ws/root"]);
	});

	it("keeps the literal '~/' deny token regardless of homeDir", () => {
		const policy = compute({
			homeDir: "/home/somebody-else",
			dirLister: () => [],
			cwd: "/ws/root",
			allowReadDirectories: [],
		});
		expect(toSandboxFilesystem(policy).denyRead).toEqual(["~/"]);
	});
});

describe("toCursorPermissions", () => {
	it("surfaces a non-empty warning when home read denials exist", () => {
		const policy = computeIn(
			{ ".ssh": dir(), ".cyrus": dir({ "ENG-1": dir() }) },
			`${HOME}/.cyrus/ENG-1`,
		);
		expect(policy.denyReadPaths.length).toBeGreaterThan(0);

		const perms = toCursorPermissions(policy);
		expect(perms.warnings.length).toBeGreaterThan(0);
		// The un-enforceable denials are NOT injected as deny patterns.
		expect(perms.deny).toEqual([]);
	});

	it("emits no warnings when there are no home read denials", () => {
		const policy = compute({
			homeDir: HOME,
			dirLister: () => [],
			cwd: "/tmp/outside",
			allowReadDirectories: [],
		});
		const perms = toCursorPermissions(policy);
		expect(perms.warnings).toEqual([]);
		expect(perms.allow).toEqual([]);
	});
});
