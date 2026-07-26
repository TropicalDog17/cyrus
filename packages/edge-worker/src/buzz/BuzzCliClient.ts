import { spawn } from "node:child_process";
import { createLogger, type ILogger } from "cyrus-core";

/**
 * A Nostr event as normalized by buzz-cli's `normalize_events`. Only the
 * `messages` / `channels` / `reactions` command groups normalize their output;
 * `issues` / `pr` / `patches` print the raw relay response, so do not assume
 * this shape outside the commands wrapped here.
 */
export interface BuzzEventRecord {
	id: string;
	pubkey: string;
	kind: number;
	content: string;
	created_at: number;
	tags: string[][];
}

/** One emoji's worth of `reactions get` output, grouped by buzz-cli. */
export interface BuzzReactionGroup {
	emoji: string;
	count: number;
	pubkeys: string[];
}

/** Shape of buzz-cli's `reactions get` output. */
interface BuzzReactionsResponse {
	reactions?: BuzzReactionGroup[];
}

/** Shape of buzz-cli's normalized write response (`normalize_write_response`). */
interface BuzzWriteResponse {
	event_id?: string;
	accepted?: boolean;
	message?: string;
}

/** Shape of buzz-cli's structured stderr error (`print_error`). */
interface BuzzCliErrorPayload {
	error?: string;
	message?: string;
	retryable?: boolean;
}

export interface BuzzCliConfig {
	/**
	 * Path to the Buzz CLI binary. NOTE: upstream's crate is named `buzz-cli`
	 * but the binary it produces is named **`buzz`** — pointing this at
	 * `buzz-cli` fails with ENOENT.
	 */
	binaryPath: string;
	/** Relay base URL, passed as `BUZZ_RELAY_URL`. */
	relayUrl: string;
	/** Nostr private key (hex or nsec). This is the agent's identity. */
	privateKey: string;
	/** Optional NIP-OA owner attestation tag, passed as `BUZZ_AUTH_TAG`. */
	authTag?: string;
	/** Per-invocation timeout. Each command is a fresh process + relay call. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** buzz-cli exit code for a NIP-33 write conflict. */
const EXIT_CONFLICT = 5;

export class BuzzCliError extends Error {
	constructor(
		message: string,
		readonly exitCode: number | null,
		readonly category: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "BuzzCliError";
	}
}

/**
 * Thin wrapper over the `buzz` CLI.
 *
 * Cyrus shells out rather than speaking Nostr directly: upstream owns event
 * schemas, NIP-98 request signing and NIP-OA attestation, and re-implementing
 * that crypto in TypeScript before the loop is proven end-to-end would be a
 * large, duplicated surface. Every method here maps to exactly one documented
 * subcommand, which keeps the blast radius of an upstream CLI change to this
 * file (see `BuzzCliClient.contract.test.ts`).
 *
 * The keypair *is* the identity — there is no token and no config file — so
 * credentials travel in the environment, never on argv where `ps` would show
 * them.
 */
export class BuzzCliClient {
	private readonly config: BuzzCliConfig;
	private readonly logger: ILogger;

	constructor(config: BuzzCliConfig, logger?: ILogger) {
		this.config = config;
		this.logger = logger ?? createLogger({ component: "BuzzCliClient" });
	}

	/**
	 * Post a message to a channel. When `replyTo` is set the message threads
	 * under it; buzz-cli resolves the NIP-10 thread root itself by fetching the
	 * parent, so passing any event in the thread is correct.
	 *
	 * @returns the new event's id
	 */
	async sendMessage(params: {
		channelId: string;
		content: string;
		replyTo?: string;
	}): Promise<string> {
		const args = [
			"messages",
			"send",
			"--channel",
			params.channelId,
			// `-` makes buzz-cli read the body from stdin. Passing the body on
			// argv would break on newlines and leak message text into `ps`.
			"--content",
			"-",
		];
		if (params.replyTo) {
			args.push("--reply-to", params.replyTo);
		}

		const stdout = await this.run(args, params.content);
		const parsed = this.parseJson<BuzzWriteResponse>(stdout, "messages send");

		if (parsed?.accepted === false) {
			throw new BuzzCliError(
				`Relay rejected message: ${parsed.message ?? "no reason given"}`,
				0,
				"relay_error",
				false,
			);
		}
		return parsed?.event_id ?? "";
	}

	/** Add an emoji reaction to an event. */
	async addReaction(params: { eventId: string; emoji: string }): Promise<void> {
		await this.run([
			"reactions",
			"add",
			"--event",
			params.eventId,
			"--emoji",
			params.emoji,
		]);
	}

	/**
	 * Fetch a thread: the event named by `eventId` plus every reply that
	 * references it. buzz-cli ORs a `{"ids":[event]}` filter into the query, so
	 * the named event is always included when it exists.
	 */
	async getThread(params: {
		channelId: string;
		eventId: string;
	}): Promise<BuzzEventRecord[]> {
		const stdout = await this.run([
			"messages",
			"thread",
			"--channel",
			params.channelId,
			"--event",
			params.eventId,
		]);
		return this.parseJson<BuzzEventRecord[]>(stdout, "messages thread") ?? [];
	}

	/**
	 * Fetch recent messages in a channel, oldest first.
	 *
	 * `since` is the Nostr filter bound and is **inclusive**, so the event that
	 * set the previous high-water mark comes back on the next call. Callers must
	 * dedupe by event id rather than trusting the window.
	 */
	async getMessages(params: {
		channelId: string;
		since?: number;
		limit?: number;
	}): Promise<BuzzEventRecord[]> {
		const args = ["messages", "get", "--channel", params.channelId];
		if (params.since !== undefined) {
			args.push("--since", String(params.since));
		}
		if (params.limit !== undefined) {
			args.push("--limit", String(params.limit));
		}

		const stdout = await this.run(args);
		return this.parseJson<BuzzEventRecord[]>(stdout, "messages get") ?? [];
	}

	/**
	 * List reactions on an event, grouped by emoji with the reacting pubkeys.
	 *
	 * buzz-cli returns the *current* set rather than a delta, so callers poll
	 * this and diff against what they have already acted on.
	 */
	async getReactions(params: {
		eventId: string;
	}): Promise<BuzzReactionGroup[]> {
		const stdout = await this.run([
			"reactions",
			"get",
			"--event",
			params.eventId,
		]);
		const parsed = this.parseJson<BuzzReactionsResponse>(
			stdout,
			"reactions get",
		);
		return parsed?.reactions ?? [];
	}

	/** Fetch a single event by id, or null when the relay does not have it. */
	async getEvent(params: {
		channelId: string;
		eventId: string;
	}): Promise<BuzzEventRecord | null> {
		const thread = await this.getThread(params);
		return thread.find((event) => event.id === params.eventId) ?? null;
	}

	/**
	 * Verify the binary is present and speaks the CLI surface we compiled
	 * against. Called once at startup so an unbuilt or drifted `buzz` fails
	 * loudly instead of at the first reply attempt.
	 */
	async checkAvailable(): Promise<void> {
		const help = await this.run(["messages", "send", "--help"]);
		for (const flag of ["--channel", "--content", "--reply-to"]) {
			if (!help.includes(flag)) {
				throw new BuzzCliError(
					`buzz-cli drift: 'messages send' no longer documents ${flag}`,
					0,
					"contract_drift",
					false,
				);
			}
		}
	}

	private parseJson<T>(stdout: string, command: string): T | null {
		const trimmed = stdout.trim();
		if (!trimmed) return null;
		try {
			return JSON.parse(trimmed) as T;
		} catch {
			this.logger.warn(
				`Could not parse buzz-cli '${command}' output as JSON: ${trimmed.slice(0, 200)}`,
			);
			return null;
		}
	}

	/**
	 * Run one buzz-cli invocation. Rejects with {@link BuzzCliError} carrying
	 * the CLI's own error category and retryability when it exits non-zero.
	 */
	private run(args: string[], stdin?: string): Promise<string> {
		const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		return new Promise((resolve, reject) => {
			const child = spawn(this.config.binaryPath, args, {
				env: {
					...process.env,
					BUZZ_RELAY_URL: this.config.relayUrl,
					BUZZ_PRIVATE_KEY: this.config.privateKey,
					...(this.config.authTag
						? { BUZZ_AUTH_TAG: this.config.authTag }
						: {}),
				},
				stdio: ["pipe", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			let settled = false;

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				child.kill("SIGKILL");
				reject(
					new BuzzCliError(
						`buzz ${args[0]} ${args[1]} timed out after ${timeoutMs}ms`,
						null,
						"timeout",
						true,
					),
				);
			}, timeoutMs);

			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});

			child.on("error", (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				const hint =
					(error as NodeJS.ErrnoException).code === "ENOENT"
						? ` (is '${this.config.binaryPath}' built? the buzz-cli crate produces a binary named 'buzz')`
						: "";
				reject(
					new BuzzCliError(
						`Failed to run buzz CLI${hint}: ${error.message}`,
						null,
						"spawn_error",
						false,
					),
				);
			});

			child.on("close", (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);

				if (code === 0) {
					resolve(stdout);
					return;
				}

				// buzz-cli reports failures as a JSON object on stderr.
				let category = "error";
				let message = stderr.trim() || `buzz exited with code ${code}`;
				let retryable = code === EXIT_CONFLICT;
				try {
					const parsed = JSON.parse(stderr.trim()) as BuzzCliErrorPayload;
					category = parsed.error ?? category;
					message = parsed.message ?? message;
					retryable = parsed.retryable ?? retryable;
				} catch {
					// Non-JSON stderr (e.g. a panic) — keep the raw text.
				}

				reject(
					new BuzzCliError(
						`buzz ${args.slice(0, 2).join(" ")} failed: ${message}`,
						code,
						category,
						retryable,
					),
				);
			});

			if (stdin !== undefined) {
				child.stdin.end(stdin);
			} else {
				child.stdin.end();
			}
		});
	}
}
