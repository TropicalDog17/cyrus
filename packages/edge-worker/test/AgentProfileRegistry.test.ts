/**
 * Tests for the built-in Agent profile registry (ADR 0009).
 *
 * Profiles are the stable Cyrus identity + launch configuration for an agent:
 * explicit selectors (labels / `[agent=…]` tags), model-family inference,
 * defaults, config additions, and the runner constructor. Selection never
 * extends `RunnerType`; a canary profile (`omp`) exists but can never be
 * chosen by model inference or as a default.
 */

import type { EdgeConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../src/agents/AgentProfile.js";
import { AgentProfileRegistry } from "../src/agents/AgentProfileRegistry.js";
import { BUILT_IN_PROFILES } from "../src/agents/builtInProfiles.js";

function makeConfig(overrides: Partial<EdgeConfig> = {}): EdgeConfig {
	return { repositories: [], ...overrides } as EdgeConfig;
}

function registryWith(profiles: AgentProfile[]): AgentProfileRegistry {
	const registry = new AgentProfileRegistry();
	for (const profile of profiles) {
		registry.register(profile);
	}
	return registry;
}

describe("AgentProfileRegistry", () => {
	it("registers and resolves profiles by id", () => {
		const registry = registryWith(BUILT_IN_PROFILES);
		expect(registry.get("claude")?.id).toBe("claude");
		expect(registry.get("cursor")?.id).toBe("cursor");
		expect(registry.get("codex")?.id).toBe("codex");
		expect(registry.get("omp")?.id).toBe("omp");
		expect(registry.get("unknown")).toBeUndefined();
	});

	it("rejects a duplicate profile id", () => {
		const registry = new AgentProfileRegistry();
		registry.register(BUILT_IN_PROFILES[0]);
		expect(() => registry.register(BUILT_IN_PROFILES[0])).toThrow(
			/already registered/,
		);
	});

	it("rejects a selector claimed by two profiles", () => {
		const registry = new AgentProfileRegistry();
		registry.register(BUILT_IN_PROFILES[0]); // claude claims "claude"
		expect(() =>
			registry.register({
				id: "claude2",
				explicitSelectors: ["claude"],
				defaultEligible: false,
				inferModel: () => false,
				defaultModel: () => undefined,
				defaultFallbackModel: () => undefined,
				buildConfig: (_input: never, baseline: never) => baseline,
				createRunner: () => {
					throw new Error("unused");
				},
			} as unknown as AgentProfile),
		).toThrow(/selector .* already claimed/);
	});

	it("resolves profiles from explicit selectors case-insensitively", () => {
		const registry = registryWith(BUILT_IN_PROFILES);
		expect(registry.resolveByLabel(["OMP"])?.id).toBe("omp");
		expect(registry.resolveByLabel(["Codex"])?.id).toBe("codex");
		expect(registry.resolveByLabel(["unknown-label"])).toBeUndefined();
	});

	it("resolves profiles from model-family inference", () => {
		const registry = registryWith(BUILT_IN_PROFILES);
		expect(registry.resolveByModel("opus")?.id).toBe("claude");
		expect(registry.resolveByModel("composer-2.5")?.id).toBe("cursor");
		expect(registry.resolveByModel("gpt-5-codex")?.id).toBe("codex");
	});

	it("never infers a profile for a model when no family matches", () => {
		const registry = registryWith(BUILT_IN_PROFILES);
		expect(registry.resolveByModel("some-random-model")).toBeUndefined();
	});

	it("never selects the omp canary via model inference", () => {
		const registry = registryWith(BUILT_IN_PROFILES);
		expect(registry.resolveByModel("omp")).toBeUndefined();
		expect(registry.resolveByModel("opus")).not.toBe("omp");
	});

	describe("resolveDefault", () => {
		it("honors defaultAgentProfile before defaultRunner", () => {
			const registry = registryWith(BUILT_IN_PROFILES);
			const config = makeConfig({
				defaultAgentProfile: "cursor",
				defaultRunner: "codex",
			});
			expect(registry.resolveDefault(config)?.id).toBe("cursor");
		});

		it("treats defaultRunner as the compatibility alias", () => {
			const registry = registryWith(BUILT_IN_PROFILES);
			expect(
				registry.resolveDefault(makeConfig({ defaultRunner: "codex" }))?.id,
			).toBe("codex");
		});

		it("auto-detects cursor when it is the only credentialed runner", () => {
			const registry = registryWith(BUILT_IN_PROFILES);
			const saved = {
				CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
				ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
				CURSOR_API_KEY: process.env.CURSOR_API_KEY,
				CODEX_API_KEY: process.env.CODEX_API_KEY,
				OPENAI_API_KEY: process.env.OPENAI_API_KEY,
			};
			try {
				delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
				delete process.env.ANTHROPIC_API_KEY;
				delete process.env.CODEX_API_KEY;
				delete process.env.OPENAI_API_KEY;
				process.env.CURSOR_API_KEY = "ck-test";
				expect(registry.resolveDefault(makeConfig())?.id).toBe("cursor");
			} finally {
				for (const [key, value] of Object.entries(saved)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		});

		it("falls back to claude when nothing is configured or detectable", () => {
			const registry = registryWith(BUILT_IN_PROFILES);
			const saved = {
				CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
				ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
				CURSOR_API_KEY: process.env.CURSOR_API_KEY,
				CODEX_API_KEY: process.env.CODEX_API_KEY,
				OPENAI_API_KEY: process.env.OPENAI_API_KEY,
			};
			try {
				for (const key of Object.keys(saved)) delete process.env[key];
				expect(registry.resolveDefault(makeConfig())?.id).toBe("claude");
			} finally {
				for (const [key, value] of Object.entries(saved)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		});

		it("never resolves the omp canary as a default", () => {
			const registry = registryWith(BUILT_IN_PROFILES);
			// Even an explicit (schema-invalid) default naming omp is refused:
			// omp is not default-eligible.
			expect(
				registry.resolveDefault(
					makeConfig({ defaultAgentProfile: "omp" } as never),
				)?.id,
			).not.toBe("omp");
		});
	});

	it("resolves per-profile default models and fallbacks", () => {
		const registry = registryWith(BUILT_IN_PROFILES);
		expect(registry.defaultModelFor("claude", makeConfig())).toBe("opus");
		expect(
			registry.defaultModelFor(
				"claude",
				makeConfig({ claudeDefaultModel: "sonnet" }),
			),
		).toBe("sonnet");
		expect(registry.defaultModelFor("cursor", makeConfig())).toBe(
			"composer-2.5",
		);
		expect(registry.defaultModelFor("codex", makeConfig())).toBe("gpt-5-codex");
		expect(registry.defaultModelFor("omp", makeConfig())).toBeUndefined();
		expect(registry.defaultFallbackModelFor("claude", makeConfig())).toBe(
			"sonnet",
		);
	});

	it("exposes the full set of registered profiles", () => {
		const registry = registryWith(BUILT_IN_PROFILES);
		expect(
			registry
				.getAll()
				.map((p) => p.id)
				.sort(),
		).toEqual(["claude", "codex", "cursor", "omp"]);
	});
});
