import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger, type ILogger, type RepositoryConfig } from "cyrus-core";

/**
 * Input for a single repository classification request.
 */
export interface ClassifyRepositoryInput {
	/** Human-readable issue identifier (e.g. "DEV-117") — used for logging/prompt context */
	issueIdentifier?: string;
	/** Issue title */
	issueTitle?: string;
	/** Issue description (Markdown) */
	issueDescription?: string;
	/** Candidate repositories to choose from (already filtered to the workspace) */
	repositories: RepositoryConfig[];
	/** Model alias or full ID to run the classification with (defaults to a fast model) */
	model?: string;
}

/**
 * Result of a successful classification.
 */
export interface ClassifyRepositoryResult {
	repository: RepositoryConfig;
}

/**
 * A function that runs the underlying model call and returns its raw text
 * output (or null on failure). Injectable so tests can exercise the parsing
 * and matching logic without spawning a Claude Code subprocess.
 */
export type RunClassification = (params: {
	systemPrompt: string;
	prompt: string;
	model: string;
	signal: AbortSignal;
}) => Promise<string | null>;

export interface RepositoryClassifierOptions {
	logger?: ILogger;
	/** Override the model call (defaults to the claude-agent-sdk `query()`) */
	runClassification?: RunClassification;
	/** Default model when the caller does not specify one */
	defaultModel?: string;
	/** How long to wait for the model before giving up (ms) */
	timeoutMs?: number;
}

/**
 * The `NONE` sentinel the model returns when no repository is a clear fit.
 */
const NONE_SENTINEL = "NONE";

/**
 * RepositoryClassifier uses an AI model to pick the single best-matching
 * repository for an issue when no explicit routing rule (description tag,
 * label, project, team, or catch-all) matched.
 *
 * It is intentionally best-effort: any error, timeout, ambiguous answer, or
 * `NONE` response resolves to `null` so callers fall back to asking the user
 * to pick a repository. It never throws.
 */
export class RepositoryClassifier {
	private logger: ILogger;
	private runClassification: RunClassification;
	private defaultModel: string;
	private timeoutMs: number;

	constructor(options: RepositoryClassifierOptions = {}) {
		this.logger =
			options.logger ?? createLogger({ component: "RepositoryClassifier" });
		this.defaultModel = options.defaultModel ?? "haiku";
		this.timeoutMs = options.timeoutMs ?? 45_000;
		this.runClassification =
			options.runClassification ?? this.runWithSdk.bind(this);
	}

	/**
	 * Infer the best repository for an issue. Returns `null` when the model is
	 * unavailable, uncertain, or its answer cannot be matched to a candidate.
	 */
	async classifyRepository(
		input: ClassifyRepositoryInput,
	): Promise<ClassifyRepositoryResult | null> {
		const repositories = input.repositories.filter(Boolean);
		if (repositories.length === 0) {
			return null;
		}
		// A single candidate needs no model — it is the only possible answer.
		if (repositories.length === 1) {
			const only = repositories[0]!;
			this.logger.info(
				`Only one candidate repository (${only.name}) — selecting without model`,
			);
			return { repository: only };
		}

		const model = input.model?.trim() || this.defaultModel;
		const systemPrompt = this.buildSystemPrompt();
		const prompt = this.buildPrompt(input, repositories);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		let raw: string | null = null;
		try {
			raw = await this.runClassification({
				systemPrompt,
				prompt,
				model,
				signal: controller.signal,
			});
		} catch (error) {
			this.logger.warn(
				`Repository classification failed for ${input.issueIdentifier ?? "issue"}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return null;
		} finally {
			clearTimeout(timer);
		}

		if (!raw) {
			this.logger.info(
				`Repository classification returned no answer for ${input.issueIdentifier ?? "issue"}`,
			);
			return null;
		}

		const matched = this.matchRepository(raw, repositories);
		if (!matched) {
			this.logger.info(
				`Repository classification for ${input.issueIdentifier ?? "issue"} did not resolve to a candidate (raw: ${JSON.stringify(
					raw.slice(0, 120),
				)})`,
			);
			return null;
		}

		this.logger.info(
			`Repository classification selected ${matched.name} for ${input.issueIdentifier ?? "issue"}`,
		);
		return { repository: matched };
	}

	/**
	 * Build the classifier system prompt. Kept terse and deterministic — the
	 * model must answer with a single repository name or the NONE sentinel.
	 */
	private buildSystemPrompt(): string {
		return [
			"You are a repository routing classifier for an autonomous coding agent.",
			"Given an issue and a list of candidate code repositories, choose the ONE repository where the work for this issue should happen.",
			"",
			"Rules:",
			"- Respond with ONLY the exact repository name from the list — nothing else.",
			"- No explanation, punctuation, quotes, code fences, or markdown.",
			`- If no repository is a clear fit, respond with exactly: ${NONE_SENTINEL}`,
		].join("\n");
	}

	/**
	 * Build the user prompt describing the issue and the candidate repositories.
	 */
	private buildPrompt(
		input: ClassifyRepositoryInput,
		repositories: RepositoryConfig[],
	): string {
		const lines: string[] = [];
		lines.push("## Issue");
		if (input.issueIdentifier) {
			lines.push(`Identifier: ${input.issueIdentifier}`);
		}
		lines.push(`Title: ${input.issueTitle?.trim() || "(no title)"}`);
		lines.push("Description:");
		lines.push(input.issueDescription?.trim() || "(no description)");
		lines.push("");
		lines.push("## Candidate repositories");
		repositories.forEach((repo, index) => {
			const hints: string[] = [];
			if (repo.githubUrl) hints.push(`url: ${repo.githubUrl}`);
			if (repo.teamKeys?.length)
				hints.push(`teams: ${repo.teamKeys.join(", ")}`);
			if (repo.projectKeys?.length)
				hints.push(`projects: ${repo.projectKeys.join(", ")}`);
			if (repo.routingLabels?.length)
				hints.push(`labels: ${repo.routingLabels.join(", ")}`);
			const suffix = hints.length ? ` (${hints.join(" | ")})` : "";
			lines.push(`${index + 1}. ${repo.name}${suffix}`);
		});
		lines.push("");
		lines.push(
			`Which repository should handle this issue? Respond with the exact repository name, or ${NONE_SENTINEL}.`,
		);
		return lines.join("\n");
	}

	/**
	 * Match the model's raw answer to one of the candidate repositories.
	 *
	 * Matching order (most to least strict):
	 * 1. NONE sentinel -> no match
	 * 2. Exact repository name (case-insensitive)
	 * 3. Exact GitHub URL
	 * 4. Leading list index (e.g. "2" or "2." or "2) name")
	 * 5. A repository name appearing as a whole word in the answer, only when unambiguous
	 */
	private matchRepository(
		raw: string,
		repositories: RepositoryConfig[],
	): RepositoryConfig | null {
		const cleaned = raw
			.trim()
			.replace(/^[`"'*\-\s]+/, "")
			.replace(/[`"'*.\s]+$/, "")
			.trim();
		if (!cleaned) return null;

		if (cleaned.toUpperCase() === NONE_SENTINEL) return null;

		const lower = cleaned.toLowerCase();

		// 2. Exact name match (case-insensitive)
		const byName = repositories.find(
			(repo) => repo.name.toLowerCase() === lower,
		);
		if (byName) return byName;

		// 3. Exact GitHub URL match
		const byUrl = repositories.find((repo) => repo.githubUrl === cleaned);
		if (byUrl) return byUrl;

		// 4. Leading list index (1-based)
		const indexMatch = cleaned.match(/^(\d+)/);
		if (indexMatch?.[1]) {
			const index = Number.parseInt(indexMatch[1], 10) - 1;
			if (index >= 0 && index < repositories.length) {
				return repositories[index]!;
			}
		}

		// 5. Unambiguous whole-word name containment
		const contained = repositories.filter((repo) => {
			const name = repo.name.toLowerCase();
			const pattern = new RegExp(
				`(?:^|\\W)${escapeRegExp(name)}(?:$|\\W)`,
				"i",
			);
			return pattern.test(lower);
		});
		if (contained.length === 1) return contained[0]!;

		return null;
	}

	/**
	 * Default classification runner backed by the claude-agent-sdk `query()`.
	 *
	 * Runs a single-turn, tool-free session with a custom system prompt. Auth
	 * (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN) is
	 * inherited from the parent process env — the SDK inherits `process.env`
	 * when `env` is omitted.
	 */
	private async runWithSdk(params: {
		systemPrompt: string;
		prompt: string;
		model: string;
		signal: AbortSignal;
	}): Promise<string | null> {
		const abortController = new AbortController();
		const onAbort = () => abortController.abort();
		if (params.signal.aborted) abortController.abort();
		else params.signal.addEventListener("abort", onAbort, { once: true });

		try {
			const response = query({
				prompt: params.prompt,
				options: {
					model: params.model,
					systemPrompt: params.systemPrompt,
					maxTurns: 1,
					allowedTools: [],
					disallowedTools: [],
					// Isolate the classifier from user/project settings, MCP servers,
					// and file-based config — it only needs the model.
					settingSources: [],
					mcpServers: {},
					permissionMode: "bypassPermissions",
					abortController,
				},
			});

			for await (const message of response) {
				if (message.type === "result") {
					if (message.subtype === "success") {
						return message.result;
					}
					return null;
				}
			}
			return null;
		} finally {
			params.signal.removeEventListener("abort", onAbort);
		}
	}
}

/**
 * Escape a string for safe use inside a RegExp.
 */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
