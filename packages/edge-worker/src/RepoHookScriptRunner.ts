import { execSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { ILogger, RepoSetupHookEventHandler } from "cyrus-core";

/** Timeout for repo setup scripts (cyrus-setup.*). */
export const SETUP_TIMEOUT_MS = 5 * 60 * 1000;

/** Timeout for repo teardown scripts (cyrus-teardown.*). */
export const TEARDOWN_TIMEOUT_MS = 2 * 60 * 1000;

export const HOOK_OUTPUT_TAIL_MAX_BYTES = 64 * 1024;
export const HOOK_OUTPUT_TAIL_MAX_CHARS = 8_000;
export const HOOK_OUTPUT_TAIL_MAX_LINES = 40;

export type HookKind = "setup" | "teardown";

export interface HookScriptOptions {
	scriptPath: string;
	hook: HookKind;
	/** Origin of the script for user-facing log messages. */
	originLabel: string;
	/** Working directory for the spawned process. */
	cwd: string;
	/** Environment variables to merge with `process.env`. */
	env: Record<string, string>;
	/** Timeout in milliseconds for the spawned process. */
	timeoutMs: number;
	repositoryName?: string;
	issueIdentifier?: string;
	onRepoSetupHookEvent?: RepoSetupHookEventHandler;
}

export interface NodeExecError {
	signal?: string;
	message?: string;
	code?: number | string;
}

export function isNodeExecError(value: unknown): value is NodeExecError {
	return typeof value === "object" && value !== null;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactHookOutput(
	output: string,
	opts: { cwd: string; env: Record<string, string> },
): string {
	let redacted = output;
	const pathValues = [opts.cwd, homedir(), process.cwd()]
		.flatMap((pathValue) =>
			pathValue.startsWith("/var/")
				? [`/private${pathValue}`, pathValue]
				: [pathValue],
		)
		.filter(Boolean);
	for (const pathValue of pathValues) {
		const isWorkspacePath =
			pathValue === opts.cwd || pathValue === `/private${opts.cwd}`;
		redacted = redacted.replace(
			new RegExp(escapeRegExp(pathValue), "g"),
			isWorkspacePath ? "[workspace]" : "[path]",
		);
	}
	redacted = redacted.replace(/\/private\[workspace\]/g, "[workspace]");

	redacted = redacted.replace(
		/(?:\/Users|\/home|\/var\/folders|\/private\/tmp|\/tmp)\/[^\s'"`<>)]*/g,
		"[path]",
	);

	redacted = redacted.replace(
		/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|AUTH|CREDENTIAL|PRIVATE|ACCESS[_-]?KEY|REFRESH[_-]?TOKEN|SESSION|COOKIE)[A-Z0-9_]*)\s*=\s*([^\s]+)/gi,
		"$1=[REDACTED]",
	);

	const sensitiveEnvPattern =
		/(TOKEN|SECRET|PASSWORD|PASS|API[_-]?KEY|AUTH|CREDENTIAL|PRIVATE|ACCESS[_-]?KEY|REFRESH[_-]?TOKEN|SESSION|COOKIE)/i;
	const sensitiveValues = new Set<string>();
	for (const [key, value] of Object.entries({ ...process.env, ...opts.env })) {
		if (!sensitiveEnvPattern.test(key)) continue;
		if (!value || value.length < 4) continue;
		sensitiveValues.add(value);
	}
	for (const [key, value] of Object.entries(opts.env)) {
		if (key === "LINEAR_ISSUE_IDENTIFIER") continue;
		if (!value || value.length < 4) continue;
		sensitiveValues.add(value);
	}

	for (const value of sensitiveValues) {
		redacted = redacted.replace(
			new RegExp(escapeRegExp(value), "g"),
			"[REDACTED]",
		);
	}

	redacted = redacted
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
		.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
		.replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[REDACTED]");

	return redacted;
}

export function truncateHookOutputTail(output: string): {
	text: string;
	truncated: boolean;
} {
	const lines = output.split(/\r?\n/);
	let truncated = false;
	let selectedLines = lines;
	if (lines.length > HOOK_OUTPUT_TAIL_MAX_LINES) {
		truncated = true;
		selectedLines = lines.slice(-HOOK_OUTPUT_TAIL_MAX_LINES);
	}

	let tail = selectedLines.join("\n");
	if (tail.length > HOOK_OUTPUT_TAIL_MAX_CHARS) {
		truncated = true;
		tail = tail.slice(-HOOK_OUTPUT_TAIL_MAX_CHARS);
	}

	return { text: tail.trim(), truncated };
}

export class HookOutputCollector {
	private chunks: string[] = [];
	private bytes = 0;

	append(chunk: Buffer | string): void {
		const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
		this.chunks.push(text);
		this.bytes += Buffer.byteLength(text, "utf8");

		while (this.bytes > HOOK_OUTPUT_TAIL_MAX_BYTES && this.chunks.length > 1) {
			const removed = this.chunks.shift() ?? "";
			this.bytes -= Buffer.byteLength(removed, "utf8");
		}

		if (this.bytes > HOOK_OUTPUT_TAIL_MAX_BYTES && this.chunks.length === 1) {
			const current = this.chunks[0] ?? "";
			const sliced = current.slice(-HOOK_OUTPUT_TAIL_MAX_BYTES);
			this.chunks[0] = sliced;
			this.bytes = Buffer.byteLength(sliced, "utf8");
		}
	}

	tail(opts: { cwd: string; env: Record<string, string> }): {
		text: string;
		truncated: boolean;
	} {
		return truncateHookOutputTail(redactHookOutput(this.chunks.join(""), opts));
	}
}

/**
 * Spawns user-provided shell hook scripts (cyrus-setup/cyrus-teardown) and
 * captures, redacts, and truncates their stdout/stderr before it is surfaced
 * to Linear. Deliberately not under `src/hooks/`, which already holds
 * Claude-Code integration hooks (IntentToAddHook/PrMarkerHook) — a different
 * meaning of "hook" that would collide.
 */
export class RepoHookScriptRunner {
	private logger: ILogger;

	constructor(logger: ILogger) {
		this.logger = logger;
	}

	/**
	 * Shared discovery+dispatch for repo-scoped hook scripts (setup and teardown).
	 * Looks in `workspacePath` for `cyrus-<hook>.{sh,ps1,cmd,bat}` and runs the
	 * first compatible variant with `cwd` set to `workspacePath`.
	 */
	async runRepoHookScript(opts: {
		hook: HookKind;
		workspacePath: string;
		env: Record<string, string>;
		timeoutMs: number;
		repositoryName?: string;
		issueIdentifier?: string;
		onRepoSetupHookEvent?: RepoSetupHookEventHandler;
	}): Promise<void> {
		const isWindows = process.platform === "win32";
		const candidates = [
			{ file: `cyrus-${opts.hook}.sh`, platform: "unix" as const },
			{ file: `cyrus-${opts.hook}.ps1`, platform: "windows" as const },
			{ file: `cyrus-${opts.hook}.cmd`, platform: "windows" as const },
			{ file: `cyrus-${opts.hook}.bat`, platform: "windows" as const },
		];

		const available = candidates.find((c) => {
			const scriptPath = join(opts.workspacePath, c.file);
			const isCompatible = isWindows
				? c.platform === "windows"
				: c.platform === "unix";
			return existsSync(scriptPath) && isCompatible;
		});

		// Windows fallback: try bash variant when no Windows-native script exists.
		const fallback =
			!available && isWindows
				? candidates.find((c) => {
						const scriptPath = join(opts.workspacePath, c.file);
						return c.platform === "unix" && existsSync(scriptPath);
					})
				: null;

		const scriptToRun = available || fallback;
		if (!scriptToRun) return;

		const scriptPath = join(opts.workspacePath, scriptToRun.file);
		await this.runHookScript({
			scriptPath,
			hook: opts.hook,
			originLabel: "repository",
			cwd: opts.workspacePath,
			env: opts.env,
			timeoutMs: opts.timeoutMs,
			repositoryName: opts.repositoryName,
			issueIdentifier: opts.issueIdentifier,
			onRepoSetupHookEvent: opts.onRepoSetupHookEvent,
		});
	}

	private async emitRepoSetupHookEvent(
		handler: RepoSetupHookEventHandler | undefined,
		event: Parameters<RepoSetupHookEventHandler>[0],
	): Promise<void> {
		if (!handler) return;
		try {
			await handler(event);
		} catch (error) {
			this.logger.warn(
				`Failed to post repository setup hook activity: ${(error as Error).message}`,
			);
		}
	}

	/**
	 * Run a hook script (setup or teardown) with proper error handling and logging.
	 * Failure is non-blocking — errors are logged and execution continues.
	 */
	async runHookScript(opts: HookScriptOptions): Promise<void> {
		const {
			scriptPath,
			hook,
			originLabel,
			cwd,
			env,
			timeoutMs,
			repositoryName,
			issueIdentifier,
			onRepoSetupHookEvent,
		} = opts;

		// Expand ~ to home directory
		const expandedPath = scriptPath.replace(/^~/, homedir());
		const labelTitle = `${originLabel.charAt(0).toUpperCase()}${originLabel.slice(1)} ${hook}`;
		const scriptName = basename(expandedPath);
		const shouldPostRepoSetupActivity = Boolean(
			originLabel === "repository" &&
				hook === "setup" &&
				issueIdentifier &&
				onRepoSetupHookEvent,
		);
		const startedAt = Date.now();

		if (!existsSync(expandedPath)) {
			this.logger.warn(`⚠️  ${labelTitle} script not found: ${scriptPath}`);
			return;
		}

		const runsThroughInterpreter =
			expandedPath.endsWith(".sh") || expandedPath.endsWith(".ps1");

		// Preserve legacy permission checks outside the Linear-visible repo setup
		// path. For visible repo setup hooks, interpreter-run scripts do not need
		// the executable bit because we invoke them as `bash script`.
		if (
			process.platform !== "win32" &&
			(!shouldPostRepoSetupActivity || !runsThroughInterpreter)
		) {
			try {
				const stats = statSync(expandedPath);
				if (!(stats.mode & 0o100)) {
					this.logger.warn(
						`⚠️  ${labelTitle} script is not executable: ${scriptPath}`,
					);
					this.logger.warn(`   Run: chmod +x "${expandedPath}"`);
					if (shouldPostRepoSetupActivity) {
						await this.emitRepoSetupHookEvent(onRepoSetupHookEvent, {
							status: "failed",
							issueIdentifier: issueIdentifier!,
							scriptName,
							repositoryName,
							durationMs: Date.now() - startedAt,
							errorMessage: "Repository setup hook is not executable",
							stderrTail:
								"Make cyrus-setup.sh executable in the repository and commit the executable bit: git update-index --chmod=+x cyrus-setup.sh",
							truncated: false,
						});
					}
					return;
				}
			} catch (error) {
				this.logger.warn(
					`⚠️  Cannot check permissions for ${labelTitle.toLowerCase()} script: ${(error as Error).message}`,
				);
				return;
			}
		}

		this.logger.info(
			`ℹ️  Running ${labelTitle.toLowerCase()} script: ${scriptName}`,
		);

		if (shouldPostRepoSetupActivity) {
			await this.emitRepoSetupHookEvent(onRepoSetupHookEvent, {
				status: "started",
				issueIdentifier: issueIdentifier!,
				scriptName,
				repositoryName,
			});
		}

		try {
			if (!shouldPostRepoSetupActivity) {
				this.runHookScriptInherited({
					scriptPath,
					expandedPath,
					cwd,
					env,
					timeoutMs,
				});

				this.logger.info(`✅ ${labelTitle} script completed successfully`);
				return;
			}

			let command: string;
			let args: string[];
			let shell = false;
			const isWindows = process.platform === "win32";
			if (scriptPath.endsWith(".ps1")) {
				command = "powershell";
				args = ["-ExecutionPolicy", "Bypass", "-File", expandedPath];
			} else if (scriptPath.endsWith(".cmd") || scriptPath.endsWith(".bat")) {
				command = expandedPath;
				args = [];
				shell = true;
			} else if (isWindows) {
				command = "bash";
				args = [expandedPath];
			} else {
				command = "bash";
				args = [expandedPath];
			}

			const stdoutCollector = new HookOutputCollector();
			const stderrCollector = new HookOutputCollector();
			await new Promise<void>((resolve, reject) => {
				const child = spawn(command, args, {
					cwd,
					env: {
						...process.env,
						...env,
					},
					shell,
				});
				let timedOut = false;
				const timeout = setTimeout(() => {
					timedOut = true;
					child.kill("SIGTERM");
				}, timeoutMs);

				child.stdout?.on("data", (chunk: Buffer) => {
					stdoutCollector.append(chunk);
					process.stdout.write(chunk);
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					stderrCollector.append(chunk);
					process.stderr.write(chunk);
				});
				child.on("error", (error) => {
					clearTimeout(timeout);
					(error as NodeExecError).message = error.message;
					reject(error);
				});
				child.on("close", (code, signal) => {
					clearTimeout(timeout);
					if (code === 0) {
						resolve();
						return;
					}
					const error = new Error(
						timedOut
							? "Script execution timed out"
							: `Script exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`,
					) as Error &
						NodeExecError & { stdoutTail?: string; stderrTail?: string };
					error.code = code === null ? undefined : code;
					error.signal = timedOut ? "SIGTERM" : (signal ?? undefined);
					const stdoutTail = stdoutCollector.tail({ cwd, env });
					const stderrTail = stderrCollector.tail({ cwd, env });
					error.stdoutTail = stdoutTail.text;
					error.stderrTail = stderrTail.text;
					(
						error as typeof error & { outputTruncated?: boolean }
					).outputTruncated = stdoutTail.truncated || stderrTail.truncated;
					reject(error);
				});
			});

			this.logger.info(`✅ ${labelTitle} script completed successfully`);
			if (shouldPostRepoSetupActivity) {
				await this.emitRepoSetupHookEvent(onRepoSetupHookEvent, {
					status: "succeeded",
					issueIdentifier: issueIdentifier!,
					scriptName,
					repositoryName,
					durationMs: Date.now() - startedAt,
				});
			}
		} catch (error) {
			const timeoutMinutes = Math.round(timeoutMs / 60_000);
			const isTimeout = isNodeExecError(error) && error.signal === "SIGTERM";
			const errorMessage = isTimeout
				? `Script execution timed out (exceeded ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"})`
				: error instanceof Error
					? error.message
					: String(error);

			this.logger.error(`❌ ${labelTitle} script failed: ${errorMessage}`);
			this.logger.info(`   Continuing despite ${hook} script failure...`);
			if (shouldPostRepoSetupActivity) {
				const nodeError = error as NodeExecError & {
					stdoutTail?: unknown;
					stderrTail?: unknown;
					outputTruncated?: unknown;
				};
				const stdoutTail =
					typeof nodeError.stdoutTail === "string"
						? nodeError.stdoutTail
						: undefined;
				const stderrTail =
					typeof nodeError.stderrTail === "string"
						? nodeError.stderrTail
						: undefined;
				await this.emitRepoSetupHookEvent(onRepoSetupHookEvent, {
					status: "failed",
					issueIdentifier: issueIdentifier!,
					scriptName,
					repositoryName,
					durationMs: Date.now() - startedAt,
					exitCode:
						typeof nodeError.code === "number" ? nodeError.code : undefined,
					signal: nodeError.signal,
					errorMessage: redactHookOutput(errorMessage, { cwd, env }),
					stdoutTail,
					stderrTail,
					truncated: nodeError.outputTruncated === true,
				});
			}
		}
	}

	private runHookScriptInherited(opts: {
		scriptPath: string;
		expandedPath: string;
		cwd: string;
		env: Record<string, string>;
		timeoutMs: number;
	}): void {
		const { scriptPath, expandedPath, cwd, env, timeoutMs } = opts;
		let command: string;
		const isWindows = process.platform === "win32";
		if (scriptPath.endsWith(".ps1")) {
			command = `powershell -ExecutionPolicy Bypass -File "${expandedPath}"`;
		} else if (scriptPath.endsWith(".cmd") || scriptPath.endsWith(".bat")) {
			command = `"${expandedPath}"`;
		} else if (isWindows) {
			command = `bash "${expandedPath}"`;
		} else {
			command = `bash "${expandedPath}"`;
		}

		execSync(command, {
			cwd,
			stdio: "inherit",
			env: {
				...process.env,
				...env,
			},
			timeout: timeoutMs,
		});
	}
}
