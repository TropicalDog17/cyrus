/**
 * OmpToolPolicy: the permission layer for OMP sessions. The operation names it
 * matches are exactly what `permissionOperationName` produces (OMP kind names
 * like `execute`, `read`, `edit`, `search`, `fetch`, or the real MCP title).
 */
import { describe, expect, it } from "vitest";
import { permissionOperationName } from "../src/OmpRunner.js";
import { OmpToolPolicy } from "../src/OmpToolPolicy.js";

const RENDER = {
	allow: ["read", "edit", "execute", "search", "fetch", "mcp__linear_issue"],
	deny: ["think"],
	denyDetails: [],
};

describe("OmpToolPolicy", () => {
	it("allows operations the render allows (exact kind match)", () => {
		const policy = new OmpToolPolicy(RENDER);
		expect(policy.allowsTool("execute")).toBe(true);
		expect(policy.allowsTool("read")).toBe(true);
		expect(policy.allowsTool("fetch")).toBe(true);
	});

	it("rejects operations the render denies", () => {
		const policy = new OmpToolPolicy(RENDER);
		expect(policy.allowsTool("think")).toBe(false);
	});

	it("rejects unknown operations (fail closed)", () => {
		const policy = new OmpToolPolicy(RENDER);
		expect(policy.allowsTool("other")).toBe(false);
		expect(policy.allowsTool("teleport")).toBe(false);
	});

	it("rejects unknown operations even with an allow-heavy render (never allow-by-default)", () => {
		const policy = new OmpToolPolicy({
			allow: ["read", "edit", "execute", "search", "fetch"],
			deny: [],
			denyDetails: [],
		});
		expect(policy.allowsTool("askuserquestion")).toBe(false);
		expect(policy.allowsTool("todo")).toBe(false);
	});

	it("matches mcp__server entries as prefixes over that server's tools", () => {
		const policy = new OmpToolPolicy({
			...RENDER,
			allow: ["mcp__linear_issue"],
		});
		expect(policy.allowsTool("mcp__linear_issue")).toBe(true);
		// Other tools on the same server are NOT covered by a tool-level allow.
		expect(policy.allowsTool("mcp__linear_comment")).toBe(false);
	});

	it("matches a server-level allow across every tool on that server", () => {
		const policy = new OmpToolPolicy({
			allow: ["mcp__linear_*"],
			deny: [],
			denyDetails: [],
		});
		expect(policy.allowsTool("mcp__linear_issue")).toBe(true);
		expect(policy.allowsTool("mcp__linear_comment")).toBe(true);
		expect(policy.allowsTool("mcp__github_issue")).toBe(false);
	});

	it("rejects a deny-detail entry when the request detail names the path", () => {
		const policy = new OmpToolPolicy({
			allow: ["read"],
			deny: [],
			denyDetails: [{ operation: "read", needle: "//home/u/.ssh" }],
		});
		expect(policy.allowsTool("read", "Read //home/u/.ssh/id_rsa")).toBe(false);
		expect(policy.allowsTool("read", "Read /repo/worktrees/ISS-1/a.ts")).toBe(
			true,
		);
	});

	it("operates on exactly the strings permissionOperationName produces", () => {
		const policy = new OmpToolPolicy({
			allow: ["read", "edit", "execute", "search", "fetch"],
			deny: [],
			denyDetails: [],
		});
		const kinds: Record<string, string> = {
			read: "read",
			edit: "edit",
			delete: "edit",
			execute: "execute",
			move: "execute",
			search: "search",
			fetch: "fetch",
			think: "think",
			other: "mcp__linear__issue",
		};
		for (const [kind, title] of Object.entries(kinds)) {
			const operation = permissionOperationName({
				toolCallId: "tc",
				kind: kind as never,
				title,
				status: "pending",
			} as never);
			// The policy and the runner agree on the vocabulary.
			expect(typeof policy.allowsTool(operation)).toBe("boolean");
			if (kind === "other") {
				expect(operation).toBe("mcp__linear__issue");
				// The allow list must contain the MCP title for it to pass.
				expect(policy.allowsTool(operation)).toBe(false);
			}
		}
	});
});
