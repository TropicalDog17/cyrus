import type { EdgeWorkerConfig } from "cyrus-core";
import type { AgentProfileRegistry } from "./agents/AgentProfileRegistry.js";
import { AgentProfileRegistry as Registry } from "./agents/AgentProfileRegistry.js";
import { BUILT_IN_PROFILES } from "./agents/builtInProfiles.js";

/**
 * Resolves the agent profile and model for a session.
 *
 * The runner is chosen from an `[agent=...]` description tag, an explicit
 * agent label (`claude`/`cursor`/`codex`, or the canary `omp`), an explicit
 * model whose family implies the profile, or the configured default —
 * resolved through the built-in profile registry (ADR 0009), never through a
 * `RunnerType` extension. The service also resolves the model + fallback
 * model from labels and the `[model=...]` description tag, with
 * repository/global defaults as the baseline.
 */
export class RunnerSelectionService {
	private config: EdgeWorkerConfig;
	private registry: AgentProfileRegistry;

	constructor(
		config: EdgeWorkerConfig,
		registry: AgentProfileRegistry = new Registry(BUILT_IN_PROFILES),
	) {
		this.config = config;
		this.registry = registry;
	}

	/**
	 * Update the internal config reference (e.g. after hot-reload).
	 */
	setConfig(config: EdgeWorkerConfig): void {
		this.config = config;
	}

	/**
	 * Determine the default agent profile id.
	 *
	 * Priority:
	 * 1. Explicit `defaultAgentProfile` (or the `defaultRunner` alias) in config
	 * 2. Auto-detect from available API keys (only Cursor/Codex if it is the
	 *    sole runner with credentials)
	 * 3. Fall back to "claude"
	 */
	public getDefaultRunner(): string {
		return this.registry.resolveDefault(this.config).id;
	}

	/**
	 * Resolve the default model for a profile from config with sensible
	 * built-in defaults (delegates to the profile definition).
	 */
	public getDefaultModelForRunner(profileId: string = "claude"): string {
		return (
			this.registry.defaultModelFor(profileId, this.config) ??
			this.registry.defaultModelFor("claude", this.config) ??
			"opus"
		);
	}

	/**
	 * Resolve the default fallback model for a profile from config with
	 * sensible built-in defaults (delegates to the profile definition).
	 */
	public getDefaultFallbackModelForRunner(
		profileId: string = "claude",
	): string {
		return (
			this.registry.defaultFallbackModelFor(profileId, this.config) ??
			this.registry.defaultFallbackModelFor("claude", this.config) ??
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
	 * Determine the agent profile id, model, and fallback model using labels +
	 * issue description tags.
	 *
	 * Supported description tags:
	 * - [agent=claude|cursor|codex|omp]
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
	 * Profile precedence (highest first):
	 * 1. Description `[agent=…]` tags override labels
	 * 2. Explicit agent labels (`claude`/`cursor`/`codex`/`omp`)
	 * 3. Model labels / explicit models can infer the profile family (e.g.
	 *    `composer-*` → cursor, `gpt-*`/`o3`/`*codex*` → codex)
	 * 4. Falls back to the configured default (never a canary profile)
	 *
	 * An explicit model whose inferred profile family conflicts with the
	 * resolved profile is dropped (the profile falls back to its default
	 * model). The same guard applies to `opts.repositoryFallbackModel`.
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
		agentProfileId: string;
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

		const resolveModelFromLabel = (
			lowercaseLabels: string[],
		): string | undefined => {
			const cursorModelLabel = lowercaseLabels.find((label) =>
				/^composer[a-z0-9.-]*$/i.test(label),
			);
			if (cursorModelLabel) return cursorModelLabel;

			// Exclude the bare `codex` agent-selector label — it routes the
			// profile, it is not a model id (unlike `gpt-5-codex`, which is).
			const codexModelLabel = lowercaseLabels.find(
				(label) =>
					label !== "codex" &&
					(/^gpt[-0-9]/i.test(label) ||
						/^o[0-9]/i.test(label) ||
						/codex/i.test(label)),
			);
			if (codexModelLabel) return codexModelLabel;

			if (lowercaseLabels.includes("fable")) return "fable";
			if (lowercaseLabels.includes("opus")) return "opus";
			if (lowercaseLabels.includes("sonnet")) return "sonnet";
			if (lowercaseLabels.includes("haiku")) return "haiku";

			return undefined;
		};

		const modelFromDescription = descriptionModelTagRaw;
		const modelFromLabels = resolveModelFromLabel(normalizedLabels);
		const explicitModel =
			modelFromDescription ||
			modelFromLabels ||
			opts?.labelPromptModel ||
			opts?.repositoryModel;

		// Profile precedence: description tag → labels → model family → default.
		const profileFromDescription = descriptionAgentTagRaw
			? this.registry.resolveByLabel([descriptionAgentTagRaw])
			: undefined;
		const profileFromLabels = this.registry.resolveByLabel(normalizedLabels);
		const profileFromModel = explicitModel
			? this.registry.resolveByModel(explicitModel)
			: undefined;
		const defaultProfile = this.registry.resolveDefault(this.config);

		const agentProfileId =
			profileFromDescription?.id ??
			profileFromLabels?.id ??
			profileFromModel?.id ??
			defaultProfile.id;

		// If an explicit agent conflicts with the model's implied profile, keep
		// the agent and drop the (mismatched) model so we fall back to the
		// profile default.
		let modelOverride = explicitModel;
		if (
			modelOverride &&
			profileFromModel &&
			profileFromModel.id !== agentProfileId
		) {
			modelOverride = undefined;
		}

		const resolvedModelOverride =
			modelOverride || this.getDefaultModelForRunner(agentProfileId);

		// Repository-configured fallback model, honored only when its inferred
		// family matches the resolved profile (mirrors the primary-model guard).
		let repositoryFallbackOverride = opts?.repositoryFallbackModel;
		if (repositoryFallbackOverride) {
			const fallbackProfile = this.registry.resolveByModel(
				repositoryFallbackOverride,
			);
			if (fallbackProfile && fallbackProfile.id !== agentProfileId) {
				repositoryFallbackOverride = undefined;
			}
		}

		const fallbackModelOverride =
			repositoryFallbackOverride ||
			this.inferFallbackModel(resolvedModelOverride, agentProfileId) ||
			this.getDefaultFallbackModelForRunner(agentProfileId);

		return {
			agentProfileId,
			modelOverride: resolvedModelOverride,
			fallbackModelOverride,
		};
	}

	private inferFallbackModel(
		model: string,
		profileId: string,
	): string | undefined {
		const normalizedModel = model.toLowerCase();
		if (profileId === "cursor") {
			return this.getDefaultFallbackModelForRunner("cursor");
		}
		if (profileId === "codex") {
			return this.getDefaultFallbackModelForRunner("codex");
		}
		if (normalizedModel === "fable") return "opus";
		if (normalizedModel === "opus") return "sonnet";
		if (normalizedModel === "sonnet") return "haiku";
		// Keep haiku fallback on sonnet for retry behavior
		if (normalizedModel === "haiku") return "sonnet";
		return "sonnet";
	}
}
