import type { EdgeWorkerConfig, RunnerType } from "cyrus-core";

/**
 * Built-in default Cursor model when none is configured. Cursor's SDK resolves
 * model ids server-side. "composer-2.5" selects Composer 2.5, whose default
 * speed tier is "Fast" — there is no separate `composer-2.5-fast` slug. Override
 * via `cursorDefaultModel` / `CYRUS_CURSOR_DEFAULT_MODEL` if your account exposes
 * a different id (check `cursor-agent --list-models`).
 */
const CURSOR_DEFAULT_MODEL = "composer-2.5";

/**
 * Built-in default Codex model when none is configured. The Codex ACP adapter
 * resolves model ids against the OpenAI backend; "gpt-5-codex" is Codex's
 * flagship coding model. Override via `codexDefaultModel` if your account
 * exposes a different id.
 */
const CODEX_DEFAULT_MODEL = "gpt-5-codex";

/**
 * Resolves the runner type and model for a session.
 *
 * This fork supports four runners: Claude (default), Cursor, Codex, and Pi. The
 * runner is chosen from an `[agent=...]` description tag, a
 * `cursor`/`claude`/`codex`/`pi` label, or an explicit model whose family implies
 * the runner; otherwise it falls back to the configured `defaultRunner` (or
 * Claude). The service also resolves the model + fallback model from labels and
 * the `[model=...]` description tag, with repository/global defaults as the
 * baseline.
 */
export class RunnerSelectionService {
	private config: EdgeWorkerConfig;

	constructor(config: EdgeWorkerConfig) {
		this.config = config;
	}

	/**
	 * Update the internal config reference (e.g. after hot-reload).
	 */
	setConfig(config: EdgeWorkerConfig): void {
		this.config = config;
	}

	/**
	 * Determine the default runner type.
	 *
	 * Priority:
	 * 1. Explicit `defaultRunner` in config
	 * 2. Auto-detect from available API keys (only Cursor if its key is the sole
	 *    one configured)
	 * 3. Fall back to "claude"
	 */
	public getDefaultRunner(): RunnerType {
		if (this.config.defaultRunner) {
			return this.config.defaultRunner;
		}

		const hasClaude = Boolean(
			process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
		);
		const hasCursor = Boolean(process.env.CURSOR_API_KEY);
		const hasCodex = Boolean(
			process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY,
		);

		// If Cursor is the only runner with credentials configured, default to it.
		if (hasCursor && !hasClaude && !hasCodex) {
			return "cursor";
		}

		// If Codex is the only runner with credentials configured, default to it.
		if (hasCodex && !hasClaude && !hasCursor) {
			return "codex";
		}

		return "claude";
	}

	/**
	 * Resolve the default model for a runner from config with sensible built-in
	 * defaults.
	 */
	public getDefaultModelForRunner(runnerType: RunnerType = "claude"): string {
		if (runnerType === "cursor") {
			return this.config.cursorDefaultModel || CURSOR_DEFAULT_MODEL;
		}
		if (runnerType === "codex") {
			return this.config.codexDefaultModel || CODEX_DEFAULT_MODEL;
		}
		if (runnerType === "pi") {
			// Pi is provider-neutral and persists its own selected model. An empty
			// value deliberately means "do not pass --model".
			return this.config.piDefaultModel || "";
		}
		return this.config.claudeDefaultModel || this.config.defaultModel || "opus";
	}

	/**
	 * Resolve the default fallback model for a runner from config with sensible
	 * built-in defaults. Supports the legacy Claude fallback key for backwards
	 * compatibility.
	 */
	public getDefaultFallbackModelForRunner(
		runnerType: RunnerType = "claude",
	): string {
		if (runnerType === "cursor") {
			return this.config.cursorDefaultFallbackModel || CURSOR_DEFAULT_MODEL;
		}
		if (runnerType === "codex") {
			return this.config.codexDefaultFallbackModel || CODEX_DEFAULT_MODEL;
		}
		if (runnerType === "pi") {
			// Pi owns provider fallback behavior; Cyrus only selects its primary.
			return this.config.piDefaultModel || "";
		}
		return (
			this.config.claudeDefaultFallbackModel ||
			this.config.defaultFallbackModel ||
			"sonnet"
		);
	}

	/**
	 * Parse a bracketed tag from issue description.
	 *
	 * Supports escaped brackets (`\\[tag=value\\]`) which Linear can emit.
	 */
	public parseDescriptionTag(
		description: string,
		tagName: string,
	): string | undefined {
		const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(
			`\\\\?\\[${escapedTag}=([a-zA-Z0-9_.:/-]+)\\\\?\\]`,
			"i",
		);
		const match = description.match(pattern);
		return match?.[1];
	}

	/**
	 * Determine the runner type, model, and fallback model using labels + issue
	 * description tags.
	 *
	 * Supported description tags:
	 * - [agent=claude|cursor|codex|pi]
	 * - [model=<model-name>]
	 *
	 * This is the single source of truth for model precedence. Callers pass any
	 * configured model sources via `opts`; do NOT re-resolve models downstream.
	 *
	 * Explicit-model precedence (highest first):
	 * 1. `[model=…]` description tag
	 * 2. Model label (e.g. `opus`, `composer-1`, `gpt-5`)
	 * 3. `opts.labelPromptModel` — matched label-prompt config's `model`
	 * 4. `opts.repositoryModel` — repository config's `model`
	 *
	 * Runner precedence (highest first):
	 * 1. Description tags override labels
	 * 2. Agent (`cursor`/`claude`/`codex`/`pi`) labels override model labels
	 * 3. Model labels / explicit models can infer the agent type (e.g.
	 *    `composer-*` → cursor, `gpt-*`/`o3`/`*codex*` → codex)
	 * 4. Falls back to the configured default runner
	 *
	 * An explicit model whose inferred runner family conflicts with the resolved
	 * runner is dropped (the runner falls back to its default model). The same
	 * guard applies to `opts.repositoryFallbackModel`.
	 */
	public determineRunnerSelection(
		labels: string[],
		issueDescription?: string,
		opts?: {
			labelPromptModel?: string;
			repositoryModel?: string;
			repositoryFallbackModel?: string;
		},
	): {
		runnerType: RunnerType;
		modelOverride?: string;
		fallbackModelOverride?: string;
	} {
		const normalizedLabels = (labels || []).map((label) => label.toLowerCase());
		const normalizedDescription = issueDescription || "";
		const descriptionAgentTagRaw = this.parseDescriptionTag(
			normalizedDescription,
			"agent",
		);
		const descriptionModelTagRaw = this.parseDescriptionTag(
			normalizedDescription,
			"model",
		);

		const isCursorModel = (model: string): boolean =>
			/^composer[a-z0-9.-]*$/i.test(model);

		// Codex/OpenAI model families: gpt-*, the o-series reasoning models
		// (o1/o3/o4-mini…), and anything carrying the `codex` marker.
		const isCodexModel = (model: string): boolean =>
			/^gpt[-0-9]/i.test(model) ||
			/^o[0-9]/i.test(model) ||
			/codex/i.test(model);

		const inferRunnerFromModel = (model?: string): RunnerType | undefined => {
			if (!model) return undefined;
			const normalizedModel = model.toLowerCase();
			if (isCursorModel(normalizedModel)) return "cursor";
			if (isCodexModel(normalizedModel)) return "codex";
			if (
				normalizedModel === "fable" ||
				normalizedModel === "opus" ||
				normalizedModel === "sonnet" ||
				normalizedModel === "haiku" ||
				normalizedModel.startsWith("claude")
			) {
				return "claude";
			}
			return undefined;
		};

		const inferFallbackModel = (
			model: string,
			runnerType: RunnerType,
		): string | undefined => {
			if (runnerType === "pi") {
				return this.getDefaultFallbackModelForRunner("pi");
			}
			const normalizedModel = model.toLowerCase();
			if (runnerType === "cursor") {
				return this.getDefaultFallbackModelForRunner("cursor");
			}
			if (runnerType === "codex") {
				return this.getDefaultFallbackModelForRunner("codex");
			}
			if (normalizedModel === "fable") return "opus";
			if (normalizedModel === "opus") return "sonnet";
			if (normalizedModel === "sonnet") return "haiku";
			// Keep haiku fallback on sonnet for retry behavior
			if (normalizedModel === "haiku") return "sonnet";
			return "sonnet";
		};

		const resolveAgentFromLabel = (
			lowercaseLabels: string[],
		): RunnerType | undefined => {
			if (lowercaseLabels.includes("cursor")) return "cursor";
			if (lowercaseLabels.includes("codex")) return "codex";
			if (lowercaseLabels.includes("pi")) return "pi";
			if (lowercaseLabels.includes("claude")) return "claude";
			return undefined;
		};

		const resolveModelFromLabel = (
			lowercaseLabels: string[],
		): string | undefined => {
			const cursorModelLabel = lowercaseLabels.find((label) =>
				isCursorModel(label),
			);
			if (cursorModelLabel) return cursorModelLabel;

			// Exclude the bare `codex` agent-selector label — it routes the runner,
			// it is not a model id (unlike `gpt-5-codex`, which is).
			const codexModelLabel = lowercaseLabels.find(
				(label) => label !== "codex" && isCodexModel(label),
			);
			if (codexModelLabel) return codexModelLabel;

			if (lowercaseLabels.includes("fable")) return "fable";
			if (lowercaseLabels.includes("opus")) return "opus";
			if (lowercaseLabels.includes("sonnet")) return "sonnet";
			if (lowercaseLabels.includes("haiku")) return "haiku";

			return undefined;
		};

		const agentFromDescription = descriptionAgentTagRaw?.toLowerCase();
		const resolvedAgentFromDescription: RunnerType | undefined =
			agentFromDescription === "cursor"
				? "cursor"
				: agentFromDescription === "codex"
					? "codex"
					: agentFromDescription === "pi"
						? "pi"
						: agentFromDescription === "claude"
							? "claude"
							: undefined;
		const resolvedAgentFromLabels = resolveAgentFromLabel(normalizedLabels);

		const modelFromDescription = descriptionModelTagRaw;
		const modelFromLabels = resolveModelFromLabel(normalizedLabels);
		const explicitModel =
			modelFromDescription ||
			modelFromLabels ||
			opts?.labelPromptModel ||
			opts?.repositoryModel;

		const runnerType: RunnerType =
			resolvedAgentFromDescription ||
			resolvedAgentFromLabels ||
			inferRunnerFromModel(explicitModel) ||
			this.getDefaultRunner();

		// If an explicit agent conflicts with the model's implied runner, keep the
		// agent and drop the (mismatched) model so we fall back to the runner default.
		const modelRunner = inferRunnerFromModel(explicitModel);
		let modelOverride = explicitModel;
		if (
			runnerType !== "pi" &&
			modelOverride &&
			modelRunner &&
			modelRunner !== runnerType
		) {
			modelOverride = undefined;
		}

		const resolvedModelOverride =
			modelOverride || this.getDefaultModelForRunner(runnerType);

		// Repository-configured fallback model, honored only when its inferred
		// family matches the resolved runner (mirrors the primary-model guard).
		let repositoryFallbackOverride = opts?.repositoryFallbackModel;
		if (repositoryFallbackOverride) {
			const fallbackRunner = inferRunnerFromModel(repositoryFallbackOverride);
			if (
				runnerType !== "pi" &&
				fallbackRunner &&
				fallbackRunner !== runnerType
			) {
				repositoryFallbackOverride = undefined;
			}
		}

		const fallbackModelOverride =
			repositoryFallbackOverride ||
			inferFallbackModel(resolvedModelOverride, runnerType) ||
			this.getDefaultFallbackModelForRunner(runnerType);

		return {
			runnerType,
			modelOverride: resolvedModelOverride,
			fallbackModelOverride,
		};
	}
}
