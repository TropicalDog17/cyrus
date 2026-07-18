import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import type { CodexRunnerConfig } from "./types.js";

/** Default Codex ACP adapter launch command when none is configured. */
const DEFAULT_ACP_COMMAND = "npx -y @agentclientprotocol/codex-acp";

export interface CodexAcpProcess {
	child: ChildProcessWithoutNullStreams;
	stream: Stream;
}

/**
 * Resolve the adapter launch command into an argv array. Precedence:
 * explicit `config.acpCommand` → `CODEX_ACP_COMMAND` env → the bundled
 * `npx -y @agentclientprotocol/codex-acp`.
 */
export function resolveAcpCommand(config: CodexRunnerConfig): string[] {
	const raw =
		config.acpCommand?.trim() ||
		process.env.CODEX_ACP_COMMAND?.trim() ||
		DEFAULT_ACP_COMMAND;
	const parts = raw.split(/\s+/).filter((part) => part.length > 0);
	if (parts.length === 0) {
		return DEFAULT_ACP_COMMAND.split(/\s+/);
	}
	return parts;
}

/**
 * Build the environment for the adapter process. Threads through Codex auth
 * (`CODEX_API_KEY`/`OPENAI_API_KEY`), the optional `CODEX_PATH` override, the
 * requested model (merged into `CODEX_CONFIG`), and a headless-friendly
 * `INITIAL_AGENT_MODE`/`NO_BROWSER` default so remote runs never block on
 * browser-based auth.
 */
export function buildAcpEnv(config: CodexRunnerConfig): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };

	const apiKey =
		config.codexApiKey ||
		process.env.CODEX_API_KEY ||
		process.env.OPENAI_API_KEY;
	if (apiKey) {
		env.CODEX_API_KEY = apiKey;
		// Keep OPENAI_API_KEY populated too, as the fallback the adapter accepts.
		env.OPENAI_API_KEY = env.OPENAI_API_KEY || apiKey;
	}

	const codexPath = config.codexPath || process.env.CODEX_PATH;
	if (codexPath) {
		env.CODEX_PATH = codexPath;
	}

	// Merge the selected model into CODEX_CONFIG (a JSON object the adapter
	// layers onto every new Codex session) without clobbering any pre-existing
	// keys the operator set.
	if (config.model) {
		let base: Record<string, unknown> = {};
		if (process.env.CODEX_CONFIG) {
			try {
				const parsed = JSON.parse(process.env.CODEX_CONFIG);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					base = parsed as Record<string, unknown>;
				}
			} catch {
				// Ignore malformed operator-provided CODEX_CONFIG; model wins.
			}
		}
		env.CODEX_CONFIG = JSON.stringify({ ...base, model: config.model });
	}

	// Cyrus runs autonomously and auto-approves tool calls, so give the agent an
	// actionable mode by default. Respect an explicit operator override.
	env.INITIAL_AGENT_MODE = process.env.INITIAL_AGENT_MODE || "agent";
	// Never fall back to browser-based ChatGPT auth in a headless runtime.
	env.NO_BROWSER = process.env.NO_BROWSER || "1";

	return env;
}

/**
 * Spawn the Codex ACP adapter and wrap its stdio in a newline-delimited JSON
 * {@link Stream} for the ACP client connection. stderr is forwarded to the
 * provided sink (default: the parent stderr) for diagnostics.
 */
export function spawnCodexAcp(
	config: CodexRunnerConfig,
	onStderr?: (chunk: string) => void,
): CodexAcpProcess {
	const [command, ...args] = resolveAcpCommand(config);
	const child = spawn(command as string, args, {
		cwd: config.workingDirectory,
		env: buildAcpEnv(config),
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams;

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		if (onStderr) {
			onStderr(chunk);
		} else {
			process.stderr.write(`[codex-acp] ${chunk}`);
		}
	});

	// Node's Web Stream adapters yield/accept Uint8Array chunks, matching what
	// ndJsonStream expects. The cast bridges the node:stream/web nominal types to
	// the SDK's global WritableStream/ReadableStream declarations.
	const output = Writable.toWeb(
		child.stdin,
	) as unknown as WritableStream<Uint8Array>;
	const input = Readable.toWeb(
		child.stdout,
	) as unknown as ReadableStream<Uint8Array>;
	const stream = ndJsonStream(output, input);

	return { child, stream };
}
