import type { EdgeConfig } from "cyrus-core";
import type { AgentProfile } from "./AgentProfile.js";

/**
 * The registry of built-in Agent profiles (ADR 0009).
 *
 * Selection resolves an `agentProfileId` through this registry; new agents are
 * registered here, never as a `RunnerType` branch. Precedence rules are owned
 * by `RunnerSelectionService`; the registry answers the four primitive
 * questions: "which profile claims this label?", "which profile's model family
 * matches this model?", "which profile is the default?", and "what are this
 * profile's default models?".
 */
export class AgentProfileRegistry {
	private readonly profiles = new Map<string, AgentProfile>();
	private readonly selectors = new Map<string, string>();

	constructor(initialProfiles: readonly AgentProfile[] = []) {
		for (const profile of initialProfiles) {
			this.register(profile);
		}
	}

	/**
	 * Register a profile. Throws on a duplicate id or on a selector already
	 * claimed by another profile — ambiguity at registration time is a
	 * programming error, never a runtime tie-break.
	 */
	register(profile: AgentProfile): void {
		if (this.profiles.has(profile.id)) {
			throw new Error(`Agent profile "${profile.id}" is already registered`);
		}
		for (const selector of profile.explicitSelectors) {
			const normalized = selector.toLowerCase();
			const owner = this.selectors.get(normalized);
			if (owner !== undefined) {
				throw new Error(
					`Agent profile selector "${selector}" is already claimed by profile "${owner}"`,
				);
			}
		}
		this.profiles.set(profile.id, profile);
		for (const selector of profile.explicitSelectors) {
			this.selectors.set(selector.toLowerCase(), profile.id);
		}
	}

	get(profileId: string): AgentProfile | undefined {
		return this.profiles.get(profileId);
	}

	getAll(): AgentProfile[] {
		return Array.from(this.profiles.values());
	}

	/**
	 * Resolve the profile explicitly claimed by a label or `[agent=…]` tag
	 * value. Case-insensitive. Returns undefined when no registered profile
	 * claims the label (unknown labels fall through to lower precedence).
	 */
	resolveByLabel(labels: readonly string[]): AgentProfile | undefined {
		for (const label of labels) {
			const profileId = this.selectors.get(label.toLowerCase());
			if (profileId !== undefined) {
				return this.profiles.get(profileId);
			}
		}
		return undefined;
	}

	/**
	 * Resolve the profile whose model family matches a model id. Returns
	 * undefined when no family matches — the caller falls through to the
	 * default. Registration order breaks ties; built-in family predicates are
	 * mutually exclusive.
	 */
	resolveByModel(model: string): AgentProfile | undefined {
		for (const profile of this.profiles.values()) {
			if (profile.inferModel(model)) {
				return profile;
			}
		}
		return undefined;
	}

	/**
	 * Resolve the default profile for a config: `defaultAgentProfile` →
	 * `defaultRunner` (compatibility alias) → environment auto-detect (the sole
	 * credentialed non-Claude runner) → claude.
	 *
	 * A profile that is not default-eligible (e.g. the omp canary) is never
	 * returned, even if config names it — the config schema prevents that
	 * anyway, so a naming at runtime is corrupt input and is refused.
	 */
	resolveDefault(config: EdgeConfig): AgentProfile {
		const explicit = config.defaultAgentProfile ?? config.defaultRunner;
		if (explicit) {
			const profile = this.get(explicit);
			if (profile?.defaultEligible) {
				return profile;
			}
		}

		const hasClaude = Boolean(
			process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
		);
		const hasCursor = Boolean(process.env.CURSOR_API_KEY);
		const hasCodex = Boolean(
			process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY,
		);

		// The sole credentialed runner becomes the default, mirroring the
		// historical auto-detection. When credentials are ambiguous, claude.
		if (hasCursor && !hasClaude && !hasCodex) {
			return this.get("cursor")!;
		}
		if (hasCodex && !hasClaude && !hasCursor) {
			return this.get("codex")!;
		}
		return this.get("claude")!;
	}

	/** The profile's default model, or undefined when it has none. */
	defaultModelFor(profileId: string, config: EdgeConfig): string | undefined {
		return this.get(profileId)?.defaultModel(config);
	}

	/** The profile's default fallback model, or undefined when it has none. */
	defaultFallbackModelFor(
		profileId: string,
		config: EdgeConfig,
	): string | undefined {
		return this.get(profileId)?.defaultFallbackModel(config);
	}
}
