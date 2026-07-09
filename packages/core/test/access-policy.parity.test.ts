import { describe, expect, it } from "vitest";
import {
	type AccessPolicyInput,
	compute,
	type DirEntry,
	type DirLister,
	toClaudeToolPatterns,
} from "../src/access-policy/AccessPolicy.js";

// Regression guard for the drift hole that used to exist between the cold path
// (ClaudeRunner.start) and the warm path (EdgeWorker.warmupSessions): the two
// used to re-derive the home-directory Read denials by hand and could diverge.
// Both now funnel through `toClaudeToolPatterns(compute(input))`, so given the
// SAME AccessPolicyInput they MUST produce byte-identical tool patterns.

const HOME = "/home/alice";

// A fixed home layout: one worktree + attachments dir + several sensitive
// siblings that must be denied.
const dirLister: DirLister = ((): DirLister => {
	const dirs = new Map<string, DirEntry[]>([
		[
			HOME,
			[
				{ name: ".ssh", isDirectory: true },
				{ name: ".aws", isDirectory: true },
				{ name: ".gitconfig", isDirectory: false },
				{ name: ".cyrus", isDirectory: true },
			],
		],
		[
			`${HOME}/.cyrus`,
			[
				{ name: "worktrees", isDirectory: true },
				{ name: "ENG-1", isDirectory: true },
				{ name: "certs", isDirectory: true },
			],
		],
		[`${HOME}/.cyrus/worktrees`, [{ name: "ENG-1", isDirectory: true }]],
		[`${HOME}/.cyrus/worktrees/ENG-1`, [{ name: "repo", isDirectory: true }]],
		[`${HOME}/.cyrus/ENG-1`, [{ name: "attachments", isDirectory: true }]],
	]);
	return (d: string) => dirs.get(d) ?? [];
})();

const input: AccessPolicyInput = {
	homeDir: HOME,
	dirLister,
	cwd: `${HOME}/.cyrus/worktrees/ENG-1/repo`,
	allowReadDirectories: [
		`${HOME}/.cyrus/ENG-1/attachments`,
		`${HOME}/.cyrus/worktrees/ENG-1/repo`,
	],
	toolDisallow: ["Bash"],
	toolAllowExtra: ["Read", "Edit"],
};

describe("AccessPolicy cold/warm parity", () => {
	it("produces byte-identical toClaudeToolPatterns for one input", () => {
		// Cold path and warm path now both do exactly this.
		const cold = toClaudeToolPatterns(compute(input));
		const warm = toClaudeToolPatterns(compute(input));
		expect(warm).toEqual(cold);
	});

	it("denies the sensitive siblings and keeps the worktree traversable", () => {
		const { disallowedTools } = toClaudeToolPatterns(compute(input));
		expect(disallowedTools).toContain(`Read(//home/alice/.ssh/**)`);
		expect(disallowedTools).toContain(`Read(//home/alice/.aws/**)`);
		expect(disallowedTools).toContain(`Read(//home/alice/.gitconfig)`);
		expect(disallowedTools).toContain(`Read(//home/alice/.cyrus/certs/**)`);
		// On the path to cwd / attachments — must NOT be denied.
		expect(disallowedTools).not.toContain(`Read(//home/alice/.cyrus/**)`);
		expect(disallowedTools).not.toContain(`Read(//home/alice/.cyrus/ENG-1/**)`);
		expect(disallowedTools).not.toContain(
			`Read(//home/alice/.cyrus/worktrees/**)`,
		);
	});

	it("is deterministic across repeated calls (no hidden state / ordering)", () => {
		const runs = Array.from({ length: 3 }, () =>
			toClaudeToolPatterns(compute(input)),
		);
		expect(runs[1]).toEqual(runs[0]);
		expect(runs[2]).toEqual(runs[0]);
	});
});
