import {
	type AgentSessionCreatedWebhook,
	type AgentSessionPromptedWebhook,
	createLogger,
	type IIssueTrackerService,
	type ILogger,
	type RepositoryConfig,
	type Webhook,
} from "cyrus-core";
import { LinearActivitySink } from "./sinks/LinearActivitySink.js";

/**
 * Repository routing result types
 */
export type RepositoryRoutingResult =
	| {
			type: "selected";
			repositories: RepositoryConfig[];
			/** Per-repo base branch overrides from [repo=name#branch] syntax */
			baseBranchOverrides?: Map<string, string>;
			routingMethod:
				| "description-tag"
				| "label-based"
				| "project-based"
				| "team-based"
				| "team-prefix"
				| "catch-all"
				| "workspace-fallback";
	  }
	| { type: "needs_selection"; workspaceRepos: RepositoryConfig[] }
	| { type: "none" };

/**
 * Pending repository selection data
 */
export interface PendingRepositorySelection {
	issueId: string;
	workspaceRepos: RepositoryConfig[];
}

/**
 * Repository router dependencies
 */
export interface RepositoryRouterDeps {
	/** Fetch issue labels for label-based routing */
	fetchIssueLabels: (issueId: string, workspaceId: string) => Promise<string[]>;

	/** Fetch issue description for description-tag routing */
	fetchIssueDescription: (
		issueId: string,
		workspaceId: string,
	) => Promise<string | undefined>;

	/** Check if an issue has active sessions in a repository */
	hasActiveSession: (issueId: string, repositoryId: string) => boolean;

	/** Get issue tracker service for a workspace */
	getIssueTracker: (workspaceId: string) => IIssueTrackerService | undefined;
}

/**
 * RepositoryRouter handles all repository routing logic including:
 * - Multi-priority routing (labels, projects, teams)
 * - Issue-to-repository caching
 * - Repository selection UI via Linear elicitation
 * - Selection response handling
 *
 * This class was extracted from EdgeWorker to improve modularity and testability.
 */
export class RepositoryRouter {
	/** Cache mapping issue IDs to selected repository IDs (array for multi-repo) */
	private issueRepositoryCache = new Map<string, string[]>();

	/** Pending repository selections awaiting user response */
	private pendingSelections = new Map<string, PendingRepositorySelection>();

	private logger: ILogger;

	constructor(
		private deps: RepositoryRouterDeps,
		logger?: ILogger,
	) {
		this.logger = logger ?? createLogger({ component: "RepositoryRouter" });
	}

	/**
	 * Get cached repositories for an issue
	 *
	 * This is a simple cache lookup used by agentSessionPrompted webhooks (Branch 3).
	 * Per CLAUDE.md: "The repository will be retrieved from the issue-to-repository
	 * cache - no new routing logic is performed."
	 *
	 * @param issueId The Linear issue ID
	 * @param repositoriesMap Map of repository IDs to configurations
	 * @returns The cached repositories array, or null if not found
	 */
	getCachedRepositories(
		issueId: string,
		repositoriesMap: Map<string, RepositoryConfig>,
	): RepositoryConfig[] | null {
		const cachedRepositoryIds = this.issueRepositoryCache.get(issueId);
		if (!cachedRepositoryIds || cachedRepositoryIds.length === 0) {
			this.logger.debug(`No cached repository found for issue ${issueId}`);
			return null;
		}

		const resolvedRepos: RepositoryConfig[] = [];
		const invalidIds: string[] = [];

		for (const repoId of cachedRepositoryIds) {
			const repo = repositoriesMap.get(repoId);
			if (repo) {
				resolvedRepos.push(repo);
			} else {
				invalidIds.push(repoId);
			}
		}

		if (invalidIds.length > 0) {
			this.logger.warn(
				`Cached repositories [${invalidIds.join(", ")}] no longer exist, cleaning cache`,
			);
			if (resolvedRepos.length === 0) {
				this.issueRepositoryCache.delete(issueId);
				return null;
			}
			// Update cache to only contain valid IDs
			this.issueRepositoryCache.set(
				issueId,
				resolvedRepos.map((r) => r.id),
			);
		}

		this.logger.debug(
			`Using cached repositories [${resolvedRepos.map((r) => r.name).join(", ")}] for issue ${issueId}`,
		);
		return resolvedRepos;
	}

	/**
	 * Reconcile a cached issue→repository mapping against the issue's current
	 * project, re-homing it when the two have drifted apart.
	 *
	 * A sub-issue inherits its parent's project, so the first routing decision can
	 * pin an issue to the parent-project's repository. Because the mapping is read
	 * back verbatim on every later webhook (see {@link getCachedRepositories}),
	 * moving the issue to the correct project afterwards would otherwise never
	 * take effect. This detects that drift — a cached repo that participates in
	 * project routing whose projectKeys no longer contain the issue's current
	 * project, while a *different* configured repo's projectKeys do — and repoints
	 * the cache at the project-matched repository so the caller routes there.
	 *
	 * Forcing the mapping (rather than only deleting it) deliberately overrides the
	 * "existing active session wins" (Priority 0) and "no repo switch within an
	 * issue" rules: moving an issue's project is an explicit signal to re-home it.
	 * Any worktree / session already provisioned on the previous repo is abandoned
	 * in place — a fresh session/worktree is provisioned on the new repo.
	 *
	 * @returns the project-matched repositories when the cache was repointed, else null.
	 */
	async reconcileCacheOnProjectMismatch(
		webhook: AgentSessionCreatedWebhook | AgentSessionPromptedWebhook,
		repos: RepositoryConfig[],
	): Promise<RepositoryConfig[] | null> {
		const { issueId } = this.extractIssueInfo(webhook);
		const workspaceId = webhook.organizationId;
		if (!issueId || !workspaceId) return null;

		const cachedRepositoryIds = this.issueRepositoryCache.get(issueId);
		if (!cachedRepositoryIds || cachedRepositoryIds.length === 0) return null;

		// Only meaningful when the cached mapping participates in project routing.
		// A description-tag / label / team decision is authoritative for its own
		// reasons and must not be second-guessed here.
		const cachedProjectRepos = cachedRepositoryIds
			.map((id) => repos.find((r) => r.id === id))
			.filter(
				(r): r is RepositoryConfig =>
					!!r?.projectKeys && r.projectKeys.length > 0,
			);
		if (cachedProjectRepos.length === 0) return null;

		// Fetch the issue's current project name.
		let projectName: string | undefined;
		try {
			const issueTracker = this.deps.getIssueTracker(workspaceId);
			if (!issueTracker) return null;
			const fullIssue = await issueTracker.fetchIssue(issueId);
			const project = await fullIssue?.project;
			projectName = project?.name ?? undefined;
		} catch (error) {
			this.logger.debug(
				`Failed to fetch project for cache reconciliation on issue ${issueId}:`,
				error,
			);
			return null;
		}

		// No project → cannot determine a mismatch; leave the cache untouched.
		if (!projectName) return null;
		const currentProject: string = projectName;

		// Cached mapping still valid for the current project → nothing to do.
		if (
			cachedProjectRepos.some((r) => r.projectKeys?.includes(currentProject))
		) {
			return null;
		}

		// The current project positively maps to a different configured repo.
		const projectMatchedRepo = repos.find((r) =>
			r.projectKeys?.includes(currentProject),
		);
		if (!projectMatchedRepo) return null;

		this.logger.info(
			`Issue ${issueId} project "${currentProject}" no longer matches cached repositories [${cachedProjectRepos
				.map((r) => r.name)
				.join(", ")}]; re-routing to ${projectMatchedRepo.name}`,
		);
		this.issueRepositoryCache.set(issueId, [projectMatchedRepo.id]);
		return [projectMatchedRepo];
	}

	/**
	 * Determine repositories for webhook using multi-priority routing:
	 * Priority 0: Existing active sessions
	 * Priority 1: Description tag (explicit [repo=...] in issue description)
	 * Priority 2: Routing labels
	 * Priority 3: Project-based routing
	 * Priority 4: Team-based routing
	 * Priority 5: Catch-all repositories
	 *
	 * Description-tag and label-based routing, when matched, skip lower-priority routing.
	 * If no routing matches, returns needs_selection (no default assignment).
	 */
	async determineRepositoryForWebhook(
		webhook: AgentSessionCreatedWebhook | AgentSessionPromptedWebhook,
		repos: RepositoryConfig[],
	): Promise<RepositoryRoutingResult> {
		const workspaceId = webhook.organizationId;
		if (!workspaceId) {
			return repos[0]
				? {
						type: "selected",
						repositories: [repos[0]],
						routingMethod: "workspace-fallback",
					}
				: { type: "none" };
		}

		// Extract issue information
		const { issueId, teamKey, issueIdentifier } =
			this.extractIssueInfo(webhook);

		// Priority 0: Check for existing active sessions
		// TODO: Remove this priority check - existing session detection should not be a routing method
		if (issueId) {
			const activeRepos: RepositoryConfig[] = [];
			for (const repo of repos) {
				if (this.deps.hasActiveSession(issueId, repo.id)) {
					activeRepos.push(repo);
				}
			}
			if (activeRepos.length > 0) {
				this.logger.info(
					`Repositories selected: [${activeRepos.map((r) => r.name).join(", ")}] (existing active session)`,
				);
				return {
					type: "selected",
					repositories: activeRepos,
					routingMethod: "workspace-fallback",
				};
			}
		}

		// Filter repos by workspace
		const workspaceRepos = repos.filter(
			(repo) => repo.linearWorkspaceId === workspaceId,
		);
		if (workspaceRepos.length === 0) return { type: "none" };

		// Priority 1: Check description tags [repo=...] (supports multiple, with optional #branch)
		const descriptionTagResult = await this.findRepositoriesByDescriptionTag(
			issueId,
			workspaceRepos,
			workspaceId,
		);
		if (descriptionTagResult.repositories.length > 0) {
			this.logger.info(
				`Repositories selected: [${descriptionTagResult.repositories.map((r) => r.name).join(", ")}] (description-tag routing)`,
			);
			if (descriptionTagResult.baseBranchOverrides.size > 0) {
				const overrideEntries = Array.from(
					descriptionTagResult.baseBranchOverrides.entries(),
				)
					.map(([id, branch]) => `${id}→${branch}`)
					.join(", ");
				this.logger.info(
					`Base branch overrides from description tags: ${overrideEntries}`,
				);
			}
			return {
				type: "selected",
				repositories: descriptionTagResult.repositories,
				baseBranchOverrides:
					descriptionTagResult.baseBranchOverrides.size > 0
						? descriptionTagResult.baseBranchOverrides
						: undefined,
				routingMethod: "description-tag",
			};
		}

		// Priority 2: Check routing labels
		const labelMatchedRepos = await this.findRepositoriesByLabels(
			issueId,
			workspaceRepos,
			workspaceId,
		);
		if (labelMatchedRepos.length > 0) {
			this.logger.info(
				`Repositories selected: [${labelMatchedRepos.map((r) => r.name).join(", ")}] (label-based routing)`,
			);
			return {
				type: "selected",
				repositories: labelMatchedRepos,
				routingMethod: "label-based",
			};
		}

		// Priority 3: Check project-based routing
		if (issueId) {
			const projectMatchedRepo = await this.findRepositoryByProject(
				issueId,
				workspaceRepos,
				workspaceId,
			);
			if (projectMatchedRepo) {
				this.logger.info(
					`Repository selected: ${projectMatchedRepo.name} (project-based routing)`,
				);
				return {
					type: "selected",
					repositories: [projectMatchedRepo],
					routingMethod: "project-based",
				};
			}
		}

		// Priority 4: Check team-based routing
		if (teamKey) {
			const teamMatchedRepo = this.findRepositoryByTeamKey(
				teamKey,
				workspaceRepos,
			);
			if (teamMatchedRepo) {
				this.logger.info(
					`Repository selected: ${teamMatchedRepo.name} (team-based routing)`,
				);
				return {
					type: "selected",
					repositories: [teamMatchedRepo],
					routingMethod: "team-based",
				};
			}
		}

		// Try parsing issue identifier as fallback for team routing
		// TODO: Remove team prefix routing - should rely on explicit team-based routing only
		if (issueIdentifier?.includes("-")) {
			const prefix = issueIdentifier.split("-")[0];
			if (prefix) {
				const repo = this.findRepositoryByTeamKey(prefix, workspaceRepos);
				if (repo) {
					this.logger.info(
						`Repository selected: ${repo.name} (team prefix routing)`,
					);
					return {
						type: "selected",
						repositories: [repo],
						routingMethod: "team-prefix",
					};
				}
			}
		}

		// Priority 5: Find catch-all repository (no routing configuration)
		// TODO: Remove catch-all routing - require explicit routing configuration for all repositories
		const catchAllRepo = workspaceRepos.find(
			(repo) =>
				(!repo.teamKeys || repo.teamKeys.length === 0) &&
				(!repo.routingLabels || repo.routingLabels.length === 0) &&
				(!repo.projectKeys || repo.projectKeys.length === 0),
		);

		if (catchAllRepo) {
			this.logger.info(
				`Repository selected: ${catchAllRepo.name} (workspace catch-all)`,
			);
			return {
				type: "selected",
				repositories: [catchAllRepo],
				routingMethod: "catch-all",
			};
		}

		// No routing match - request user selection (no default assignment)
		this.logger.info(
			`No routing match for ${workspaceRepos.length} workspace repositories - requesting user selection`,
		);
		return { type: "needs_selection", workspaceRepos };
	}

	/**
	 * Find all repositories matching routing labels
	 */
	private async findRepositoriesByLabels(
		issueId: string | undefined,
		repos: RepositoryConfig[],
		workspaceId: string,
	): Promise<RepositoryConfig[]> {
		if (!issueId) return [];

		const reposWithRoutingLabels = repos.filter(
			(repo) => repo.routingLabels && repo.routingLabels.length > 0,
		);

		if (reposWithRoutingLabels.length === 0) return [];

		try {
			const labels = await this.deps.fetchIssueLabels(issueId, workspaceId);

			const matched: RepositoryConfig[] = [];
			for (const repo of reposWithRoutingLabels) {
				if (
					repo.routingLabels?.some((routingLabel: string) =>
						labels.includes(routingLabel),
					)
				) {
					matched.push(repo);
				}
			}
			return matched;
		} catch (error) {
			this.logger.error(`Failed to fetch labels for routing:`, error);
		}

		return [];
	}

	/**
	 * Find all repositories matching description tags
	 *
	 * Parses the issue description for repo tags and matches against:
	 * - Repository GitHub URL (endsWith /repo-name)
	 * - Repository name
	 * - Repository ID
	 *
	 * Supported tag syntaxes:
	 * - [repo=my-repo-name] or [repo=my-repo-name#branch]
	 * - repo=frontend,backend#branch
	 * - repos=frontend,backend
	 */
	private async findRepositoriesByDescriptionTag(
		issueId: string | undefined,
		repos: RepositoryConfig[],
		workspaceId: string,
	): Promise<{
		repositories: RepositoryConfig[];
		baseBranchOverrides: Map<string, string>;
	}> {
		if (!issueId) return { repositories: [], baseBranchOverrides: new Map() };

		try {
			const description = await this.deps.fetchIssueDescription(
				issueId,
				workspaceId,
			);
			if (!description)
				return { repositories: [], baseBranchOverrides: new Map() };

			const repoTags = this.parseRepoTagsFromDescription(description);
			if (repoTags.length === 0)
				return { repositories: [], baseBranchOverrides: new Map() };

			this.logger.info(
				`Found repo tags in issue description: [${repoTags.map((t) => (t.branch ? `${t.repo}#${t.branch}` : t.repo)).join(", ")}]`,
			);

			const matched: RepositoryConfig[] = [];
			const matchedIds = new Set<string>();
			const baseBranchOverrides = new Map<string, string>();

			for (const repoTag of repoTags) {
				for (const repo of repos) {
					if (matchedIds.has(repo.id)) continue;

					let isMatch = false;

					// Match by GitHub URL path segment (e.g., "org/repo-name" or "repo-name")
					// Use endsWith to avoid substring false positives (e.g., "cyrus" matching "cyrus-hosted")
					if (
						repo.githubUrl?.endsWith(`/${repoTag.repo}`) ||
						repo.githubUrl?.endsWith(`/${repoTag.repo}.git`)
					) {
						this.logger.debug(
							`Matched repo tag "${repoTag.repo}" to repository ${repo.name} via hosting URL`,
						);
						isMatch = true;
					}

					// Match by repository name (exact match, case-insensitive)
					if (
						!isMatch &&
						repo.name.toLowerCase() === repoTag.repo.toLowerCase()
					) {
						this.logger.debug(
							`Matched repo tag "${repoTag.repo}" to repository ${repo.name} via name`,
						);
						isMatch = true;
					}

					// Match by repository ID
					if (!isMatch && repo.id === repoTag.repo) {
						this.logger.debug(
							`Matched repo tag "${repoTag.repo}" to repository ${repo.name} via ID`,
						);
						isMatch = true;
					}

					if (isMatch) {
						matched.push(repo);
						matchedIds.add(repo.id);
						if (repoTag.branch) {
							baseBranchOverrides.set(repo.id, repoTag.branch);
							this.logger.debug(
								`Base branch override for ${repo.name}: ${repoTag.branch}`,
							);
						}
					}
				}
			}

			if (matched.length === 0) {
				this.logger.debug(
					`No repositories matched [repo=...] tags: [${repoTags.map((t) => t.repo).join(", ")}]`,
				);
			}
			return { repositories: matched, baseBranchOverrides };
		} catch (error) {
			this.logger.error(`Failed to fetch description for routing:`, error);
		}

		return { repositories: [], baseBranchOverrides: new Map() };
	}

	/**
	 * Parse repo tags from issue description
	 *
	 * Supported syntaxes:
	 * - `[repo=name]` or `[repo=name#branch]` — bracketed, single repo per tag
	 * - `repo=name,name2#branch` — unbracketed, comma-separated repos with optional branch
	 * - `repos=name,name2#branch` — same as above with plural "repos"
	 *
	 * Also handles escaped brackets (\\[repo=...\\]) which Linear may produce.
	 *
	 * Returns array of parsed tags with optional branch overrides.
	 */
	parseRepoTagsFromDescription(
		description: string,
	): { repo: string; branch?: string }[] {
		const tags: { repo: string; branch?: string }[] = [];

		// Pattern 1: Bracketed [repo=...] (existing syntax)
		// Matches: [repo=name], [repo=name#branch], \[repo=name\]
		const bracketRegex = /\\?\[repo=([a-zA-Z0-9_\-/.#]+)\\?\]/g;
		for (const match of description.matchAll(bracketRegex)) {
			if (match[1]) {
				tags.push(...this.parseRepoValue(match[1]));
			}
		}

		// Pattern 2: Unbracketed repos?=... (new syntax)
		// Matches: repo=name, repos=name,name2, repo=name,name2#branch
		// Must be at start of line or after whitespace to avoid matching inside URLs/paths
		const unbracketedRegex = /(?:^|[\s\n])repos?=([a-zA-Z0-9_\-/.#,]+)/gm;
		for (const match of description.matchAll(unbracketedRegex)) {
			if (match[1]) {
				tags.push(...this.parseRepoValue(match[1]));
			}
		}

		// Deduplicate by repo name (keep first occurrence)
		const seen = new Set<string>();
		return tags.filter((tag) => {
			if (seen.has(tag.repo)) return false;
			seen.add(tag.repo);
			return true;
		});
	}

	/**
	 * Parse a repo value that may contain commas (multiple repos) and #branch.
	 * The #branch suffix applies to all repos in a comma-separated list.
	 */
	private parseRepoValue(value: string): { repo: string; branch?: string }[] {
		// Split branch from the end: everything after the last # that follows a repo name
		const hashIndex = value.indexOf("#");
		let reposPart: string;
		let branch: string | undefined;

		if (hashIndex !== -1) {
			reposPart = value.slice(0, hashIndex);
			branch = value.slice(hashIndex + 1);
			if (!branch) branch = undefined;
		} else {
			reposPart = value;
		}

		// Split comma-separated repos
		const repos = reposPart
			.split(",")
			.map((r) => r.trim())
			.filter((r) => r.length > 0);

		return repos.map((repo) => (branch ? { repo, branch } : { repo }));
	}

	/**
	 * Find repository by team key
	 */
	private findRepositoryByTeamKey(
		teamKey: string,
		repos: RepositoryConfig[],
	): RepositoryConfig | undefined {
		return repos.find((r) => r.teamKeys?.includes(teamKey));
	}

	/**
	 * Find repository by project name
	 */
	private async findRepositoryByProject(
		issueId: string,
		repos: RepositoryConfig[],
		workspaceId: string,
	): Promise<RepositoryConfig | null> {
		// Try each repository that has projectKeys configured
		for (const repo of repos) {
			if (!repo.projectKeys || repo.projectKeys.length === 0) continue;

			try {
				const issueTracker = this.deps.getIssueTracker(workspaceId);
				if (!issueTracker) {
					this.logger.warn(
						`No issue tracker found for workspace ${workspaceId}`,
					);
					continue;
				}

				const fullIssue = await issueTracker.fetchIssue(issueId);
				const project = await fullIssue?.project;
				if (!project?.name) {
					this.logger.debug(
						`No project name found for issue ${issueId} in repository ${repo.name}`,
					);
					continue;
				}

				const projectName = project.name;
				if (repo.projectKeys.includes(projectName)) {
					this.logger.debug(
						`Matched issue ${issueId} to repository ${repo.name} via project: ${projectName}`,
					);
					return repo;
				}
			} catch (error) {
				// Continue to next repository if this one fails
				this.logger.debug(
					`Failed to fetch project for issue ${issueId} from repository ${repo.name}:`,
					error,
				);
			}
		}

		return null;
	}

	/**
	 * Elicit user repository selection - post elicitation to Linear
	 */
	async elicitUserRepositorySelection(
		webhook: AgentSessionCreatedWebhook,
		workspaceRepos: RepositoryConfig[],
	): Promise<void> {
		const { agentSession } = webhook;
		const agentSessionId = agentSession.id;
		const { issue } = agentSession;

		if (!issue) {
			this.logger.error("Cannot elicit repository selection without issue");
			return;
		}

		this.logger.info(
			`Posting repository selection elicitation for issue ${issue.identifier}`,
		);

		// Store pending selection
		this.pendingSelections.set(agentSessionId, {
			issueId: issue.id,
			workspaceRepos,
		});

		// Validate we have repositories to offer
		const firstRepo = workspaceRepos[0];
		if (!firstRepo) {
			this.logger.error("No repositories available for selection elicitation");
			return;
		}

		// Get issue tracker for the workspace
		const issueTracker = this.deps.getIssueTracker(webhook.organizationId);
		if (!issueTracker) {
			this.logger.error(
				`No issue tracker found for workspace ${webhook.organizationId}`,
			);
			return;
		}

		// Create repository options
		const options = workspaceRepos.map((repo) => ({
			value: repo.githubUrl || repo.name,
		}));

		// Post elicitation activity through the single sink post path
		try {
			await new LinearActivitySink(issueTracker, webhook.organizationId).post(
				agentSessionId,
				{
					type: "elicitation",
					body: "Which repository should I work in for this issue?",
					signal: "select",
					signalMetadata: { options },
				},
			);

			this.logger.info(
				`Posted repository selection elicitation with ${options.length} options`,
			);
		} catch (error) {
			this.logger.error(
				`Failed to post repository selection elicitation:`,
				error,
			);

			await this.postRepositorySelectionError(
				agentSessionId,
				issueTracker,
				error,
			);

			this.pendingSelections.delete(agentSessionId);
		}
	}

	/**
	 * Post error activity when repository selection fails
	 */
	private async postRepositorySelectionError(
		agentSessionId: string,
		issueTracker: IIssueTrackerService,
		error: unknown,
	): Promise<void> {
		const errorObj = error as Error;
		const errorMessage = errorObj?.message || String(error);

		try {
			await new LinearActivitySink(issueTracker, "adhoc").post(agentSessionId, {
				type: "error",
				body: `Failed to display repository selection: ${errorMessage}`,
			});
			this.logger.info(
				`Posted error activity for repository selection failure`,
			);
		} catch (postError) {
			this.logger.error(
				`Failed to post error activity (may be due to same underlying issue):`,
				postError,
			);
		}
	}

	/**
	 * Select repository from user response
	 * Returns the selected repository or null if webhook should not be processed further
	 */
	async selectRepositoryFromResponse(
		agentSessionId: string,
		selectedRepositoryName: string,
	): Promise<RepositoryConfig | null> {
		const pendingData = this.pendingSelections.get(agentSessionId);
		if (!pendingData) {
			this.logger.debug(
				`No pending repository selection found for agent session ${agentSessionId}`,
			);
			return null;
		}

		// Remove from pending map
		this.pendingSelections.delete(agentSessionId);

		// Find selected repository by GitHub URL or name
		const selectedRepo = pendingData.workspaceRepos.find(
			(repo) =>
				repo.githubUrl === selectedRepositoryName ||
				repo.name === selectedRepositoryName,
		);

		// Fallback to first repository if not found
		const repository = selectedRepo || pendingData.workspaceRepos[0];
		if (!repository) {
			this.logger.error(
				`No repository found for selection: ${selectedRepositoryName}`,
			);
			return null;
		}

		if (!selectedRepo) {
			this.logger.info(
				`Repository "${selectedRepositoryName}" not found, falling back to ${repository.name}`,
			);
		} else {
			this.logger.info(`User selected repository: ${repository.name}`);
		}

		return repository;
	}

	/**
	 * Check if there's a pending repository selection for this agent session
	 */
	hasPendingSelection(agentSessionId: string): boolean {
		return this.pendingSelections.has(agentSessionId);
	}

	/**
	 * Extract issue information from webhook
	 */
	private extractIssueInfo(webhook: Webhook): {
		issueId?: string;
		teamKey?: string;
		issueIdentifier?: string;
	} {
		// Handle agent session webhooks
		if (
			this.isAgentSessionCreatedWebhook(webhook) ||
			this.isAgentSessionPromptedWebhook(webhook)
		) {
			return {
				issueId: webhook.agentSession?.issue?.id,
				teamKey: webhook.agentSession?.issue?.team?.key,
				issueIdentifier: webhook.agentSession?.issue?.identifier,
			};
		}

		// Handle entity webhooks (e.g., Issue updates)
		if (this.isEntityWebhook(webhook)) {
			// For Issue entity webhooks, data contains the issue payload
			if (webhook.type === "Issue") {
				const issueData = webhook.data as {
					id?: string;
					identifier?: string;
					team?: { key?: string };
				};
				return {
					issueId: issueData?.id,
					teamKey: issueData?.team?.key,
					issueIdentifier: issueData?.identifier,
				};
			}
			// Other entity types don't have issue info
			return {};
		}

		// Handle notification webhooks (AppUserNotification)
		if ("notification" in webhook && webhook.notification) {
			return {
				issueId: webhook.notification?.issue?.id,
				teamKey: webhook.notification?.issue?.team?.key,
				issueIdentifier: webhook.notification?.issue?.identifier,
			};
		}

		return {};
	}

	/**
	 * Type guard for entity webhooks (Issue, Comment, etc.)
	 */
	private isEntityWebhook(
		webhook: Webhook,
	): webhook is Webhook & { data: unknown } {
		return "data" in webhook && webhook.data !== undefined;
	}

	/**
	 * Type guards
	 */
	private isAgentSessionCreatedWebhook(
		webhook: Webhook,
	): webhook is AgentSessionCreatedWebhook {
		return webhook.action === "created";
	}

	private isAgentSessionPromptedWebhook(
		webhook: Webhook,
	): webhook is AgentSessionPromptedWebhook {
		return webhook.action === "prompted";
	}

	/**
	 * Get issue repository cache for serialization
	 */
	getIssueRepositoryCache(): Map<string, string[]> {
		return this.issueRepositoryCache;
	}

	/**
	 * Restore issue repository cache from serialization.
	 * Handles migration from old format (Map<string, string>) by wrapping values in arrays.
	 */
	restoreIssueRepositoryCache(cache: Map<string, string | string[]>): void {
		this.issueRepositoryCache = new Map();
		for (const [issueId, value] of cache.entries()) {
			if (Array.isArray(value)) {
				this.issueRepositoryCache.set(issueId, value);
			} else {
				// Migration: wrap old single-string format in array
				this.issueRepositoryCache.set(issueId, [value]);
			}
		}
	}
}
