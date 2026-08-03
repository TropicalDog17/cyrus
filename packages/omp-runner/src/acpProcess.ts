import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { Stream } from "@agentclientprotocol/sdk";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import type { OmpRunnerConfig } from "./types.js";

/** Default OMP launch command when none is configured. */
const DEFAULT_OMP_COMMAND = "omp";

export interface OmpAcpProcess {
	child: ChildProcessWithoutNullStreams;
	stream: Stream;
}

/**
 * Resolve the OMP launch command into its base argv. Precedence: explicit
 * `config.ompCommand` → `OMP_COMMAND` env → the `omp` binary on PATH.
 */
export function resolveOmpCommand(config: OmpRunnerConfig): string[] {
	const raw =
		config.ompCommand?.trim() ||
		process.env.OMP_COMMAND?.trim() ||
		DEFAULT_OMP_COMMAND;
	const parts = raw.split(/\s+/).filter((part) => part.length > 0);
	if (parts.length === 0) {
		return [DEFAULT_OMP_COMMAND];
	}
	return parts;
}

/**
 * Build the OMP ACP launch argv.
 *
 * Repository invariant: the argv begins `omp acp --print`. `--print` is
 * always included — even though ACP owns stdin — so an interactive launch is
 * impossible if mode parsing ever changes. Authorization inputs that OMP only
 * honors at launch (ADR 0016) follow: cwd, additional roots, built-in tools,
 * approval mode, the generated overlay config, the system prompt, and the
 * session-private state directory.
 */
export function buildOmpAcpArgv(
	config: OmpRunnerConfig,
	workingDirectory: string,
	systemPrompt: string,
): string[] {
	const argv: string[] = [...resolveOmpCommand(config), "acp", "--print"];

	argv.push("--cwd", workingDirectory);

	for (const dir of config.ompAdditionalDirectories ?? []) {
		argv.push("--add-dir", dir);
	}

	const tools = config.ompTools;
	if (tools && tools.length > 0) {
		argv.push("--tools", tools.join(","));
	} else if (tools && tools.length === 0) {
		// Explicitly no built-in tools — only MCP tools from the exact catalog.
		argv.push("--no-tools");
	}

	// always-ask: unknown operations reach the permission handler, where the
	// rendered Cyrus policy decides. Never yolo/auto-approve.
	argv.push("--approval-mode", "always-ask");

	if (config.ompOverlayConfigPath) {
		argv.push("--config", config.ompOverlayConfigPath);
	}

	if (systemPrompt.trim().length > 0) {
		argv.push("--system-prompt", systemPrompt);
	}

	if (config.ompSessionDir) {
		argv.push("--session-dir", config.ompSessionDir);
	}

	return argv;
}

/**
 * Spawn the OMP ACP server (no shell) and wrap its stdio in a
 * newline-delimited JSON {@link Stream}. stderr is forwarded to the provided
 * sink (default: the parent stderr) for diagnostics.
 */
export function spawnOmpAcp(
	config: OmpRunnerConfig,
	workingDirectory: string,
	systemPrompt: string,
	onStderr?: (chunk: string) => void,
): OmpAcpProcess {
	const argv = buildOmpAcpArgv(config, workingDirectory, systemPrompt);
	const child = spawn(argv[0]!, argv.slice(1), {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: workingDirectory,
		env: process.env,
	}) as ChildProcessWithoutNullStreams;

	const stderrSink =
		onStderr ?? ((chunk: string) => process.stderr.write(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderrSink(chunk.toString()));

	// Node's Web Stream adapters yield/accept Uint8Array chunks, matching what
	// ndJsonStream expects. The cast bridges the node:stream/web nominal types
	// to the SDK's global WritableStream/ReadableStream declarations.
	const output = Writable.toWeb(
		child.stdin,
	) as unknown as WritableStream<Uint8Array>;
	const input = Readable.toWeb(
		child.stdout,
	) as unknown as ReadableStream<Uint8Array>;
	const stream = ndJsonStream(output, input);

	return { child, stream };
}
