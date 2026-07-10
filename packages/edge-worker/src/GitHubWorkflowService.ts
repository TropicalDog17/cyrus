import { join } from "node:path";
import type {
	CyrusAgentSession,
	IAgentRunner,
	ILogger,
	InternalMessage,
	Issue,
	IssueMinimal,
	RepositoryConfig,
	RunnerType,
} from "cyrus-core";
import {
	extractCommentAuthor,
	extractCommentBody,
	extractCommentId,
	extractCommentUrl,
	extractPRBaseBranchRef,
	extractPRBranchRef,
	extractPRNumber,
	extractPRTitle,
	extractRepoFullName,
	extractRepoName,
	extractRepoOwner,
	extractSessionKey,
	GitHubAppTokenProvider,
	GitHubCommentService,
	type GitHubCommentWebhookEvent,
	GitHubEventTransport,
	type GitHubPushPayload,
	type GitHubWebhookEvent,
	isCommentOnPullRequest,
	isIssueCommentPayload,
	isPullRequestReviewCommentPayload,
	isPullRequestReviewPayload,
	stripMention,
} from "cyrus-github-event-transport";
import type { FastifyInstance } from "fastify";
import type { RunnerConfig } from "./RunnerConfigBuilder.js";
import type { SkillSessionContext } from "./SkillsPluginResolver.js";
import type { IActivitySink } from "./sinks/IActivitySink.js";

/**
 * Runner config produced by the session orchestrator.
 */
interface BuiltRunnerConfig {
	config: RunnerConfig;
	runnerType: RunnerType;
}

/**
 * Collaborators the {@link GitHubWorkflowService} binds to. Every function is a
 * late-bound arrow closure over the owning EdgeWorker instance (mirroring
 * {@link RepositoryRouterDeps} / {@link WebhookRouterDeps}), so the service can
 * read EdgeWorker state and delegate to its heavy-body methods without a
 * construction-order dependency.
 *
 * CRITICAL: `handleMessage` / `handleError` MUST bind to the heavy-body
 * EdgeWorker handlers, never to a thin delegator that forwards back into this
 * service — that would recurse forever (same invariant documented on
 * WebhookRouterDeps).
 */
export interface GitHubWorkflowServiceDeps {
	logger: ILogger;
	cyrusHome: string;

	/** Live Fastify instance the /github-webhook route registers on. */
	getFastifyInstance: () => FastifyInstance;

	/** Whether webhook IP validation is enabled (self-hosted signature mode). */
	isIpValidationEnabled: () => boolean;
	/** Resolve the GitHub webhook IP allowlist for signature-verified mode. */
	getGitHubIpAllowlist: () => string[] | undefined;

	/** Read the current edge-worker config (for the prReviewTrigger gate). */
	getPrReviewTrigger: () => boolean | undefined;

	/** All configured repositories (values of the repositories map). */
	allRepositories: () => RepositoryConfig[];

	/** Shared AgentSessionManager (typed loosely to avoid a hard import cycle). */
	getAgentSessionManager: () => GitHubAgentSessionManager;

	/** Map a session id to a repository id (EdgeWorker.sessionRepositories). */
	registerSessionRepository: (sessionId: string, repositoryId: string) => void;

	/** Resolve the activity sink for a repository, if any. */
	getActivitySinkForRepo: (repositoryId: string) => IActivitySink | undefined;

	/** Create a git worktree for a synthetic issue. */
	createGitWorktree: (
		issue: Issue,
		repositories: RepositoryConfig[],
	) => Promise<{ path: string; isGitWorktree: boolean }>;

	/** Build the GitHub-platform allowed tools list for a repository. */
	buildGithubAllowedTools: (repository: RepositoryConfig) => string[];
	/** Build the disallowed tools list for a repository. */
	buildDisallowedTools: (repository: RepositoryConfig) => string[];
	/** Build the skill session context for a session. */
	buildSkillSessionContext: (
		repository: RepositoryConfig,
		fullIssue: Issue | undefined,
		session: CyrusAgentSession,
	) => SkillSessionContext;

	/** Build the runner config (delegates to SessionOrchestrator). */
	buildAgentRunnerConfig: (
		session: CyrusAgentSession,
		repository: RepositoryConfig,
		sessionId: string,
		systemPrompt: string | undefined,
		allowedTools: string[],
		allowedDirectories: string[],
		disallowedTools: string[],
		resumeSessionId: string | undefined,
		labels: string[] | undefined,
		issueDescription: string | undefined,
		maxTurns: number | undefined,
		linearWorkspaceId: string | undefined,
		skillContext: SkillSessionContext | undefined,
		sessionPlatform: "linear" | "github",
	) => Promise<BuiltRunnerConfig>;
	/** Instantiate a runner for the given type (delegates to SessionOrchestrator). */
	createRunnerForType: (
		runnerType: RunnerType,
		config: RunnerConfig,
	) => IAgentRunner;

	/** Persist edge-worker state (fire-and-forget-safe). */
	savePersistedState: () => Promise<void>;

	/** Emit the `session:started` event + invoke the onSessionStart handler. */
	emitSessionStarted: (
		issueId: string,
		issue: Issue,
		repositoryId: string,
	) => void;

	/**
	 * Track active webhook processing for the status endpoint. GitHub comment
	 * handling owns its own increment/decrement shell (mirrors the Linear
	 * handleWebhook shell) so `computeStatus()` observes net-zero.
	 */
	incrementActiveWebhookCount: () => void;
	decrementActiveWebhookCount: () => void;

	/** Heavy-body message-bus handler (NOT a delegator — see class docs). */
	handleMessage: (message: InternalMessage) => void;
	/** Heavy-body error handler (NOT a delegator — see class docs). */
	handleError: (error: Error) => void;

	/** Dispatch a legacy GitHub webhook event through the WebhookRouter. */
	dispatchGitHubEvent: (event: GitHubWebhookEvent) => Promise<void>;
}

/**
 * Minimal shape of AgentSessionManager the GitHub workflow depends on. Declared
 * locally (rather than importing the class) to keep this service decoupled from
 * the manager's full surface.
 */
export interface GitHubAgentSessionManager {
	getActiveMultiRepoSessionForRepository(
		repositoryId: string,
	): CyrusAgentSession | undefined;
	getActiveSessionsByBranchName(branchName: string): CyrusAgentSession[];
	getSessionsByBaseBranch(
		branchName: string,
		repositoryId: string,
	): CyrusAgentSession[];
	createCyrusAgentSession(
		sessionId: string,
		externalSessionId: string,
		issue: IssueMinimal,
		workspace: { path: string; isGitWorktree: boolean },
		context: string,
		repositories: Array<{
			repositoryId: string;
			branchName?: string;
			baseBranchName?: string;
		}>,
	): void;
	setActivitySink(sessionId: string, sink: IActivitySink): void;
	getSession(sessionId: string): CyrusAgentSession | undefined;
	addAgentRunner(sessionId: string, runner: IAgentRunner): void;
}

/**
 * Owns the full GitHub Pull Request workflow, extracted verbatim from
 * EdgeWorker to shrink the orchestrator God Object:
 *
 * - Registering the `/github-webhook` transport + App token provider
 * - Resolving a GitHub API token (forwarded → App-minted → PAT fallback)
 * - Handling PR comment / review webhooks (workspace, session, runner, reply)
 * - Handling push webhooks (base-branch rebase notifications)
 * - Building GitHub-specific system prompts
 *
 * Behaviour is unchanged; this is a pure move + rewire. All EdgeWorker state it
 * needs is reached through {@link GitHubWorkflowServiceDeps}.
 */
export class GitHubWorkflowService {
	private gitHubEventTransport: GitHubEventTransport | null = null;
	private gitHubAppTokenProvider: GitHubAppTokenProvider | null = null;
	private readonly gitHubCommentService: GitHubCommentService;
	private readonly logger: ILogger;

	constructor(private readonly deps: GitHubWorkflowServiceDeps) {
		this.logger = deps.logger;
		this.gitHubCommentService = new GitHubCommentService();
	}

	/**
	 * Register the GitHub event transport for receiving forwarded GitHub webhooks
	 * from CYHOST. Creates a `/github-webhook` endpoint that handles @cyrusagent
	 * mentions on GitHub PRs.
	 */
	registerEventTransport(): void {
		// Use direct GitHub signature verification only when BOTH:
		// 1. GITHUB_WEBHOOK_SECRET is set (we have the secret to verify)
		// 2. CYRUS_HOST_EXTERNAL is true (self-hosted: GitHub sends directly to us)
		// On cloud droplets, CYHOST forwards webhooks with Bearer token auth
		// (it verifies the GitHub signature itself and doesn't forward the headers).
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const hasGithubWebhookSecret =
			process.env.GITHUB_WEBHOOK_SECRET != null &&
			process.env.GITHUB_WEBHOOK_SECRET !== "";
		const useSignatureVerification = isExternalHost && hasGithubWebhookSecret;
		const verificationMode = useSignatureVerification ? "signature" : "proxy";
		const secret = useSignatureVerification
			? process.env.GITHUB_WEBHOOK_SECRET!
			: process.env.CYRUS_API_KEY || "";

		this.gitHubEventTransport = new GitHubEventTransport({
			fastifyServer: this.deps.getFastifyInstance(),
			verificationMode,
			secret,
			ipAllowlist:
				useSignatureVerification && this.deps.isIpValidationEnabled()
					? this.deps.getGitHubIpAllowlist()
					: undefined,
		});

		// Listen for legacy GitHub webhook events (deprecated, kept for backward compatibility).
		// The WebhookRouter performs the push-vs-comment fan-out; the comment handler
		// (handleWebhook) owns its own activeWebhookCount shell. Kept
		// fire-and-forget (.catch, not awaited) so a slow handler never blocks the
		// transport.
		this.gitHubEventTransport.on("event", (event: GitHubWebhookEvent) => {
			this.deps.dispatchGitHubEvent(event).catch((error) => {
				this.logger.error(
					"Failed to handle GitHub webhook",
					error instanceof Error ? error : new Error(String(error)),
				);
			});
		});

		// Listen for unified internal messages (new message bus)
		this.gitHubEventTransport.on("message", (message: InternalMessage) => {
			this.deps.handleMessage(message);
		});

		// Listen for errors
		this.gitHubEventTransport.on("error", (error: Error) => {
			this.deps.handleError(error);
		});

		// Register the /github-webhook endpoint
		this.gitHubEventTransport.register();

		// Initialize GitHub App token provider for self-hosted users
		const appId = process.env.GITHUB_APP_ID;
		const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
		if (appId && installationId) {
			const pemPath = join(this.deps.cyrusHome, "github-app.pem");
			this.gitHubAppTokenProvider = new GitHubAppTokenProvider({
				appId,
				installationId,
				privateKeyPath: pemPath,
			});
			this.logger.info(
				"GitHub App token provider initialized (self-hosted mode)",
			);
		}

		this.logger.info(
			`GitHub event transport registered (${verificationMode} mode)`,
		);
		this.logger.info("Webhook endpoint: POST /github-webhook");
	}

	/**
	 * Resolve a GitHub API token from (in priority order):
	 * 1. Forwarded installation token from CYHOST (cloud/proxy mode)
	 * 2. Self-minted installation token from GitHub App credentials (self-hosted)
	 * 3. Personal access token from GITHUB_TOKEN env var (fallback)
	 */
	async resolveToken(event: GitHubWebhookEvent): Promise<string | undefined> {
		if (event.installationToken) return event.installationToken;
		if (this.gitHubAppTokenProvider) {
			try {
				return await this.gitHubAppTokenProvider.getToken();
			} catch (error) {
				this.logger.warn(
					"Failed to mint GitHub App installation token, falling back to GITHUB_TOKEN",
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		return process.env.GITHUB_TOKEN;
	}

	/**
	 * Handle a GitHub webhook event (forwarded from CYHOST).
	 *
	 * This creates a new session for the GitHub PR comment, checks out the PR
	 * branch via git worktree, and processes the comment as a task prompt.
	 */
	async handleWebhook(event: GitHubCommentWebhookEvent): Promise<void> {
		this.deps.incrementActiveWebhookCount();

		try {
			// Only handle comments on pull requests
			if (!isCommentOnPullRequest(event)) {
				this.logger.debug("Ignoring GitHub comment on non-PR issue");
				return;
			}

			const repoFullName = extractRepoFullName(event);
			const prNumber = extractPRNumber(event);
			const commentBody = extractCommentBody(event);
			const commentAuthor = extractCommentAuthor(event);
			const prTitle = extractPRTitle(event);
			const sessionKey = extractSessionKey(event);

			const isPullRequestReview = isPullRequestReviewPayload(event.payload);

			// Skip comments from the bot itself to prevent infinite loops
			const botUsername = process.env.GITHUB_BOT_USERNAME;
			if (botUsername && commentAuthor === botUsername) {
				this.logger.debug(
					`Ignoring comment from bot user @${botUsername} on ${repoFullName}#${prNumber}`,
				);
				return;
			}

			// For pull_request_review events, defensively check review state
			// (must happen before the mention check — reviews don't contain @mentions)
			if (isPullRequestReviewPayload(event.payload)) {
				if (event.payload.review.state !== "changes_requested") {
					this.logger.debug(
						`Ignoring pull_request_review with state: ${event.payload.review.state}`,
					);
					return;
				}
			}

			// Honor the PR-review trigger toggle: when disabled, ignore
			// pull_request_review events entirely — no acknowledgement comment and
			// no agent session. Defaults to enabled when the flag is unset.
			if (isPullRequestReview && this.deps.getPrReviewTrigger() === false) {
				this.logger.debug(
					`PR review trigger is disabled, ignoring pull_request_review on ${repoFullName}#${prNumber}`,
				);
				return;
			}

			// Only trigger on comments that mention the bot (when configured)
			// Skip this check for pull_request_review events — reviews don't @mention the bot
			if (
				!isPullRequestReview &&
				botUsername &&
				!commentBody.includes(`@${botUsername}`)
			) {
				this.logger.debug(
					`Ignoring comment without @${botUsername} mention on ${repoFullName}#${prNumber}`,
				);
				return;
			}

			this.logger.info(
				`Processing GitHub webhook: ${repoFullName}#${prNumber} by @${commentAuthor}${isPullRequestReview ? " (pull_request_review)" : ""}`,
			);

			// Add "eyes" reaction to acknowledge receipt (not for pull_request_review — we post a comment instead)
			const reactionToken = await this.resolveToken(event);
			if (reactionToken && !isPullRequestReview) {
				const commentId = extractCommentId(event);
				if (commentId) {
					this.gitHubCommentService
						.addReaction({
							token: reactionToken,
							owner: extractRepoOwner(event),
							repo: extractRepoName(event),
							commentId,
							isPullRequestReviewComment: isPullRequestReviewCommentPayload(
								event.payload,
							),
							content: "eyes",
						})
						.catch((err: unknown) => {
							this.logger.warn(
								`Failed to add reaction: ${err instanceof Error ? err.message : err}`,
							);
						});
				}
			}

			// Find the repository configuration that matches this GitHub repo
			const repository = this.findRepositoryByGitHubUrl(repoFullName);
			if (!repository) {
				this.logger.warn(
					`No repository configured for GitHub repo: ${repoFullName}`,
				);

				// Only reply on signals where the user clearly directed something at us:
				// an explicit @-mention, or a pull_request_review requesting changes.
				const wasMentioned =
					!!botUsername && commentBody.includes(`@${botUsername}`);
				const shouldReply = wasMentioned || isPullRequestReview;

				if (shouldReply && reactionToken && prNumber) {
					// Presence of CYRUS_API_KEY indicates this worker is paired with the
					// managed control plane (paid customer). Absence means the worker is
					// running on the Community plan (self-managed config.json).
					const isManagedCustomer = !!process.env.CYRUS_API_KEY;

					const commonPreamble = [
						`Cyrus received this webhook but has no repository configured for \`${repoFullName}\`, so no agent session was started.`,
						``,
						`**Likely causes:**`,
						`- The owner/org was **renamed or transferred** on GitHub. Webhooks are delivered under the current owner name, but Cyrus's stored repository URL still points at the old one. GitHub's web redirects don't apply to webhook payloads — the stored URL has to be updated explicitly.`,
						`- The stored repository URL has a typo (e.g. wrong org/owner) and doesn't match the repo this event came from.`,
						`- The GitHub App / webhook is installed on a repo Cyrus isn't configured for at all.`,
						``,
					];

					const fix = isManagedCustomer
						? `**What to do:** there's currently no self-serve way to update the stored repository URL on your plan — please reach out to Cyrus support and reference \`${repoFullName}\` and we'll reconcile it on the backend.`
						: `**What to do:** open \`~/.cyrus/config.json\` on the worker and update the \`githubUrl\` of the relevant repository to \`https://github.com/${repoFullName}\`. The worker watches the config file and will pick up the change automatically. If this repo shouldn't be sending events to Cyrus at all, remove the GitHub App from it instead.`;

					this.gitHubCommentService
						.postIssueComment({
							token: reactionToken,
							owner: extractRepoOwner(event),
							repo: extractRepoName(event),
							issueNumber: prNumber,
							body: [...commonPreamble, fix].join("\n"),
						})
						.catch((err: unknown) => {
							this.logger.warn(
								`Failed to post unconfigured-repo notice: ${err instanceof Error ? err.message : err}`,
							);
						});
				}
				return;
			}

			const agentSessionManager = this.deps.getAgentSessionManager();

			// For pull_request_review events, post an instant acknowledgement comment
			if (isPullRequestReview && reactionToken && prNumber) {
				this.gitHubCommentService
					.postIssueComment({
						token: reactionToken,
						owner: extractRepoOwner(event),
						repo: extractRepoName(event),
						issueNumber: prNumber,
						body: "Received your change request. Getting started on those changes now.",
					})
					.catch((err: unknown) => {
						this.logger.warn(
							`Failed to post acknowledgement comment: ${err instanceof Error ? err.message : err}`,
						);
					});
			}

			// Determine the PR head branch and base branch
			let branchRef = extractPRBranchRef(event);
			let baseBranchRef = extractPRBaseBranchRef(event);

			// For issue_comment events, the branch refs are not in the payload
			// We need to fetch them from the GitHub API
			if (!branchRef && isIssueCommentPayload(event.payload)) {
				const refs = await this.fetchPRBranchRefs(event, repository);
				branchRef = refs?.headRef ?? null;
				baseBranchRef = refs?.baseRef ?? null;
			}

			if (!branchRef || !prNumber) {
				this.logger.error(
					`Could not determine branch or PR number for ${repoFullName}#${prNumber}`,
				);
				return;
			}

			// For pull_request_review, the review body IS the task context (no mention to strip)
			// For other events, strip the bot mention to get the task instructions
			const mentionHandle = botUsername ? `@${botUsername}` : "@cyrusagent";
			const taskInstructions = isPullRequestReview
				? commentBody ||
					"A reviewer has requested changes on this PR. Read the review comments to understand what needs to be changed."
				: stripMention(commentBody, mentionHandle);

			// Check for an existing multi-repo session that includes this repository.
			// If found, use its sub-worktree instead of creating a new workspace.
			let workspace: { path: string; isGitWorktree: boolean } | null = null;
			const multiRepoSession =
				agentSessionManager.getActiveMultiRepoSessionForRepository(
					repository.id,
				);

			if (multiRepoSession) {
				const subWorktreePath =
					multiRepoSession.workspace.repoPaths?.[repository.id];
				if (subWorktreePath) {
					workspace = { path: subWorktreePath, isGitWorktree: true };
					this.logger.info(
						`Resolved multi-repo sub-worktree for ${repository.name}: ${subWorktreePath}`,
					);
				} else {
					this.logger.warn(
						`No sub-worktree found for repo ${repository.name} in multi-repo session ${multiRepoSession.id}, falling back to root workspace`,
					);
					workspace = {
						path: multiRepoSession.workspace.path,
						isGitWorktree: true,
					};
				}
			} else {
				// Single-repo or no existing session: create workspace as before
				workspace = await this.createGitHubWorkspace(
					repository,
					branchRef,
					prNumber,
				);
			}

			if (!workspace) {
				this.logger.error(
					`Failed to create workspace for ${repoFullName}#${prNumber}`,
				);
				return;
			}

			this.logger.info(`GitHub workspace created at: ${workspace.path}`);

			// Check if another active session is already using this branch/workspace
			const existingSessions =
				agentSessionManager.getActiveSessionsByBranchName(branchRef);
			const firstExisting = existingSessions[0];
			if (firstExisting) {
				this.logger.warn(
					`Reusing workspace from active session ${firstExisting.id} — concurrent writes possible`,
				);
			}

			// Create a synthetic session for this GitHub PR comment
			const issueMinimal: IssueMinimal = {
				id: sessionKey,
				identifier: `${extractRepoName(event)}#${prNumber}`,
				title: prTitle || `PR #${prNumber}`,
				branchName: branchRef,
			};

			// Create an internal agent session (no Linear session for GitHub)
			const githubSessionId = `github-${event.deliveryId}`;
			agentSessionManager.createCyrusAgentSession(
				githubSessionId,
				sessionKey,
				issueMinimal,
				workspace,
				"github", // Don't stream activities to Linear for GitHub sources
				[
					{
						repositoryId: repository.id,
						branchName: branchRef,
						baseBranchName: baseBranchRef ?? repository.baseBranch,
					},
				],
			);

			// Register session-to-repo mapping and activity sink
			this.deps.registerSessionRepository(githubSessionId, repository.id);
			const activitySink = this.deps.getActivitySinkForRepo(repository.id);
			if (activitySink) {
				agentSessionManager.setActivitySink(githubSessionId, activitySink);
			}

			const session = agentSessionManager.getSession(githubSessionId);
			if (!session) {
				this.logger.error(
					`Failed to create session for GitHub webhook ${event.deliveryId}`,
				);
				return;
			}

			// Initialize session metadata
			if (!session.metadata) {
				session.metadata = {};
			}

			// Store GitHub-specific metadata for reply posting
			session.metadata.commentId = String(extractCommentId(event));

			// Build the system prompt for this GitHub PR session
			const systemPrompt = isPullRequestReview
				? this.buildChangeRequestSystemPrompt(
						event,
						branchRef,
						taskInstructions,
					)
				: this.buildSystemPrompt(event, branchRef, taskInstructions);

			// Build allowed tools using the GitHub platform resolver, which honors
			// `githubAllowedTools` on the workspace config and falls back to
			// `GITHUB_DEFAULT_ALLOWED_TOOLS`.
			const allowedTools = this.deps.buildGithubAllowedTools(repository);
			const disallowedTools = this.deps.buildDisallowedTools(repository);
			const allowedDirectories: string[] = [repository.repositoryPath];

			// Create agent runner using the standard config builder
			const { config: runnerConfig, runnerType } =
				await this.deps.buildAgentRunnerConfig(
					session,
					repository,
					githubSessionId,
					systemPrompt,
					allowedTools,
					allowedDirectories,
					disallowedTools,
					undefined, // resumeSessionId
					undefined, // labels
					undefined, // issueDescription
					200, // maxTurns
					undefined, // linearWorkspaceId
					this.deps.buildSkillSessionContext(repository, undefined, session),
					"github", // sessionPlatform → uses githubMcpConfigs override
				);

			const runner = this.deps.createRunnerForType(runnerType, runnerConfig);

			// Store the runner in the session manager
			agentSessionManager.addAgentRunner(githubSessionId, runner);

			// Save persisted state
			await this.deps.savePersistedState();

			this.deps.emitSessionStarted(
				sessionKey,
				issueMinimal as unknown as Issue,
				repository.id,
			);

			this.logger.info(
				`Starting ${runnerType} runner for GitHub PR ${repoFullName}#${prNumber}`,
			);

			// Start the session and handle completion
			try {
				const sessionInfo = await runner.start(taskInstructions);
				this.logger.info(`GitHub session started: ${sessionInfo.sessionId}`);

				// When session completes, post the reply back to GitHub
				await this.postReply(event, runner, repository);
			} catch (error) {
				this.logger.error(
					`GitHub session error for ${repoFullName}#${prNumber}`,
					error instanceof Error ? error : new Error(String(error)),
				);
			} finally {
				await this.deps.savePersistedState();
			}
		} catch (error) {
			this.logger.error(
				"Failed to process GitHub webhook",
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.deps.decrementActiveWebhookCount();
		}
	}

	/**
	 * Handle GitHub push webhook events.
	 * When a base branch receives new commits, find active sessions tracking that
	 * branch and stream a rebase notification to the running agent.
	 */
	async handlePushWebhook(payload: GitHubPushPayload): Promise<void> {
		// Only handle branch pushes (refs/heads/*), not tags
		if (!payload.ref.startsWith("refs/heads/")) {
			return;
		}

		// Ignore branch deletions
		if (payload.deleted) {
			return;
		}

		const branchName = payload.ref.replace("refs/heads/", "");
		const repoFullName = payload.repository.full_name;

		// Find the matching repository config
		const repository = this.findRepositoryByGitHubUrl(repoFullName);
		if (!repository) {
			this.logger.debug(
				`No repository configured for GitHub push from ${repoFullName}`,
			);
			return;
		}

		// Find active sessions tracking this branch as their base branch
		const sessions = this.deps
			.getAgentSessionManager()
			.getSessionsByBaseBranch(branchName, repository.id);

		if (sessions.length === 0) {
			this.logger.debug(
				`No active sessions tracking base branch ${branchName} for ${repository.name}`,
			);
			return;
		}

		// Build a notification prompt with commit summary
		const commitCount = payload.commits.length;
		const commitSummary = payload.commits
			.slice(0, 5)
			.map((c) => `- ${c.message.split("\n")[0]}`)
			.join("\n");
		const moreCommits =
			commitCount > 5 ? `\n- ... and ${commitCount - 5} more` : "";

		const notification = `<base_branch_update>
<branch>${branchName}</branch>
<repository>${repoFullName}</repository>
<commit_count>${commitCount}</commit_count>
<compare_url>${payload.compare}</compare_url>
<commits>
${commitSummary}${moreCommits}
</commits>
<guidance>
Your base branch \`${branchName}\` has received ${commitCount} new commit(s). Consider rebasing your working branch onto the updated base to avoid merge conflicts. You can do this with: \`git fetch origin && git rebase origin/${branchName}\`
</guidance>
</base_branch_update>`;

		this.logger.info(
			`Base branch ${branchName} updated (${commitCount} commits) — notifying ${sessions.length} active session(s)`,
		);

		// Stream notification to the first running session that supports streaming
		const sortedSessions = [...sessions].sort(
			(a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
		);

		for (const session of sortedSessions) {
			const existingRunner = session.agentRunner;
			const isRunning = existingRunner?.isRunning() || false;

			if (
				isRunning &&
				existingRunner?.supportsStreamingInput &&
				existingRunner.addStreamMessage
			) {
				// Best-effort notification; a steer-only backend may reject it if no
				// turn is active. Don't let that throw out of the update handler.
				try {
					existingRunner.addStreamMessage(notification);
					this.logger.debug(
						`[base-branch-update] Streamed notification to session ${session.id} for branch ${branchName}`,
					);
					break;
				} catch (error) {
					this.logger.debug(
						`[base-branch-update] Stream rejected for session ${session.id}; skipping`,
						{ error: error instanceof Error ? error.message : String(error) },
					);
				}
			}
		}
	}

	/**
	 * Find a repository configuration that matches a GitHub repository URL.
	 * Matches against the githubUrl field in repository config.
	 */
	findRepositoryByGitHubUrl(repoFullName: string): RepositoryConfig | null {
		for (const repo of this.deps.allRepositories()) {
			if (!repo.githubUrl) continue;
			// Match against full name (owner/repo) or URL containing it
			if (
				repo.githubUrl.includes(repoFullName) ||
				repo.githubUrl.endsWith(`/${repoFullName}`)
			) {
				return repo;
			}
		}
		return null;
	}

	/**
	 * Fetch the PR head and base branch refs for an issue_comment webhook.
	 * For issue_comment events, the branch refs are not in the payload
	 * and must be fetched from the GitHub API.
	 */
	async fetchPRBranchRefs(
		event: GitHubCommentWebhookEvent,
		_repository: RepositoryConfig,
	): Promise<{ headRef: string; baseRef: string } | null> {
		if (!isIssueCommentPayload(event.payload)) return null;

		const prUrl = event.payload.issue.pull_request?.url;
		if (!prUrl) return null;

		try {
			const owner = extractRepoOwner(event);
			const repo = extractRepoName(event);
			const prNumber = event.payload.issue.number;

			const headers: Record<string, string> = {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			};

			// Resolve GitHub token (installation token > App token > PAT)
			const token = await this.resolveToken(event);
			if (token) {
				headers.Authorization = `Bearer ${token}`;
			}

			const response = await fetch(
				`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
				{ headers },
			);

			if (!response.ok) {
				this.logger.warn(
					`Failed to fetch PR details from GitHub API: ${response.status}`,
				);
				return null;
			}

			const prData = (await response.json()) as {
				head?: { ref?: string };
				base?: { ref?: string };
			};
			const headRef = prData.head?.ref;
			const baseRef = prData.base?.ref;
			if (!headRef) return null;
			return { headRef, baseRef: baseRef ?? "" };
		} catch (error) {
			this.logger.error(
				"Failed to fetch PR branch refs",
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Create a git worktree for a GitHub PR branch.
	 * If the worktree already exists for this branch, reuse it.
	 */
	async createGitHubWorkspace(
		repository: RepositoryConfig,
		branchRef: string,
		prNumber: number,
	): Promise<{ path: string; isGitWorktree: boolean } | null> {
		try {
			// Use the GitService to create the worktree
			// Create a synthetic issue-like object for the git service
			const syntheticIssue = {
				id: `github-pr-${prNumber}`,
				identifier: `PR-${prNumber}`,
				title: `PR #${prNumber}`,
				description: null,
				url: "",
				branchName: branchRef,
				assigneeId: null,
				stateId: null,
				teamId: null,
				labelIds: [],
				priority: 0,
				createdAt: new Date(),
				updatedAt: new Date(),
				archivedAt: null,
				state: Promise.resolve(undefined),
				assignee: Promise.resolve(undefined),
				team: Promise.resolve(undefined),
				parent: Promise.resolve(undefined),
				project: Promise.resolve(undefined),
				labels: () => Promise.resolve({ nodes: [] }),
				comments: () => Promise.resolve({ nodes: [] }),
				attachments: () => Promise.resolve({ nodes: [] }),
				children: () => Promise.resolve({ nodes: [] }),
				inverseRelations: () => Promise.resolve({ nodes: [] }),
				update: () =>
					Promise.resolve({
						success: true,
						issue: undefined,
						lastSyncId: 0,
					}),
			} as unknown as Issue;

			return await this.deps.createGitWorktree(syntheticIssue, [repository]);
		} catch (error) {
			this.logger.error(
				`Failed to create GitHub workspace for PR #${prNumber}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Build a system prompt for a GitHub PR comment session.
	 */
	buildSystemPrompt(
		event: GitHubCommentWebhookEvent,
		branchRef: string,
		taskInstructions: string,
	): string {
		const repoFullName = extractRepoFullName(event);
		const prNumber = extractPRNumber(event);
		const prTitle = extractPRTitle(event);
		const commentAuthor = extractCommentAuthor(event);
		const commentUrl = extractCommentUrl(event);

		return `You are working on a GitHub Pull Request.

## Context
- **Repository**: ${repoFullName}
- **PR**: #${prNumber} - ${prTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Requested by**: @${commentAuthor}
- **Comment URL**: ${commentUrl}

## Task
${taskInstructions}

## Instructions
- You are already checked out on the PR branch \`${branchRef}\`
- Make changes directly to the code on this branch
- After making changes, commit and push them to the branch
- Be concise in your responses as they will be posted back to the GitHub PR`;
	}

	/**
	 * Build a system prompt for a GitHub PR change request review session.
	 */
	buildChangeRequestSystemPrompt(
		event: GitHubCommentWebhookEvent,
		branchRef: string,
		reviewBody: string,
	): string {
		const repoFullName = extractRepoFullName(event);
		const prNumber = extractPRNumber(event);
		const prTitle = extractPRTitle(event);
		const commentAuthor = extractCommentAuthor(event);
		const commentUrl = extractCommentUrl(event);

		const hasReviewBody = reviewBody.trim().length > 0;

		const taskSection = hasReviewBody
			? `## Reviewer Feedback
${reviewBody}

## Instructions
- Read the PR diff and the reviewer's feedback above to understand all requested changes
- You are already checked out on the PR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`
			: `## Instructions
- The reviewer has requested changes but did not leave a summary comment
- Use \`gh api repos/${repoFullName}/pulls/${prNumber}/reviews\` to read the review comments and understand what changes are needed
- You are already checked out on the PR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`;

		return `You are working on a GitHub Pull Request that has received a change request review.

## Context
- **Repository**: ${repoFullName}
- **PR**: #${prNumber} - ${prTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Reviewer**: @${commentAuthor}
- **Review URL**: ${commentUrl}

${taskSection}`;
	}

	/**
	 * Post a reply back to the GitHub PR comment after the session completes.
	 */
	async postReply(
		event: GitHubCommentWebhookEvent,
		runner: IAgentRunner,
		_repository: RepositoryConfig,
	): Promise<void> {
		try {
			// Get the last assistant message from the runner as the summary
			const messages = runner.getMessages();
			const lastAssistantMessage = [...messages]
				.reverse()
				.find((m) => m.type === "assistant");

			let summary = "Task completed. Please review the changes on this branch.";
			if (lastAssistantMessage && lastAssistantMessage.type === "assistant") {
				const textBlock = lastAssistantMessage.content.find(
					(block) => block.type === "text" && block.text,
				);
				if (textBlock?.type === "text" && textBlock.text) {
					summary = textBlock.text;
				}
			}

			const owner = extractRepoOwner(event);
			const repo = extractRepoName(event);
			const prNumber = extractPRNumber(event);
			const commentId = extractCommentId(event);

			if (!prNumber) {
				this.logger.warn("Cannot post GitHub reply: no PR number");
				return;
			}

			// Resolve GitHub token (installation token > App token > PAT)
			const token = await this.resolveToken(event);
			if (!token) {
				this.logger.warn(
					"Cannot post GitHub reply: no installation token or GITHUB_TOKEN configured",
				);
				this.logger.debug(
					`Would have posted reply to ${owner}/${repo}#${prNumber} (comment ${commentId}): ${summary}`,
				);
				return;
			}

			if (event.eventType === "pull_request_review_comment") {
				// Reply to the specific review comment thread
				await this.gitHubCommentService.postReviewCommentReply({
					token,
					owner,
					repo,
					pullNumber: prNumber,
					commentId,
					body: summary,
				});
			} else {
				// Post as a regular issue comment on the PR
				await this.gitHubCommentService.postIssueComment({
					token,
					owner,
					repo,
					issueNumber: prNumber,
					body: summary,
				});
			}

			this.logger.info(`Posted GitHub reply to ${owner}/${repo}#${prNumber}`);
		} catch (error) {
			this.logger.error(
				"Failed to post GitHub reply",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}
}
