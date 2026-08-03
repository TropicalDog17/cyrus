import { execSync } from "node:child_process";
import type {
	ClaudeRunnerConfig,
	HookCallbackMatcher,
	HookEvent,
	McpServerConfig,
	PostToolUseHookInput,
	StopHookInput,
} from "cyrus-claude-runner";
import type { CodexRunnerConfig } from "cyrus-codex-runner";
import type { AgentRunnerConfig, ILogger, RepositoryConfig } from "cyrus-core";
import type { CursorRunnerConfig } from "cyrus-cursor-runner";
import type { ProfileBuildInput } from "./agents/AgentProfile.js";
import { AgentProfileRegistry } from "./agents/AgentProfileRegistry.js";
import { BUILT_IN_PROFILES } from "./agents/builtInProfiles.js";

/**
 * The concrete runner config the builder produces — a Claude, Cursor, or Codex
 * config (OMP joins the union once its runner package lands). All extend the
 * neutral `AgentRunnerConfig` base; this union preserves the provider-specific
 * extras without an untyped `& Record<string, unknown>` escape hatch.
 */
export type RunnerConfig =
	| ClaudeRunnerConfig
	| CursorRunnerConfig
	| CodexRunnerConfig;

import { buildIntentToAddHook } from "./hooks/IntentToAddHook.js";
import { buildPrMarkerHook } from "./hooks/PrMarkerHook.js";
import { appendAskUserQuestionAddendum } from "./prompts/askUserQuestionPromptAddendum.js";
import { appendBrowserUseAddendum } from "./prompts/browserUsePromptAddendum.js";
import { appendCloudRuntimeAddendum } from "./prompts/cloudRuntimePromptAddendum.js";
import { appendContextDisciplineAddendum } from "./prompts/contextDisciplinePromptAddendum.js";
import { appendIssueCommentPolicyAddendum } from "./prompts/issueCommentPolicyPromptAddendum.js";
import { appendMcpPreloadAddendum } from "./prompts/mcpPreloadPromptAddendum.js";

/**
 * Subset of McpConfigService consumed by RunnerConfigBuilder.
 */
export interface IMcpConfigProvider {
	buildMcpConfig(
		repoId: string,
		linearWorkspaceId: string,
		parentSessionId?: string,
	): Record<string, McpServerConfig>;
	buildMergedMcpConfigPath(
		repositories: RepositoryConfig | RepositoryConfig[],
	): string | string[] | undefined;
}

/**
 * Subset of RunnerSelectionService consumed by RunnerConfigBuilder.
 */
export interface IRunnerSelector {
	determineRunnerSelection(
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
	};
	getDefaultModelForRunner(profileId: string): string;
	getDefaultFallbackModelForRunner(profileId: string): string;
}

/**
 * Input for building an issue session runner config: the profile build input
 * minus the fields the builder resolves itself (model/fallback/MCP/hooks/
 * workspace id) and the runtime-only launch deps.
 */
export type IssueRunnerConfigInput = Omit<
	ProfileBuildInput,
	| "model"
	| "fallbackModel"
	| "mcpConfig"
	| "mcpConfigPath"
	| "hooks"
	| "resolvedWorkspaceId"
>;

export function resolveIssueMcpConfigPath(
	repository: RepositoryConfig,
	platformMcpConfigOverrides: readonly string[] | undefined,
	buildMergedMcpConfigPath: (
		repositories: RepositoryConfig | RepositoryConfig[],
	) => string | string[] | undefined,
): string | string[] | undefined {
	const repoHasAllowedToolsOverride =
		Array.isArray(repository.allowedTools) &&
		repository.allowedTools.length > 0;
	if (repoHasAllowedToolsOverride) {
		return buildMergedMcpConfigPath(repository);
	}

	if (!platformMcpConfigOverrides || platformMcpConfigOverrides.length === 0) {
		return undefined;
	}

	if (platformMcpConfigOverrides.length === 1) {
		return platformMcpConfigOverrides[0];
	}

	return [...platformMcpConfigOverrides];
}

/**
 * Runner config assembly for issue sessions.
 *
 * Produces AgentRunnerConfig objects for EdgeWorker.buildAgentRunnerConfig()
 * using injected services. The shared baseline is assembled here once; each
 * selected Agent profile adds its provider-specific fields via `buildConfig`
 * and constructs its runner via `createRunner` — no `RunnerType` switch.
 */
export class RunnerConfigBuilder {
	private mcpConfigProvider: IMcpConfigProvider;
	private runnerSelector: IRunnerSelector;
	private profileRegistry: AgentProfileRegistry;

	constructor(
		mcpConfigProvider: IMcpConfigProvider,
		runnerSelector: IRunnerSelector,
		profileRegistry: AgentProfileRegistry = new AgentProfileRegistry(
			BUILT_IN_PROFILES,
		),
	) {
		this.mcpConfigProvider = mcpConfigProvider;
		this.runnerSelector = runnerSelector;
		this.profileRegistry = profileRegistry;
	}

	/**
	 * Build a runner config for issue sessions (Linear issues, GitHub PRs).
	 *
	 * Issue sessions get full tool sets, model overrides, and hooks.
	 */
	buildIssueConfig(input: IssueRunnerConfigInput): {
		config: RunnerConfig;
		agentProfileId: string;
	} {
		const log = input.logger;

		// Configure hooks: PostToolUse for screenshot tools + PR-marker enforcement,
		// plus the Stop hook that blocks the session when work is unshipped.
		const screenshotHooks = this.buildScreenshotHooks(log);
		const prMarkerHook = buildPrMarkerHook(log);
		const intentToAddHook = buildIntentToAddHook(log);
		const stopHook = this.buildStopHook(log);
		const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
			...stopHook,
			PostToolUse: [
				...(screenshotHooks.PostToolUse ?? []),
				...(prMarkerHook.PostToolUse ?? []),
				...(intentToAddHook.PostToolUse ?? []),
			],
		};

		// Determine agent profile and model override from selectors. Model
		// precedence (description/label tags → labelPrompt → repository) is
		// resolved entirely inside the selector; do NOT re-resolve it here.
		const runnerSelection = this.runnerSelector.determineRunnerSelection(
			input.labels || [],
			input.issueDescription,
			{
				labelPromptModel: input.labelPromptModel,
				repositoryModel: input.repository.model,
				repositoryFallbackModel: input.repository.fallbackModel,
			},
		);
		let agentProfileId = runnerSelection.agentProfileId;
		let modelOverride = runnerSelection.modelOverride;
		let fallbackModelOverride = runnerSelection.fallbackModelOverride;

		// When resuming a session, keep the profile that originally created it —
		// even if the labels/tags now select a different one — so a session never
		// switches harness mid-flight. The persisted `agentProfileId` is
		// authoritative for any registered profile (including canaries).
		const pinnedProfileId = input.session.agentProfileId;
		const pinnedProfile = pinnedProfileId
			? this.profileRegistry.get(pinnedProfileId)
			: undefined;
		if (pinnedProfile && pinnedProfile.id !== agentProfileId) {
			agentProfileId = pinnedProfile.id;
			modelOverride =
				this.runnerSelector.getDefaultModelForRunner(agentProfileId);
			fallbackModelOverride =
				this.runnerSelector.getDefaultFallbackModelForRunner(agentProfileId);
		}

		// Log model override if found
		if (modelOverride) {
			log.debug(`Model override via selector: ${modelOverride}`);
		}

		// The selector already folded `repository.model` (and the label-prompt
		// model) into `modelOverride` and guaranteed a runner default when nothing
		// explicit matched, so this is the final model. The `??` is a belt for
		// injected selector mocks that omit the field; the real service always
		// returns one. Do NOT re-add a `|| repository.model || default` chain
		// here — that historically shadowed the selector and left
		// `repository.model` dead (DEV-174).
		const finalModel =
			modelOverride ??
			this.runnerSelector.getDefaultModelForRunner(agentProfileId);
		const finalFallbackModel =
			fallbackModelOverride ??
			this.runnerSelector.getDefaultFallbackModelForRunner(agentProfileId);

		const resolvedWorkspaceId =
			input.linearWorkspaceId ??
			input.requireLinearWorkspaceId(input.repository);
		const mcpConfig = this.mcpConfigProvider.buildMcpConfig(
			input.repository.id,
			resolvedWorkspaceId,
			input.sessionId,
		);
		// Repo-override vs platform-default resolution for MCP config paths:
		//   - If the routed repo has its own `allowedTools` override, it
		//     also owns its own MCP config — use `repository.mcpConfigPath`
		//     so the repo-scoped allow-list lines up with the repo-scoped
		//     server set. The two travel as a unit.
		//   - Otherwise the repo inherits the platform's allow-list, and
		//     should likewise inherit the platform's MCP config list
		//     (`linearMcpConfigs` / `githubMcpConfigs`).
		// This guarantees the agent's permission rules and the loaded MCP
		// server set always come from the same scope.
		const mcpConfigPath = resolveIssueMcpConfigPath(
			input.repository,
			input.platformMcpConfigOverrides,
			this.mcpConfigProvider.buildMergedMcpConfigPath.bind(
				this.mcpConfigProvider,
			),
		);

		// Multi-repo sessions place each repo in a sibling sub-worktree of the
		// cwd (the workspace container). Register those sub-worktrees as
		// `--add-dir` roots so the runner auto-loads each one's `.claude/skills/`
		// — the cwd-rooted project-skill scan alone would miss them. Single-repo
		// sessions have cwd === the worktree, so there is nothing extra to add.
		const cwd = input.session.workspace.path;
		const additionalDirectories = Object.values(
			input.session.workspace.repoPaths ?? {},
		).filter((p): p is string => typeof p === "string" && p !== cwd);

		// The shared baseline — the neutral fields every profile consumes. The
		// profile adds its provider-specific fields on top.
		const baseline: AgentRunnerConfig = {
			workingDirectory: cwd,
			allowedTools: input.allowedTools,
			disallowedTools: input.disallowedTools,
			allowedDirectories: input.allowedDirectories,
			...(additionalDirectories.length > 0 && { additionalDirectories }),
			workspaceName: input.session.issue?.identifier || input.session.issueId,
			cyrusHome: input.cyrusHome,
			mcpConfigPath,
			mcpConfig,
			appendSystemPrompt: appendCloudRuntimeAddendum(
				appendBrowserUseAddendum(
					appendIssueCommentPolicyAddendum(
						appendMcpPreloadAddendum(
							appendContextDisciplineAddendum(
								appendAskUserQuestionAddendum(input.systemPrompt),
							),
						),
					),
				),
			),
			// Model + fallback are fully resolved by the selector (see finalModel
			// above and `determineRunnerSelection`). No local precedence chain.
			model: finalModel,
			fallbackModel: finalFallbackModel,
			logger: log,
			hooks,
			onMessage: input.onMessage,
			onError: input.onError,
		};

		if (input.resumeSessionId) {
			baseline.resumeSessionId = input.resumeSessionId;
		}
		if (input.maxTurns !== undefined) {
			baseline.maxTurns = input.maxTurns;
		}

		// Select the profile and let it finish the config.
		const profile = this.profileRegistry.get(agentProfileId);
		if (!profile) {
			throw new Error(
				`Unknown agent profile "${agentProfileId}" selected for session ${input.sessionId}`,
			);
		}

		const profileInput: ProfileBuildInput = {
			...input,
			model: finalModel,
			fallbackModel: finalFallbackModel,
			mcpConfig,
			mcpConfigPath,
			hooks,
			resolvedWorkspaceId,
			claudeSessionStore: input.claudeSessionStore,
			warmEnabled: input.warmEnabled,
		};

		const config = profile.buildConfig(profileInput, baseline) as RunnerConfig;

		return { config, agentProfileId };
	}

	/**
	 * Build a Stop hook that reminds the agent to commit, push, and open a PR
	 * before ending the session. Blocks the first stop attempt and feeds the
	 * guidance back to the agent via the SDK's native `decision: "block"` +
	 * `reason` mechanism. The `stop_hook_active` flag prevents infinite loops —
	 * once the hook has already fired, the next stop is always allowed through.
	 */
	private buildStopHook(
		log: ILogger,
	): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
		return buildStopHook(log);
	}

	/**
	 * Build PostToolUse hooks for screenshot/GIF tools that guide Claude
	 * to upload files to Linear using linear_upload_file.
	 */
	private buildScreenshotHooks(
		log: ILogger,
	): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
		return {
			PostToolUse: [
				{
					matcher: "playwright_screenshot",
					hooks: [
						async (input, _toolUseID, { signal: _signal }) => {
							const postToolUseInput = input as PostToolUseHookInput;
							log.debug(
								`Tool ${postToolUseInput.tool_name} completed with response:`,
								postToolUseInput.tool_response,
							);
							const response = postToolUseInput.tool_response as {
								path?: string;
							};
							const filePath = response?.path || "the screenshot file";
							return {
								continue: true,
								additionalContext: `Screenshot taken successfully. To share this screenshot in Linear comments, use the linear_upload_file tool to upload ${filePath}. This will return an asset URL that can be embedded in markdown. You can also use the Read tool to view the screenshot file to analyze the visual content.`,
							};
						},
					],
				},
				{
					matcher: "mcp__chrome-devtools__take_screenshot",
					hooks: [
						async (input, _toolUseID, { signal: _signal }) => {
							const postToolUseInput = input as PostToolUseHookInput;
							// Extract file path from input (the tool saves to filePath parameter)
							const toolInput = postToolUseInput.tool_input as {
								filePath?: string;
							};
							const filePath = toolInput?.filePath || "the screenshot file";
							return {
								continue: true,
								additionalContext: `Screenshot saved. To share this screenshot in Linear comments, use the linear_upload_file tool to upload ${filePath}. This will return an asset URL that can be embedded in markdown.`,
							};
						},
					],
				},
			],
		};
	}
}

/**
 * Build a Stop hook that ensures the agent ships work before ending the
 * session. Inspects the working tree at the session cwd and blocks the first
 * stop attempt when there are uncommitted tracked changes or commits ahead
 * of the upstream branch. The `stop_hook_active` flag prevents infinite
 * loops — once the hook has fired, the next stop is always allowed through.
 *
 * Pre-existing untracked files (local scratch files, env files, IDE
 * artifacts outside `.gitignore`) do not trigger the guardrail; new files
 * the agent writes are marked via `IntentToAddHook` so they still appear as
 * a tracked diff and re-trigger the block when forgotten. See CYPACK-1196.
 */
export function buildStopHook(
	log: ILogger,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	return {
		Stop: [
			{
				matcher: ".*",
				hooks: [
					async (input) => {
						const stopInput = input as StopHookInput;

						// Prevent infinite loops: if the hook already fired, allow the stop.
						if (stopInput.stop_hook_active) {
							return {};
						}

						const guardrail = inspectGitGuardrail(stopInput.cwd, log);
						if (!guardrail) {
							return {};
						}

						return {
							decision: "block",
							reason: guardrail,
						};
					},
				],
			},
		],
	};
}

/**
 * Inspect the working tree at `cwd` and return a guardrail message if there
 * is unshipped work (uncommitted tracked changes or commits ahead of the
 * upstream). Returns null when the tree is clean, when `cwd` isn't a git
 * repo, or when git is unavailable — in those cases the stop is not blocked.
 *
 * Uses `--untracked-files=no` so that pre-existing untracked files in the
 * customer's worktree (scratch files, local env files, IDE artifacts) do not
 * wedge the session. Files Cyrus creates via Write/Edit are marked with
 * `git add --intent-to-add` by `IntentToAddHook` so they still show as a
 * tracked diff and block the stop when left uncommitted.
 */
export function inspectGitGuardrail(cwd: string, log: ILogger): string | null {
	const runGit = (args: string): string => {
		return execSync(`git ${args}`, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	};

	let status: string;
	try {
		status = runGit("status --porcelain --untracked-files=no");
	} catch (err) {
		log.debug(
			`PR guardrail: skipping (cwd is not a git repo or git failed): ${(err as Error).message}`,
		);
		return null;
	}

	const uncommittedFiles = status
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const hasUncommitted = uncommittedFiles.length > 0;

	let unpushedCount = 0;
	try {
		unpushedCount = parseInt(runGit("rev-list --count @{u}..HEAD"), 10) || 0;
	} catch {
		// No upstream configured — fall back to comparing against origin's default branch.
		try {
			const baseRef = runGit("rev-parse --verify --abbrev-ref origin/HEAD");
			if (baseRef) {
				unpushedCount =
					parseInt(runGit(`rev-list --count ${baseRef}..HEAD`), 10) || 0;
			}
		} catch {
			// Can't determine a base — be conservative and don't block on commits alone.
		}
	}

	if (!hasUncommitted && unpushedCount === 0) {
		return null;
	}

	const parts: string[] = [];
	if (hasUncommitted) {
		parts.push(
			`${uncommittedFiles.length} uncommitted file change${uncommittedFiles.length === 1 ? "" : "s"}`,
		);
	}
	if (unpushedCount > 0) {
		parts.push(
			`${unpushedCount} commit${unpushedCount === 1 ? "" : "s"} not yet on the remote`,
		);
	}

	return (
		`You appear to be ending the session, but the working tree has ${parts.join(" and ")}. ` +
		"Before stopping:\n" +
		"1. Commit any uncommitted changes with a descriptive message.\n" +
		"2. Push the branch to the remote.\n" +
		"3. Create or update a pull request that summarizes the change.\n\n" +
		"If the work is genuinely complete and a PR is not appropriate (for example, a question or research task with no intended code changes), you may stop again — this guardrail only blocks once per session."
	);
}
