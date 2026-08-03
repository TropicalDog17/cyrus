import type {
	HookCallbackMatcher,
	HookEvent,
	McpServerConfig,
	SandboxSettings,
	SdkPluginConfig,
	SessionStore,
	WarmSessionRegistry,
} from "cyrus-claude-runner";
import type {
	AgentMessage,
	AgentRunnerConfig,
	CyrusAgentSession,
	EdgeConfig,
	EffortLevel,
	IAgentRunner,
	ILogger,
	OnAskUserQuestion,
	RepositoryConfig,
} from "cyrus-core";

/**
 * Everything a profile's `buildConfig` needs beyond the shared baseline.
 *
 * The resolved fields (model, fallbackModel, mcpConfig, mcpConfigPath, hooks,
 * resolvedWorkspaceId) are produced once by `RunnerConfigBuilder` from the
 * selection result; the runtime-only fields (claudeSessionStore, warmEnabled)
 * are the profile-specific construction inputs the orchestrator used to hold
 * (SessionStore injection + warm pool liveness).
 */
export interface ProfileBuildInput {
	session: CyrusAgentSession;
	repository: RepositoryConfig;
	sessionId: string;
	systemPrompt: string | undefined;
	allowedTools: string[];
	allowedDirectories: string[];
	disallowedTools: string[];
	resumeSessionId?: string;
	/** Issue labels, fed to the selector for profile/model precedence. */
	labels?: string[];
	/** Issue description, parsed for `[agent=…]` / `[model=…]` tags. */
	issueDescription?: string;
	/**
	 * Model from the matched label-prompt config (complex form's `model`). Fed
	 * into `RunnerSelectionService` as one model-precedence source; the service —
	 * not the builder — resolves the final model.
	 */
	labelPromptModel?: string;
	/** Resolved reasoning effort. Claude runner only; ignored elsewhere. */
	effort?: EffortLevel;
	maxTurns?: number;
	/** Effective context-window size at which Claude sessions auto-compact. */
	autoCompactWindow?: number;
	/** Max characters of a single Bash tool result before truncation. */
	bashMaxOutputLength?: number;
	/** Max tokens a single MCP tool result may contribute before truncation. */
	mcpMaxOutputTokens?: number;
	/** Model for the read-only `explore` subagent. Claude runner only. */
	subagentModel?: string;
	/** Idle window (ms) a finished session stays alive for a follow-up. */
	sessionKeepAliveMs?: number;
	/** Shared LRU registry that caps concurrently-warm idle sessions. */
	warmSessionRegistry?: WarmSessionRegistry;
	/**
	 * Filesystem paths to custom-integration `.mcp.json` files for this issue
	 * session (platform-specific override list; the builder resolves it).
	 */
	platformMcpConfigOverrides?: readonly string[];
	linearWorkspaceId?: string;
	cyrusHome: string;
	logger: ILogger;
	onMessage: (message: AgentMessage) => void | Promise<void>;
	onError: (error: Error) => void;
	/** Factory to create AskUserQuestion callback (Claude runner only). */
	createAskUserQuestionCallback?: (
		sessionId: string,
		workspaceId: string,
	) => OnAskUserQuestion;
	/** Resolve the Linear workspace ID for a repository. */
	requireLinearWorkspaceId: (repo: RepositoryConfig) => string;
	/** Plugins to load for the session (provides skills, hooks, etc.). */
	plugins?: SdkPluginConfig[];
	/**
	 * Allow-list of skill names enabled for the session (after scope
	 * filtering), or `"all"` to enable every discovered skill.
	 */
	skills?: string[] | "all";
	/** SDK sandbox settings (enabled, network proxy ports). */
	sandboxSettings?: SandboxSettings;
	/** CA cert path for MITM TLS termination — passed via child process env. */
	egressCaCertPath?: string;
	/** Final resolved model (selector precedence already applied). */
	model: string;
	/** Final resolved fallback model. */
	fallbackModel: string;
	/** Final MCP server map for the session (exact catalog). */
	mcpConfig: Record<string, McpServerConfig>;
	mcpConfigPath: string | string[] | undefined;
	/** Event hooks assembled by the builder (shared across profiles). */
	hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
	/** Resolved platform workspace id (e.g. Linear workspace id). */
	resolvedWorkspaceId: string;
	/** Hosted Claude SessionStore (Claude runner only; undefined elsewhere). */
	claudeSessionStore?: unknown;
	/** Whether the warm session pool is enabled (Claude runner only). */
	warmEnabled: boolean;
}

/**
 * Runtime-only launch deps a profile's `createRunner` may consume — things
 * that are not config fields (the Claude SessionStore and warm-pool liveness
 * flag). Carried separately from the config so the config stays serializable.
 */
export interface ProfileRuntimeDeps {
	/** Hosted Claude SessionStore (Claude runner only; undefined elsewhere). */
	claudeSessionStore?: SessionStore | null;
	/** Whether the warm session pool is enabled (Claude runner only). */
	warmEnabled: boolean;
}

/**
 * A built-in Cyrus Agent profile (ADR 0009): the stable identity and launch
 * configuration for one agent. A profile owns its explicit selectors (labels /
 * `[agent=…]` description tags), its model-family inference, its default
 * models, the provider-specific config additions on top of the shared
 * baseline, and the runner constructor. Selection resolves an `agentProfileId`
 * through the registry; the `RunnerType` union is never extended for new
 * agents.
 */
export interface AgentProfile<
	TConfig extends AgentRunnerConfig = AgentRunnerConfig,
> {
	/** Stable profile id, persisted as the session's `agentProfileId`. */
	readonly id: string;
	/**
	 * Labels (and `[agent=…]` tag values) that explicitly select this profile,
	 * compared case-insensitively.
	 */
	readonly explicitSelectors: readonly string[];
	/**
	 * Whether this profile may be chosen as the default (or by fallback).
	 * Canary profiles opt out.
	 */
	readonly defaultEligible: boolean;
	/** Whether a model id belongs to this profile's model family. */
	inferModel(model: string): boolean;
	/** The profile's default model for a config, or undefined (no default). */
	defaultModel(config: EdgeConfig): string | undefined;
	/** The profile's default fallback model for a config, or undefined. */
	defaultFallbackModel(config: EdgeConfig): string | undefined;
	/**
	 * Add the profile's provider-specific fields on top of the shared baseline
	 * config and return the typed runner config.
	 */
	buildConfig(input: ProfileBuildInput, baseline: AgentRunnerConfig): TConfig;
	/**
	 * Construct the runner for this profile. `runtime` carries the runtime-only
	 * launch deps (e.g. the Claude SessionStore and warm-pool liveness flag)
	 * that are not config fields.
	 */
	createRunner(config: TConfig, runtime?: ProfileRuntimeDeps): IAgentRunner;
}
