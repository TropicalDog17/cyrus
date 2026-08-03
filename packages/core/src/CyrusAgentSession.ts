/**
 * Agent Session types for Linear Agent Sessions integration
 * These types represent the core data structures for tracking agent sessions in Linear
 */

import type {
	AgentUsage,
	IAgentRunner,
	SDKAssistantMessageError,
} from "./agent-runner-types.js";
import type {
	AgentSessionStatus,
	AgentSessionType,
} from "./issue-tracker/types.js";

export interface IssueMinimal {
	id: string;
	identifier: string;
	title: string;
	description?: string;
	branchName: string;
}

/**
 * Issue context for sessions attached to a specific issue.
 * Standalone sessions (e.g., direct agent invocation without an issue) will not have this.
 */
export interface IssueContext {
	/** The issue tracker identifier (e.g., "linear", "github") */
	trackerId: string;
	/** The unique issue ID from the tracker */
	issueId: string;
	/** The human-readable issue identifier (e.g., "CYPACK-123") */
	issueIdentifier: string;
}

/** Result of base branch resolution, including the source for reporting */
export interface BaseBranchResolution {
	/** The resolved base branch name */
	branch: string;
	/** Why this branch was selected */
	source: "commit-ish" | "graphite-blocked-by" | "parent-issue" | "default";
	/** Human-readable detail (e.g., blocking issue identifier) */
	detail?: string;
}

export interface Workspace {
	path: string;
	isGitWorktree: boolean;
	historyPath?: string;
	/** Maps repositoryId to worktree path for multi-repo workspaces */
	repoPaths?: Record<string, string>;
	/** Maps repositoryId to resolved base branch with source info */
	resolvedBaseBranches?: Record<string, BaseBranchResolution>;
}

/**
 * Lightweight repository context carried by each session.
 * Identifies which repository (and branches) the session operates on.
 * 0 entries = chatbot/no-repo session, 1 = single-repo, N = multi-repo.
 */
export interface RepositoryContext {
	/** The repository config ID (matches RepositoryConfig.id) */
	repositoryId: string;
	/** The git branch the session works on (e.g., derived from issue identifier) */
	branchName?: string;
	/** The base branch for PRs (e.g., "main" or a Graphite parent branch) */
	baseBranchName?: string;
}
export type AssignmentLeaseState =
	| "working"
	| "awaiting_pr"
	| "awaiting_gate"
	| "remediating"
	| "needs_input"
	| "escalated"
	| "merged";

export interface AssignmentLeaseCandidate {
	repositoryId: string;
	prNumber: number;
	runId: string;
	headSha: string;
}

export interface NeedsInputFact {
	type: "needs_input";
	at: string;
	reason: string;
}

export interface EscalationFact {
	type: "escalated";
	at: string;
	reason: string;
}

export interface MergeFact {
	type: "merged";
	at: string;
	candidate: AssignmentLeaseCandidate;
}

export interface AssignmentLease {
	generation: number;
	state: AssignmentLeaseState;
	acquiredAt: string;
	updatedAt: string;
	candidate?: AssignmentLeaseCandidate;
	gateActivityId?: string;
	releasedAt?: string;
	releaseFact?: NeedsInputFact | EscalationFact | MergeFact;
}

export interface CyrusAgentSession {
	/** Unique session identifier (was linearAgentActivitySessionId in v2.0) */
	id: string;
	/** External session ID from the issue tracker (e.g., Linear's AgentSession ID) */
	externalSessionId?: string;
	type: AgentSessionType.CommentThread;
	status: AgentSessionStatus;
	context: AgentSessionType.CommentThread;
	createdAt: number; // e.g. Date.now()
	updatedAt: number; // e.g. Date.now()
	/** Issue context - optional for standalone sessions */
	issueContext?: IssueContext;
	/**
	 * Issue ID - kept for backwards compatibility during transition
	 * @deprecated Use issueContext.issueId instead
	 */
	issueId?: string;
	/** Minimal issue data - optional for standalone sessions */
	issue?: IssueMinimal;
	/** Repository contexts for this session (always array, never undefined) */
	repositories: RepositoryContext[];
	workspace: Workspace;
	/**
	 * Stable Cyrus identity of the agent profile that created this session
	 * (e.g. `claude`, `cursor`, `codex`, `omp`). Resolves the launch
	 * configuration that can resume `runnerSessionId`; the protocol is derived
	 * from the profile rather than duplicated here. Legacy provider-specific
	 * session ID fields (`claudeSessionId` etc.) were migrated into this pair
	 * at persistence v6 and exist only on the v5 migration input type.
	 */
	agentProfileId?: string;
	/** Opaque runner-assigned conversation identifier, meaningful only when
	 * paired with {@link agentProfileId}. */
	runnerSessionId?: string;
	/** Durable lifecycle state for deterministic OMP assignment closure. */
	assignmentLease?: AssignmentLease;
	agentRunner?: IAgentRunner;
	metadata?: {
		model?: string;
		tools?: string[];
		permissionMode?: string;
		apiKeySource?: string;
		/** Cost of the most recent turn's `result` (raw last-`result` value). */
		totalCostUsd?: number;
		/** Usage from the most recent turn's `result` (raw last-`result` value). */
		usage?: AgentUsage;
		/**
		 * Accumulated usage across every turn of this session. Built by summing
		 * per-turn deltas, since `result.usage` is cumulative-per-process — see
		 * `agent-docs/dev-gotchas.md`.
		 */
		cumulativeUsage?: AgentUsage;
		/** Number of completed turns (result messages) accumulated so far. */
		turnCount?: number;
		commentId?: string;
	};
}

export interface CyrusAgentSessionEntry {
	/** Profile that produced this entry (may be absent on pre-v6 records). */
	agentProfileId?: string;
	/** Runner session id of the session that produced this entry. */
	runnerSessionId?: string;
	linearAgentActivityId?: string; // got assigned this ID in linear, after creation, for this 'agent activity'
	type: "user" | "assistant" | "system" | "result";
	content: string;
	metadata?: {
		toolUseId?: string;
		toolName?: string;
		toolInput?: any;
		parentToolUseId?: string;
		toolResultError?: boolean; // Error status from tool_result blocks
		timestamp: number; // e.g. Date.now()
		durationMs?: number;
		isError?: boolean;
		sdkError?: SDKAssistantMessageError; // SDK error type (e.g., 'rate_limit') from assistant messages
	};
}
