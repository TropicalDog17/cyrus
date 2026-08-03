import { spawn } from "node:child_process";
import {
	chmod,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgenticPipelineConfig } from "cyrus-core";
import type { z } from "zod";
import {
	type PipelineAbandonmentFact,
	PipelineAbandonmentFactSchema,
	type PipelineHumanFact,
	PipelineHumanFactSchema,
	type PipelineIntegrateResult,
	PipelineIntegrateResultSchema,
	type PipelineMergeFact,
	PipelineMergeFactSchema,
	type PipelinePrFact,
	PipelinePrFactSchema,
	type PipelineReview,
	PipelineReviewSchema,
	type PipelineWatch,
	PipelineWatchSchema,
} from "./pipelineSchemas.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export type { AgenticPipelineConfig } from "cyrus-core";

export interface AgenticPipelineClientOptions {
	config?: AgenticPipelineConfig;
	cyrusConfigPath: string;
	uvCommand?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

export type PipelineAvailability =
	| { available: true; projectPath: string; dataPath: string }
	| { available: false; reason: string };

export interface PipelineFinding {
	text: string;
	tag: "recurring" | "one-off";
}

export class PipelineUnavailableError extends Error {}
export class PipelineFactError extends Error {}
export class PipelineTimeoutError extends Error {}
export class PipelineCommandError extends Error {}

/**
 * The one process boundary to agentic-pipeline. It accepts only fixed argv,
 * validates stdout and durable facts, and deliberately does not retry: a later
 * webhook or reconciler owns retry policy.
 */
export class AgenticPipelineClient {
	readonly #configured?: AgenticPipelineConfig;
	readonly #cyrusConfigPath: string;
	readonly #uvCommand: string;
	readonly #timeoutMs: number;
	readonly #extraEnv: NodeJS.ProcessEnv;
	#availability?: Promise<PipelineAvailability>;

	constructor(options: AgenticPipelineClientOptions) {
		this.#configured = options.config;
		this.#cyrusConfigPath = options.cyrusConfigPath;
		this.#uvCommand = options.uvCommand ?? "uv";
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#extraEnv = options.env ?? {};
	}

	initialize(): Promise<PipelineAvailability> {
		this.#availability ??= this.resolveAvailability();
		return this.#availability;
	}

	async watch(repositoryName: string): Promise<PipelineWatch> {
		return PipelineWatchSchema.parse(
			await this.runJson(["pr-watch", "--repo", repositoryName]),
		);
	}

	async review(runId: string): Promise<PipelineReview> {
		return PipelineReviewSchema.parse(
			await this.runJson(["gate", "review", "--run-id", runId]),
		);
	}

	async recordHumanVerdict(
		runId: string,
		verdict: "approved" | "rejected" | "needs-rework",
		findings: readonly PipelineFinding[],
	): Promise<PipelineHumanFact> {
		const args = ["gate", "human", "--run-id", runId, "--verdict", verdict];
		for (const finding of findings) {
			args.push("--finding", `${finding.text}::${finding.tag}`);
		}
		await this.runJson(args);
		return this.readHumanFact(runId);
	}

	async reveal(runId: string): Promise<Record<string, unknown>> {
		return objectJson(
			await this.runJson(["gate", "reveal", "--run-id", runId]),
		);
	}

	async integrate(
		runId: string,
		repositoryPath: string,
	): Promise<{
		result: PipelineIntegrateResult;
		mergeFact?: PipelineMergeFact;
	}> {
		const result = PipelineIntegrateResultSchema.parse(
			await this.runJson([
				"integrate",
				"run",
				"--run-id",
				runId,
				"--repo-dir",
				repositoryPath,
			]),
		);
		return {
			result,
			mergeFact: result.integrated
				? await this.readMergeFact(runId)
				: undefined,
		};
	}

	async recordLearning(runId: string, repositoryName: string): Promise<void> {
		const record = await this.runJson([
			"learn",
			"assemble",
			"--run-id",
			runId,
			"--repo",
			repositoryName,
		]);
		const directory = await mkdtemp(join(tmpdir(), "cyrus-pipeline-learning-"));
		const recordPath = join(directory, "record.json");
		try {
			await writeFile(recordPath, `${JSON.stringify(record)}\n`, {
				mode: 0o600,
			});
			await chmod(recordPath, 0o600);
			await this.runJson(["learn", "record", recordPath, "--run-id", runId]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}

	async readPrFact(runId: string): Promise<PipelinePrFact> {
		return this.readFact(runId, "pr", PipelinePrFactSchema);
	}

	async readHumanFact(runId: string): Promise<PipelineHumanFact> {
		return this.readFact(runId, "human", PipelineHumanFactSchema);
	}

	async readMergeFact(runId: string): Promise<PipelineMergeFact> {
		return this.readFact(runId, "integrate", PipelineMergeFactSchema);
	}

	async readAbandonmentFact(runId: string): Promise<PipelineAbandonmentFact> {
		return this.readFact(runId, "abandoned", PipelineAbandonmentFactSchema);
	}

	private async resolveAvailability(): Promise<PipelineAvailability> {
		if (!this.#configured?.enabled) {
			return { available: false, reason: "agentic pipeline is disabled" };
		}
		try {
			const projectPath = await realpath(this.#configured.projectPath);
			if (!(await stat(projectPath)).isDirectory()) {
				return {
					available: false,
					reason: "agentic pipeline project is not a directory",
				};
			}
			const dataPath = this.#configured.dataPath
				? await realpathOrResolve(this.#configured.dataPath)
				: join(projectPath, "data");
			await this.runProcess(["--version"], { projectPath, dataPath });
			return { available: true, projectPath, dataPath };
		} catch (error) {
			return {
				available: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async runJson(args: string[]): Promise<unknown> {
		const availability = await this.initialize();
		if (!availability.available)
			throw new PipelineUnavailableError(availability.reason);
		const output = await this.runProcess(
			["run", "--project", availability.projectPath, ...args],
			availability,
		);
		try {
			return JSON.parse(output.stdout) as unknown;
		} catch (error) {
			throw new PipelineFactError(
				`Pipeline command emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async readFact<T extends z.ZodType>(
		runId: string,
		kind: "pr" | "human" | "integrate" | "abandoned",
		schema: T,
	): Promise<z.infer<T>> {
		const availability = await this.initialize();
		if (!availability.available)
			throw new PipelineUnavailableError(availability.reason);
		const path = join(availability.dataPath, "gates", `${runId}.${kind}.json`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		} catch (error) {
			throw new PipelineFactError(
				`Pipeline ${kind} fact for ${runId} is missing or malformed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const result = schema.safeParse(parsed);
		if (!result.success) {
			throw new PipelineFactError(
				`Pipeline ${kind} fact for ${runId} failed validation: ${result.error.message}`,
			);
		}
		return result.data;
	}

	private async runProcess(
		args: string[],
		availability: { projectPath: string; dataPath: string },
	): Promise<{ stdout: string; stderr: string }> {
		const { promise, resolve, reject } = promiseWithResolvers<{
			stdout: string;
			stderr: string;
		}>();
		const child = spawn(this.#uvCommand, args, {
			cwd: availability.projectPath,
			detached: process.platform !== "win32",
			env: {
				...process.env,
				...this.#extraEnv,
				AGENTIC_PIPELINE_ROOT: availability.projectPath,
				AGENTIC_PIPELINE_DATA: availability.dataPath,
				CYRUS_CONFIG: this.#cyrusConfigPath,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			terminateProcessGroup(child.pid);
		}, this.#timeoutMs);
		const hardKill = setTimeout(() => {
			if (timedOut) terminateProcessGroup(child.pid, "SIGKILL");
		}, this.#timeoutMs + 1_000);

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			clearTimeout(hardKill);
			reject(new PipelineCommandError(error.message));
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			clearTimeout(hardKill);
			if (timedOut) {
				reject(
					new PipelineTimeoutError(
						`Pipeline command timed out after ${this.#timeoutMs}ms`,
					),
				);
				return;
			}
			if (code !== 0) {
				reject(
					new PipelineCommandError(
						`Pipeline command exited with ${code ?? "unknown"}${signal ? ` (${signal})` : ""}: ${stderr.trim()}`,
					),
				);
				return;
			}
			resolve({ stdout, stderr });
		});
		return promise;
	}
}

function objectJson(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new PipelineFactError(
			"Pipeline command emitted a non-object JSON result",
		);
	}
	return value as Record<string, unknown>;
}

function promiseWithResolvers<T>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	return (
		Promise as PromiseConstructor & {
			withResolvers: <Value>() => {
				promise: Promise<Value>;
				resolve: (value: Value | PromiseLike<Value>) => void;
				reject: (reason?: unknown) => void;
			};
		}
	).withResolvers<T>();
}

async function realpathOrResolve(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return path;
	}
}

function terminateProcessGroup(
	pid: number | undefined,
	signal: NodeJS.Signals = "SIGTERM",
): void {
	if (!pid) return;
	try {
		if (process.platform !== "win32") {
			process.kill(-pid, signal);
			return;
		}
		process.kill(pid, signal);
	} catch {
		// The child may have exited between the timer firing and termination.
	}
}
