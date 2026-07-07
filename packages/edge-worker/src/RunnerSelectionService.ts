import type { EdgeWorkerConfig, RunnerType } from "cyrus-core";

/**
 * Resolves the runner type and model for a session.
 *
 * This fork runs Claude only, so `runnerType` is always "claude". The service
 * still resolves the Claude model (and fallback model) from labels and issue
 * description `[model=...]` tags, with the repository/global defaults as the
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
	 * Determine the default runner type. Always "claude" in this fork.
	 */
	public getDefaultRunner(): RunnerType {
		return "claude";
	}

	/**
	 * Resolve the default Claude model from config with a sensible built-in default.
	 */
	public getDefaultModelForRunner(_runnerType: RunnerType = "claude"): string {
		return this.config.claudeDefaultModel || this.config.defaultModel || "opus";
	}

	/**
	 * Resolve the default Claude fallback model from config with a sensible
	 * built-in default. Supports the legacy Claude fallback key for backwards
	 * compatibility.
	 */
	public getDefaultFallbackModelForRunner(
		_runnerType: RunnerType = "claude",
	): string {
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
	 * Determine the model (and fallback model) for a Claude session using
	 * labels + issue description tags.
	 *
	 * Supported description tags:
	 * - [model=<model-name>]
	 *
	 * Precedence:
	 * 1. Description `[model=...]` tag overrides labels
	 * 2. Model labels (fable/opus/sonnet/haiku or a `claude-*` name)
	 * 3. Repository / global defaults
	 */
	public determineRunnerSelection(
		labels: string[],
		issueDescription?: string,
	): {
		runnerType: RunnerType;
		modelOverride?: string;
		fallbackModelOverride?: string;
	} {
		const normalizedLabels = (labels || []).map((label) => label.toLowerCase());
		const normalizedDescription = issueDescription || "";
		const descriptionModelTagRaw = this.parseDescriptionTag(
			normalizedDescription,
			"model",
		);

		const resolveModelFromLabel = (
			lowercaseLabels: string[],
		): string | undefined => {
			if (lowercaseLabels.includes("fable")) return "fable";
			if (lowercaseLabels.includes("opus")) return "opus";
			if (lowercaseLabels.includes("sonnet")) return "sonnet";
			if (lowercaseLabels.includes("haiku")) return "haiku";
			return undefined;
		};

		const inferFallbackModel = (model: string): string | undefined => {
			const normalizedModel = model.toLowerCase();
			if (normalizedModel === "fable") return "opus";
			if (normalizedModel === "opus") return "sonnet";
			if (normalizedModel === "sonnet") return "haiku";
			// Keep haiku fallback on sonnet for retry behavior
			if (normalizedModel === "haiku") return "sonnet";
			return "sonnet";
		};

		const modelFromDescription = descriptionModelTagRaw;
		const modelFromLabels = resolveModelFromLabel(normalizedLabels);
		const explicitModel = modelFromDescription || modelFromLabels;

		const resolvedModelOverride =
			explicitModel || this.getDefaultModelForRunner("claude");

		const fallbackModelOverride =
			inferFallbackModel(resolvedModelOverride) ||
			this.getDefaultFallbackModelForRunner("claude");

		return {
			runnerType: "claude",
			modelOverride: resolvedModelOverride,
			fallbackModelOverride,
		};
	}
}
