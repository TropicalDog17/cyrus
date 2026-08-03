import { homedir } from "node:os";
import type { ClaudeRunnerConfig } from "cyrus-claude-runner";
import { ClaudeRunner } from "cyrus-claude-runner";
import type { CodexRunnerConfig } from "cyrus-codex-runner";
import { CodexRunner } from "cyrus-codex-runner";
import { compute, nodeDirLister, toSandboxFilesystem } from "cyrus-core";
import type { CursorRunnerConfig } from "cyrus-cursor-runner";
import { CursorRunner } from "cyrus-cursor-runner";
import type { OmpRunnerConfig } from "cyrus-omp-runner";
import { OmpRunner } from "cyrus-omp-runner";
import { resolveOmpBinaryPath } from "../RunnerConfigBuilder.js";
import type { AgentProfile, ProfileBuildInput } from "./AgentProfile.js";

const CURSOR_DEFAULT_MODEL = "composer-2.5";
const CODEX_DEFAULT_MODEL = "gpt-5-codex";

/**
 * Built-in Agent profiles (ADR 0009): claude, cursor, codex, and the canary
 * `omp`. Each owns its model-family inference, defaults, provider-specific
 * config additions, and runner constructor — the historical `RunnerType`
 * switches in `RunnerConfigBuilder`/`SessionOrchestrator` live here now.
 */
export const BUILT_IN_PROFILES: AgentProfile[] = [
	{
		id: "claude",
		explicitSelectors: ["claude"],
		defaultEligible: true,
		inferModel(model) {
			const normalized = model.toLowerCase();
			return (
				normalized === "fable" ||
				normalized === "opus" ||
				normalized === "sonnet" ||
				normalized === "haiku" ||
				normalized.startsWith("claude")
			);
		},
		defaultModel(config) {
			return config.claudeDefaultModel || config.defaultModel || "opus";
		},
		defaultFallbackModel(config) {
			return (
				config.claudeDefaultFallbackModel ||
				config.defaultFallbackModel ||
				"sonnet"
			);
		},
		buildConfig(input, baseline) {
			const claudeConfig: ClaudeRunnerConfig = {
				...baseline,
				// Plugins providing managed skills, and the skill scope
				// allow-list — Claude-only (the SDK consumes both directly).
				...(input.plugins?.length ? { plugins: input.plugins } : {}),
				...(input.skills !== undefined ? { skills: input.skills } : {}),
				// SDK sandbox settings: base settings merged with the
				// per-session filesystem allow-write (worktree path), plus the
				// CA cert path via env for MITM TLS termination.
				...(input.sandboxSettings && {
					...buildClaudeSandboxConfig(input),
				}),
				// AskUserQuestion callback — Claude only.
				...(input.createAskUserQuestionCallback && {
					onAskUserQuestion: input.createAskUserQuestionCallback(
						input.sessionId,
						input.resolvedWorkspaceId,
					),
				}),
			};

			// Claude-only: forward the early auto-compaction window.
			if (input.autoCompactWindow !== undefined) {
				claudeConfig.autoCompactWindow = input.autoCompactWindow;
			}
			// Claude-only: reasoning effort.
			if (input.effort !== undefined) {
				claudeConfig.effort = input.effort;
			}
			// Claude-only: tool-output caps.
			if (input.bashMaxOutputLength !== undefined) {
				claudeConfig.bashMaxOutputLength = input.bashMaxOutputLength;
			}
			if (input.mcpMaxOutputTokens !== undefined) {
				claudeConfig.mcpMaxOutputTokens = input.mcpMaxOutputTokens;
			}
			// Claude-only: explore-subagent model.
			if (input.subagentModel !== undefined) {
				claudeConfig.subagentModel = input.subagentModel;
			}
			// Claude-only: idle keep-alive window.
			if (input.sessionKeepAliveMs !== undefined) {
				claudeConfig.sessionKeepAliveMs = input.sessionKeepAliveMs;
			}
			// Claude-only: shared warm-session LRU registry.
			if (input.warmSessionRegistry !== undefined) {
				claudeConfig.warmSessionRegistry = input.warmSessionRegistry;
			}

			return claudeConfig;
		},
		createRunner(config, runtime) {
			const claudeConfig: ClaudeRunnerConfig = config;
			// Inject the hosted SessionStore at the last moment so it only
			// attaches to Claude runners (the field is Claude-specific), and pass
			// the warm-pool liveness flag the runner constructor consumes.
			const withStore = runtime?.claudeSessionStore
				? { ...claudeConfig, sessionStore: runtime.claudeSessionStore }
				: claudeConfig;
			return new ClaudeRunner(withStore, runtime?.warmEnabled ?? false);
		},
	},
	{
		id: "cursor",
		explicitSelectors: ["cursor"],
		defaultEligible: true,
		inferModel(model) {
			return /^composer[a-z0-9.-]*$/i.test(model);
		},
		defaultModel(config) {
			return config.cursorDefaultModel || CURSOR_DEFAULT_MODEL;
		},
		defaultFallbackModel(config) {
			return config.cursorDefaultFallbackModel || CURSOR_DEFAULT_MODEL;
		},
		buildConfig(input, baseline) {
			const cursorConfig: CursorRunnerConfig = { ...baseline };
			// Cursor runner uses @cursor/sdk. Pass through the API key, the
			// same sandboxSettings shape Claude consumes (the runner translates
			// it to Cursor's `.cursor/sandbox.json` schema), and the egress CA
			// bundle path for MITM TLS trust in sandboxed children.
			cursorConfig.cursorApiKey = process.env.CURSOR_API_KEY || undefined;
			if (input.sandboxSettings) {
				cursorConfig.sandboxSettings = input.sandboxSettings;
			}
			if (input.egressCaCertPath) {
				cursorConfig.egressCaCertPath = input.egressCaCertPath;
			}
			return cursorConfig;
		},
		createRunner(config) {
			return new CursorRunner(config);
		},
	},
	{
		id: "codex",
		explicitSelectors: ["codex"],
		defaultEligible: true,
		inferModel(model) {
			const normalized = model.toLowerCase();
			return (
				/^gpt[-0-9]/i.test(normalized) ||
				/^o[0-9]/i.test(normalized) ||
				/codex/i.test(normalized)
			);
		},
		defaultModel(config) {
			return config.codexDefaultModel || CODEX_DEFAULT_MODEL;
		},
		defaultFallbackModel(config) {
			return config.codexDefaultFallbackModel || CODEX_DEFAULT_MODEL;
		},
		buildConfig(_input, baseline) {
			const codexConfig: CodexRunnerConfig = { ...baseline };
			// Codex runner drives OpenAI Codex over ACP. Thread through the
			// Codex/OpenAI API key and the optional adapter-launch / codex-binary
			// overrides; the runner spawns the ACP adapter itself and relies on
			// worktree isolation + the sandbox for containment.
			codexConfig.codexApiKey =
				process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || undefined;
			if (process.env.CODEX_ACP_COMMAND) {
				codexConfig.acpCommand = process.env.CODEX_ACP_COMMAND;
			}
			if (process.env.CODEX_PATH) {
				codexConfig.codexPath = process.env.CODEX_PATH;
			}
			return codexConfig;
		},
		createRunner(config) {
			return new CodexRunner(config);
		},
	},
	{
		id: "omp",
		explicitSelectors: ["omp"],
		defaultEligible: false,
		inferModel() {
			// The OMP canary has no model-family inference: `[agent=omp]` and the
			// `omp` label are the only selectors (ADR 0009 / PR 1 canary rules).
			return false;
		},
		defaultModel() {
			return undefined;
		},
		defaultFallbackModel() {
			return undefined;
		},
		buildConfig(input, baseline) {
			const ompConfig: OmpRunnerConfig = {
				...baseline,
				// Launch-scoped authorization inputs (ADR 0016): cwd comes from
				// the baseline; extra worktrees become repeated --add-dir flags;
				// the exact catalog is the ONLY MCP set; the rendered policy and
				// SRT sandbox enforce the EffectiveAccessPolicy; the session
				// state dir and generated overlay are passed through. The pinned
				// OMP binary is resolved explicitly so the launch never falls
				// back to an ambient global of a different version.
				ompCommand: resolveOmpBinaryPath() ?? "omp",
				...(baseline.additionalDirectories?.length
					? { ompAdditionalDirectories: baseline.additionalDirectories }
					: {}),
				// Wire-identical shapes; the SDK's union discriminates its http/sse
				// variants with an explicit `type` field the catalog does not carry,
				// so the conversion is a documented cast at this boundary.
				ompMcpServers: (input.ompMcpServers ??
					[]) as unknown as OmpRunnerConfig["ompMcpServers"],
				ompPermissionPolicy: input.ompPermissionPolicy,
				ompSandbox: input.ompSandbox,
				ompSessionDir: input.ompSessionDir,
				ompOverlayConfigPath: input.ompOverlayConfigPath,
			};

			// Claude-only hooks, warm sessions, SDK plugins, effort, and
			// compaction fields are intentionally NOT forwarded: OMP owns its
			// own loop and its own permission/approval handling.
			if (input.model) ompConfig.model = input.model;
			return ompConfig;
		},
		createRunner(config) {
			return new OmpRunner(config as OmpRunnerConfig);
		},
	},
];

/**
 * Build the Claude-runner sandbox config for a session: base settings merged
 * with the per-session filesystem restrictions (worktree as the only writable
 * directory) and the CA cert for MITM TLS termination via additionalEnv.
 * Mirrors the cold + warm tool-permission paths by deriving the OS-sandbox
 * filesystem from the SAME `AccessPolicy.compute()` (Frozen decision #2).
 */
function buildClaudeSandboxConfig(
	input: ProfileBuildInput,
): Pick<ClaudeRunnerConfig, "sandbox" | "additionalEnv"> {
	const result: Pick<ClaudeRunnerConfig, "sandbox" | "additionalEnv"> = {};

	if (input.sandboxSettings) {
		result.sandbox = {
			...input.sandboxSettings,
			// When sandbox is enabled, do not allow commands to run unsandboxed.
			allowUnsandboxedCommands: false,
			// Required for Go-based tools (gh, gcloud, terraform) to verify TLS
			// certs when using httpProxyPort with a MITM proxy and custom CA.
			// macOS only — opens access to com.apple.trustd.agent, a potential
			// data exfiltration path. See:
			// https://code.claude.com/docs/en/settings#sandbox-settings
			enableWeakerNetworkIsolation: true,
			filesystem: {
				...input.sandboxSettings.filesystem,
				// "." resolves to the cwd of the primary folder Claude works in;
				// allowedDirectories contains the attachments dir, repo paths,
				// and git metadata dirs — all of which need OS-level read access
				// alongside the worktree. `denyRead` keeps the literal "~/"
				// token, which bubblewrap / macOS sandbox honor as a true
				// deny+whitelist root. Writes are restricted to the worktree.
				// See:
				// https://code.claude.com/docs/en/settings#sandbox-path-prefixes
				...toSandboxFilesystem(
					compute({
						homeDir: homedir(),
						dirLister: nodeDirLister,
						cwd: input.session.workspace.path,
						allowReadDirectories: input.allowedDirectories,
						writeDirectories: [input.session.workspace.path],
					}),
				),
			},
		};
	}

	if (input.egressCaCertPath) {
		result.additionalEnv = {
			NODE_EXTRA_CA_CERTS: input.egressCaCertPath,
			SSL_CERT_FILE: input.egressCaCertPath,
			GIT_SSL_CAINFO: input.egressCaCertPath,
			REQUESTS_CA_BUNDLE: input.egressCaCertPath,
			PIP_CERT: input.egressCaCertPath,
			CURL_CA_BUNDLE: input.egressCaCertPath,
			CARGO_HTTP_CAINFO: input.egressCaCertPath,
			AWS_CA_BUNDLE: input.egressCaCertPath,
			DENO_CERT: input.egressCaCertPath,
		};
	}

	return result;
}
