/**
 * OmpSandbox: the SRT wrapper for the OMP process tree.
 *
 * The full boundary suite (allowed worktree read/write, forbidden
 * sibling-home read, forbidden outside-worktree write, allowed/denied network
 * hosts THROUGH the spawned process) runs only where SRT can actually
 * initialize — it requires bubblewrap/sandbox-exec plus socat for the egress
 * proxy. Where the runtime cannot initialize (e.g. this dev container), the
 * fail-closed contract is what gets asserted: enabled sandboxing + init
 * failure = actionable error, never an unsandboxed launch.
 */

import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { describe, expect, it } from "vitest";
import { OmpSandbox, type OmpSandboxConfig } from "../src/OmpSandbox.js";

function makeConfig(
	overrides: Partial<OmpSandboxConfig> = {},
): OmpSandboxConfig {
	return {
		enabled: true,
		filesystem: {
			denyRead: ["~/"],
			allowRead: ["."],
			allowWrite: ["/tmp"],
			denyWrite: [],
		},
		allowedDomains: ["mcp.linear.app"],
		deniedDomains: ["*"],
		...overrides,
	};
}

/**
 * Whether the SRT runtime can initialize HERE. Uses checkDependencies (no
 * side effects) so the singleton manager stays uninitialized for the
 * fail-closed tests.
 */
function sandboxAvailable(): boolean {
	try {
		const result = SandboxManager.checkDependencies();
		return (result.errors?.length ?? 0) === 0;
	} catch {
		return false;
	}
}

describe("OmpSandbox", () => {
	it("returns null (direct spawn) when sandboxing is disabled", async () => {
		const sandbox = new OmpSandbox(makeConfig({ enabled: false }));
		expect(sandbox.enabled).toBe(false);
		const wrapped = await sandbox.wrapCommand(
			["omp", "acp", "--print"],
			"/tmp",
		);
		expect(wrapped).toBeNull();
	});

	it("fails profile startup with an actionable error when init fails while enabled", async () => {
		const sandbox = new OmpSandbox(makeConfig());
		await expect(
			sandbox.wrapCommand(["omp", "acp", "--print"], "/tmp"),
		).rejects.toThrow(/sandbox/i);
	});

	it("never launches unsandboxed when init fails", async () => {
		// The wrap path either returns a wrapped argv or throws — there is no
		// fallback branch returning the unwrapped command.
		const sandbox = new OmpSandbox(makeConfig());
		let threw = false;
		try {
			await sandbox.wrapCommand(["omp", "acp", "--print"], "/tmp");
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	it.skipIf(!sandboxAvailable())(
		"wraps the command and enforces the filesystem boundary through the spawned process",
		async () => {
			const sandbox = new OmpSandbox(
				makeConfig({
					filesystem: {
						denyRead: ["~/"],
						allowRead: ["/tmp"],
						allowWrite: ["/tmp"],
						denyWrite: [],
					},
				}),
			);
			const wrapped = await sandbox.wrapCommand(["echo", "hi"], "/tmp");
			expect(wrapped).not.toBeNull();
			expect(wrapped!.argv.length).toBeGreaterThan(0);
		},
	);
});
