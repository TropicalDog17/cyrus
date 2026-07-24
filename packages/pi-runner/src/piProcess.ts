import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiRunnerConfig } from "./types.js";

export interface PiLaunchCommand {
	command: string;
	args: string[];
}

/**
 * Resolve the Pi CLI launch command. The pinned package entry point is preferred
 * so systemd deployments do not depend on a globally-installed `pi` binary.
 */
export function resolvePiLaunchCommand(
	config: PiRunnerConfig,
): PiLaunchCommand {
	const override =
		config.piCommand?.trim() || process.env.CYRUS_PI_COMMAND?.trim();
	if (override) {
		const [command, ...args] = override
			.split(/\s+/)
			.filter((part) => part.length > 0);
		if (command) return { command, args };
	}

	const packageEntry = fileURLToPath(
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	);
	return {
		command: process.execPath,
		args: [resolve(dirname(packageEntry), "cli.js")],
	};
}

/** Map Cyrus/Claude-style tool names to Pi's built-in tool identifiers. */
export function mapToolNameToPi(
	tool: string,
	includeScoped = false,
): string | null {
	if (!includeScoped && tool.includes("(")) return null;
	const base = tool.split("(")[0]?.trim();
	if (!base) return null;

	switch (base.toLowerCase()) {
		case "read":
			return "read";
		case "grep":
			return "grep";
		case "glob":
		case "find":
			return "find";
		case "ls":
			return "ls";
		case "edit":
		case "notebookedit":
			return "edit";
		case "write":
			return "write";
		case "bash":
			return "bash";
		default:
			// Preserve extension/custom-tool names, including mcp__* names, so a
			// project-installed Pi extension can expose them without translation.
			// Drop unknown PascalCase Claude built-ins: passing unavailable names
			// through `--tools` can prevent Pi from starting.
			return base.startsWith("mcp__") || base === base.toLowerCase()
				? base
				: null;
	}
}

export function mapToolsToPi(
	tools?: string[],
	includeScoped = false,
): string[] | undefined {
	if (!tools) return undefined;
	return [
		...new Set(
			tools
				.map((tool) => mapToolNameToPi(tool, includeScoped))
				.filter((tool): tool is string => tool !== null),
		),
	];
}

/** Build the complete Pi RPC argv from a neutral Cyrus runner config. */
export function buildPiArgs(config: PiRunnerConfig): string[] {
	const args = ["--mode", "rpc", "--approve"];

	if (config.resumeSessionId) {
		args.push("--session", config.resumeSessionId);
	}
	if (config.model) {
		args.push("--model", config.model);
	}
	if (config.appendSystemPrompt) {
		args.push("--append-system-prompt", config.appendSystemPrompt);
	}

	const allowedTools = mapToolsToPi(config.allowedTools);
	if (allowedTools) {
		if (allowedTools.length > 0) {
			args.push("--tools", allowedTools.join(","));
		} else {
			args.push("--no-tools");
		}
	}
	// A scoped Cyrus deny cannot be represented by Pi's name-only CLI filter.
	// Deny the whole corresponding Pi tool rather than silently under-enforcing.
	const disallowedTools = mapToolsToPi(config.disallowedTools, true);
	if (disallowedTools?.length) {
		args.push("--exclude-tools", disallowedTools.join(","));
	}

	return args;
}

export function spawnPi(
	config: PiRunnerConfig,
): ChildProcessWithoutNullStreams {
	const launch = resolvePiLaunchCommand(config);
	return spawn(launch.command, [...launch.args, ...buildPiArgs(config)], {
		cwd: config.workingDirectory,
		env: { ...process.env, ...config.additionalEnv },
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams;
}
