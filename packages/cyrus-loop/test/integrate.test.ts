import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CmdRun } from "../src/capture.js";
import { prMetaPath } from "../src/capture.js";
import { recordHumanVerdict } from "../src/gate.js";
import { integrateRun, readMergeFact } from "../src/integrate.js";

// Ported from tests/test_integrate.py (ghselect account-threading test omitted — dropped)

function fakeGh(
	opts: { headSha?: string; mergeStatus?: number; mergeCommit?: string } = {},
): CmdRun {
	const headSha = opts.headSha ?? "abc";
	const mergeStatus = opts.mergeStatus ?? 0;
	const mergeCommit = opts.mergeCommit ?? "deadbeef";
	return (args) => {
		if (args[0] === "gh" && args[1] === "pr" && args[2] === "view") {
			const field = args[args.indexOf("--json") + 1];
			if (field === "headRefOid")
				return {
					status: 0,
					stdout: JSON.stringify({ headRefOid: headSha }),
					stderr: "",
				};
			if (field === "mergeCommit")
				return {
					status: 0,
					stdout: JSON.stringify({ mergeCommit: { oid: mergeCommit } }),
					stderr: "",
				};
		}
		if (args[0] === "gh" && args[1] === "pr" && args[2] === "merge") {
			return {
				status: mergeStatus,
				stdout: "",
				stderr: mergeStatus === 0 ? "" : "merge conflict",
			};
		}
		return { status: 1, stdout: "", stderr: `unexpected argv: ${args}` };
	};
}

function writePrMeta(
	rid: string,
	opts: { number?: number; headSha?: string; base?: string } = {},
): void {
	writeFileSync(
		prMetaPath(rid),
		JSON.stringify({
			run_id: rid,
			number: opts.number ?? 7,
			repo_dir: "/repo",
			head_sha: opts.headSha ?? "abc",
			base: opts.base ?? "main",
		}),
	);
}

let prev: string | undefined;
beforeEach(() => {
	prev = process.env.AGENTIC_PIPELINE_DATA;
	process.env.AGENTIC_PIPELINE_DATA = mkdtempSync(
		join(tmpdir(), "cyrus-loop-int-"),
	);
});
afterEach(() => {
	if (prev === undefined) delete process.env.AGENTIC_PIPELINE_DATA;
	else process.env.AGENTIC_PIPELINE_DATA = prev;
	vi.restoreAllMocks();
});

describe("integrateRun", () => {
	it("refuses without a recorded verdict", () => {
		expect(() => integrateRun("2026-07-05-ENG-1")).toThrow(
			/no human diff-gate verdict/,
		);
	});

	it("refuses (no side effects) when the verdict is not approved", () => {
		const rid = "2026-07-05-ENG-2";
		recordHumanVerdict(rid, "rejected", []);
		writePrMeta(rid);
		const throwGh: CmdRun = () => {
			throw new Error("gh must not run");
		};
		const status = integrateRun(rid, null, { ghRun: throwGh });
		expect(status.integrated).toBe(false);
		expect(status.refused).toBe(true);
		expect(status.reason).toContain("not 'approved'");
		expect(readMergeFact(rid)).toBeNull();
	});

	it("refuses when there is no PR metadata", () => {
		const rid = "2026-07-05-ENG-3";
		recordHumanVerdict(rid, "approved", []);
		expect(() => integrateRun(rid)).toThrow(/no PR metadata/);
	});

	it("refuses on SHA drift", () => {
		const rid = "2026-07-05-ENG-4";
		recordHumanVerdict(rid, "approved", []);
		writePrMeta(rid, { headSha: "abc" });
		expect(() =>
			integrateRun(rid, null, { ghRun: fakeGh({ headSha: "xyz" }) }),
		).toThrow(/head advanced/);
		expect(readMergeFact(rid)).toBeNull();
	});

	it("merges an approved PR and writes a durable merge fact", () => {
		const rid = "2026-07-05-ENG-5";
		recordHumanVerdict(rid, "approved", []);
		writePrMeta(rid, { number: 7, headSha: "abc" });
		const status = integrateRun(rid, null, {
			ghRun: fakeGh({ headSha: "abc", mergeCommit: "cafe1234" }),
		});
		expect(status.integrated).toBe(true);
		expect(status.outcome).toBe("merged");
		expect(status.pr).toBe(7);
		expect(status.method).toBe("squash");
		const fact = readMergeFact(rid)!;
		expect(fact.merged).toBe(true);
		expect(fact.pr).toBe(7);
		expect(fact.merge_commit).toBe("cafe1234");
	});

	it("raises on merge failure without writing a fact", () => {
		const rid = "2026-07-05-ENG-6";
		recordHumanVerdict(rid, "approved", []);
		writePrMeta(rid, { headSha: "abc" });
		expect(() =>
			integrateRun(rid, null, {
				ghRun: fakeGh({ headSha: "abc", mergeStatus: 1 }),
			}),
		).toThrow(/gh pr merge/);
		expect(readMergeFact(rid)).toBeNull();
	});

	it("rejects a bad merge method", () => {
		const rid = "2026-07-05-ENG-7";
		recordHumanVerdict(rid, "approved", []);
		expect(() => integrateRun(rid, null, { method: "octopus" as any })).toThrow(
			/method must be one of/,
		);
	});
});
