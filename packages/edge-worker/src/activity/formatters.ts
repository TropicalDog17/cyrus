import type { RepoSetupHookEvent, RepositoryConfig } from "cyrus-core";
import type { Activity } from "./Activity.js";

/**
 * Genuine content formatters kept from the former ActivityPoster, rewritten as
 * pure functions that return a neutral {@link Activity} so callers post them
 * through `sink.post()`. Only the real formatting logic survives here; the
 * shallow thought/response wrappers were deleted.
 */

// ---------------------------------------------------------------------------
// Repository setup hook (action activity + sudo-failure hint)
// ---------------------------------------------------------------------------

function escapeCodeFence(value?: string): string {
	return value?.replace(/```/g, "'''") ?? "";
}

function formatDuration(durationMs?: number): string | null {
	if (typeof durationMs !== "number") return null;
	if (durationMs < 1_000) return `${durationMs}ms`;
	return `${(durationMs / 1_000).toFixed(1)}s`;
}

function looksLikeSudoFailure(output: string): boolean {
	return [
		/sudo:/,
		/no tty present/,
		/a password is required/,
		/not in the sudoers file/,
		/must be run as root/,
		/permission denied.*sudo/,
	].some((pattern) => pattern.test(output));
}

function formatRepoSetupHookFailureHint(
	event: RepoSetupHookEvent,
): string | null {
	const output = [event.errorMessage, event.stdoutTail, event.stderrTail]
		.filter((value): value is string => Boolean(value))
		.join("\n")
		.toLowerCase();

	if (!looksLikeSudoFailure(output)) {
		return null;
	}

	return "The setup script does not run with sudo privileges. Keep `cyrus-setup.sh` to repo-local setup. For hosted Cyrus, add required npm or apt packages in the Cyrus Dashboard at Settings > Packages (`/settings/packages`); for self-hosted Cyrus, preinstall privileged dependencies in the runtime or host.";
}

function formatRepoSetupHookResult(event: RepoSetupHookEvent): string {
	if (event.status === "started") {
		return "Started.";
	}

	const duration = formatDuration(event.durationMs);
	if (event.status === "succeeded") {
		return `Succeeded${duration ? ` in ${duration}` : ""}.`;
	}

	const lines = [
		`Failed${duration ? ` after ${duration}` : ""}: ${event.errorMessage ?? "setup hook exited unsuccessfully"}`,
	];
	if (typeof event.exitCode === "number") {
		lines.push(`Exit code: ${event.exitCode}`);
	}
	if (event.signal) {
		lines.push(`Signal: ${event.signal}`);
	}

	const stdoutTail = escapeCodeFence(event.stdoutTail?.trim());
	const stderrTail = escapeCodeFence(event.stderrTail?.trim());
	if (stdoutTail) {
		lines.push("", "Stdout tail:", "```", stdoutTail, "```");
	}
	if (stderrTail) {
		lines.push("", "Stderr tail:", "```", stderrTail, "```");
	}
	const hint = formatRepoSetupHookFailureHint(event);
	if (hint) {
		lines.push("", hint);
	}
	return lines.join("\n");
}

/**
 * Build the repo-setup-hook action activity (script name + parameter + result,
 * including the sudo-failure hint on failure).
 */
export function formatRepoSetupHookActivity(
	event: RepoSetupHookEvent,
): Activity {
	const parameter = event.repositoryName
		? `Repository setup hook for ${event.repositoryName}`
		: "Repository setup hook";

	return {
		type: "action",
		action: event.scriptName,
		parameter,
		result: formatRepoSetupHookResult(event),
	};
}

// ---------------------------------------------------------------------------
// Routing thought (method display map)
// ---------------------------------------------------------------------------

export function formatRoutingThought(
	repoLines: string[],
	routingMethod?: string,
): Activity {
	const methodDisplayMap: Record<string, string> = {
		"user-selected": "User selection",
		"description-tag": "[repo=...] tag",
		"label-based": "Label routing",
		"project-based": "Project routing",
		"team-based": "Team routing",
		"team-prefix": "Team prefix routing",
		"catch-all": "Catch-all",
		"workspace-fallback": "Workspace fallback",
	};
	const methodDisplay = routingMethod
		? (methodDisplayMap[routingMethod] ?? routingMethod)
		: undefined;

	const header = methodDisplay
		? `**Routing** (${methodDisplay})`
		: "**Routing**";

	return {
		type: "thought",
		body: `${header}\n${repoLines.join("\n")}`,
	};
}

// ---------------------------------------------------------------------------
// Label-role selection thought (debugger / builder / scoper / orchestrator)
// ---------------------------------------------------------------------------

/**
 * Build the "Entering '<role>' mode …" thought when one of the repository's
 * label-prompt roles matches the issue labels, or `null` when no role matched.
 */
export function formatLabelRoleThought(
	labels: string[],
	repo: RepositoryConfig,
): Activity | null {
	let selectedPromptType: string | null = null;
	let triggerLabel: string | null = null;

	if (repo.labelPrompts) {
		// Check debugger labels
		const debuggerConfig = repo.labelPrompts.debugger;
		const debuggerLabels = Array.isArray(debuggerConfig)
			? debuggerConfig
			: debuggerConfig?.labels;
		const debuggerLabel = debuggerLabels?.find((label) =>
			labels.includes(label),
		);
		if (debuggerLabel) {
			selectedPromptType = "debugger";
			triggerLabel = debuggerLabel;
		} else {
			// Check builder labels
			const builderConfig = repo.labelPrompts.builder;
			const builderLabels = Array.isArray(builderConfig)
				? builderConfig
				: builderConfig?.labels;
			const builderLabel = builderLabels?.find((label) =>
				labels.includes(label),
			);
			if (builderLabel) {
				selectedPromptType = "builder";
				triggerLabel = builderLabel;
			} else {
				// Check scoper labels
				const scoperConfig = repo.labelPrompts.scoper;
				const scoperLabels = Array.isArray(scoperConfig)
					? scoperConfig
					: scoperConfig?.labels;
				const scoperLabel = scoperLabels?.find((label) =>
					labels.includes(label),
				);
				if (scoperLabel) {
					selectedPromptType = "scoper";
					triggerLabel = scoperLabel;
				} else {
					// Check orchestrator labels
					const orchestratorConfig = repo.labelPrompts.orchestrator;
					const orchestratorLabels = Array.isArray(orchestratorConfig)
						? orchestratorConfig
						: (orchestratorConfig?.labels ?? ["orchestrator"]);
					const orchestratorLabel = orchestratorLabels?.find((label) =>
						labels.includes(label),
					);
					if (orchestratorLabel) {
						selectedPromptType = "orchestrator";
						triggerLabel = orchestratorLabel;
					}
				}
			}
		}
	}

	// Only produce an activity if a role was actually triggered
	if (!selectedPromptType || !triggerLabel) {
		return null;
	}

	return {
		type: "thought",
		body: `Entering '${selectedPromptType}' mode because of the '${triggerLabel}' label. I'll follow the ${selectedPromptType} process...`,
	};
}
