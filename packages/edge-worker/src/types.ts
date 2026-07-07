import type { SDKMessage } from "cyrus-claude-runner";
import type { CyrusAgentSession, Issue, Workspace } from "cyrus-core";

/**
 * Events emitted by EdgeWorker
 */
export interface EdgeWorkerEvents {
	// Connection events (now includes token to identify which connection)
	connected: (token: string) => void;
	disconnected: (token: string, reason?: string) => void;

	// Session events (now includes repository ID)
	"session:started": (
		issueId: string,
		issue: Issue,
		repositoryId: string,
	) => void;
	"session:ended": (
		issueId: string,
		exitCode: number | null,
		repositoryId: string,
	) => void;

	// Claude messages (now includes repository ID)
	"claude:message": (
		issueId: string,
		message: SDKMessage,
		repositoryId: string,
	) => void;
	"claude:response": (
		issueId: string,
		text: string,
		repositoryId: string,
	) => void;
	"claude:tool-use": (
		issueId: string,
		tool: string,
		input: any,
		repositoryId: string,
	) => void;

	// Error events
	error: (error: Error, context?: any) => void;

	// --- Compounding-loop events (consumed by the cyrus-loop adapter, Lane C) ---
	// A Cyrus-authored PR/MR was opened or updated (fired from the PR-marker hook).
	prOpened: (payload: PrOpenedEventPayload) => void;
	// An agent session reached a terminal state (fired from AgentSessionManager).
	sessionComplete: (payload: SessionCompleteEventPayload) => void;
	// A human diff-gate verdict was recorded for a run (fired by the loop adapter).
	verdictReached: (payload: VerdictReachedEventPayload) => void;
}

/**
 * Payload for {@link EdgeWorkerEvents.prOpened}. Carries the PR facts the loop needs to derive a
 * run_id (`headBranch` + `prCreatedAt` + `prNumber`) and capture a diff (`repoDir` + `baseBranch`),
 * plus the originating session context. Deliberately plain (no cyrus-loop import) — the loop
 * adapter maps this onto cyrus-loop's own `PrOpenedPayload`.
 */
export interface PrOpenedEventPayload {
	/** Forge that owns the PR/MR — `"github"` | `"gitlab"`. The loop acts on GitHub only. */
	provider: string;
	issueId: string;
	/** Human issue identifier, e.g. `DEV-123`. */
	issueIdentifier?: string;
	repositoryId: string;
	/** Cyrus repo `name` (the loop's `repoName`). */
	repositoryName: string;
	/** Absolute path to the repo's primary checkout (`repository.repositoryPath`). */
	repoDir: string;
	/** The session's worktree path. */
	worktree: string;
	prNumber: number;
	/** PR head branch (`headRefName`). */
	headBranch: string;
	/** PR head commit SHA (`headRefOid`). */
	headSha?: string;
	/** PR base branch (`baseRefName`). */
	baseBranch?: string;
	/** ISO-8601 PR creation timestamp — required for the run_id; absent ⇒ the loop skips. */
	prCreatedAt?: string;
	prUrl?: string;
}

/** Payload for {@link EdgeWorkerEvents.sessionComplete}. */
export interface SessionCompleteEventPayload {
	issueId: string;
	issueIdentifier?: string;
	repositoryId: string;
	repositoryName: string;
	worktree: string;
	/** Resolved terminal status of the session (e.g. `complete`, `error`). */
	status: string;
	prNumber?: number;
}

/** Payload for {@link EdgeWorkerEvents.verdictReached}. */
export interface VerdictReachedEventPayload {
	runId: string;
	verdict: string;
}

/**
 * Input to a loop verdict interceptor. EdgeWorker consults it on each user prompt (before starting
 * a session) so the loop can divert a diff-gate verdict (`/approve` etc.) to itself. The
 * interceptor returns `true` when it consumed the prompt (⇒ EdgeWorker starts NO session).
 */
export interface LoopVerdictInput {
	/** Internal issue id (`agentSession.issue.id`). */
	issueId: string;
	/** The raw prompt text. */
	text: string;
	agentSessionId: string;
}

/**
 * Data returned from createAgentSession
 */
export interface AgentSessionData {
	session: CyrusAgentSession;
	fullIssue: Issue;
	workspace: Workspace;
	attachmentResult: { manifest: string; attachmentsDir: string | null };
	attachmentsDir: string;
	allowedDirectories: string[];
	allowedTools: string[];
	disallowedTools: string[];
}
