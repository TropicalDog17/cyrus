import type { RepositoryConfig } from "cyrus-core";
import { describe, expect, test } from "vitest";
import {
	formatLabelRoleThought,
	formatRepoSetupHookActivity,
	formatRoutingThought,
} from "../src/activity/formatters.js";

describe("formatRepoSetupHookActivity", () => {
	test("adds a sudo guidance hint on sudo failures", () => {
		const activity = formatRepoSetupHookActivity({
			status: "failed",
			issueIdentifier: "ENG-97",
			scriptName: "cyrus-setup.sh",
			repositoryName: "test-repo",
			durationMs: 1_200,
			exitCode: 1,
			errorMessage: "Script exited with code 1",
			stderrTail: "sudo: a password is required",
			truncated: false,
		});
		expect(activity.type).toBe("action");
		if (activity.type !== "action") throw new Error("expected action");
		expect(activity.action).toBe("cyrus-setup.sh");
		expect(activity.parameter).toBe("Repository setup hook for test-repo");
		expect(activity.result).toContain("sudo: a password is required");
		expect(activity.result).toContain(
			"The setup script does not run with sudo privileges.",
		);
		expect(activity.result).toContain(
			"Settings > Packages (`/settings/packages`)",
		);
	});

	test("omits the sudo hint on non-sudo failures", () => {
		const activity = formatRepoSetupHookActivity({
			status: "failed",
			issueIdentifier: "ENG-97",
			scriptName: "cyrus-setup.sh",
			repositoryName: "test-repo",
			durationMs: 1_200,
			exitCode: 42,
			errorMessage: "Script exited with code 42",
			stderrTail: "missing package @fake/missing",
			truncated: false,
		});
		if (activity.type !== "action") throw new Error("expected action");
		expect(activity.result).toContain("missing package @fake/missing");
		expect(activity.result).not.toContain("sudo privileges");
		expect(activity.result).not.toContain("/settings/packages");
	});

	test("succeeded status renders a duration", () => {
		const activity = formatRepoSetupHookActivity({
			status: "succeeded",
			issueIdentifier: "ENG-1",
			scriptName: "cyrus-setup.sh",
			durationMs: 1_500,
		});
		if (activity.type !== "action") throw new Error("expected action");
		expect(activity.parameter).toBe("Repository setup hook");
		expect(activity.result).toBe("Succeeded in 1.5s.");
	});
});

describe("formatRoutingThought", () => {
	test("maps the routing method to a display name", () => {
		const activity = formatRoutingThought(
			["- repo-a", "- repo-b"],
			"label-based",
		);
		expect(activity).toEqual({
			type: "thought",
			body: "**Routing** (Label routing)\n- repo-a\n- repo-b",
		});
	});

	test("omits the method suffix when unspecified", () => {
		const activity = formatRoutingThought(["- repo-a"]);
		expect(activity).toEqual({
			type: "thought",
			body: "**Routing**\n- repo-a",
		});
	});

	test("passes an unknown method through verbatim", () => {
		const activity = formatRoutingThought(["- repo-a"], "some-custom-method");
		expect(activity.type === "thought" && activity.body).toBe(
			"**Routing** (some-custom-method)\n- repo-a",
		);
	});
});

describe("formatLabelRoleThought", () => {
	function repo(labelPrompts: unknown): RepositoryConfig {
		return { labelPrompts } as unknown as RepositoryConfig;
	}

	test("matches a debugger label", () => {
		const activity = formatLabelRoleThought(
			["Bug"],
			repo({ debugger: { labels: ["Bug"] } }),
		);
		expect(activity).toEqual({
			type: "thought",
			body: "Entering 'debugger' mode because of the 'Bug' label. I'll follow the debugger process...",
		});
	});

	test("matches a builder label (array form)", () => {
		const activity = formatLabelRoleThought(
			["Feature"],
			repo({ builder: ["Feature"] }),
		);
		expect(activity?.type === "thought" && activity.body).toContain(
			"Entering 'builder' mode because of the 'Feature' label",
		);
	});

	test("defaults orchestrator to the 'orchestrator' label", () => {
		const activity = formatLabelRoleThought(["orchestrator"], repo({}));
		expect(activity?.type === "thought" && activity.body).toContain(
			"Entering 'orchestrator' mode",
		);
	});

	test("returns null when no role matches", () => {
		expect(
			formatLabelRoleThought(["Unrelated"], repo({ debugger: ["Bug"] })),
		).toBeNull();
	});

	test("returns null when there are no label prompts", () => {
		expect(formatLabelRoleThought(["Bug"], repo(undefined))).toBeNull();
	});
});
