/**
 * Type definitions for the unified prompt assembly system
 *
 * This module provides a clear, testable interface for assembling prompts
 * with well-defined inputs and outputs.
 */

import type {
	BaseBranchResolution,
	CyrusAgentSession,
	GuidanceRule,
	Issue,
	RepositoryConfig,
	WebhookAgentSession,
} from "cyrus-core";

/**
 * Output structure from buildPrompt - contains everything needed to start a Claude session
 */
export interface PromptAssemblyResult {
	/** System prompt for Claude runner configuration (e.g., "builder", "debugger") */
	systemPrompt?: string;

	/** The complete user prompt to send to Claude */
	userPrompt: string;

	/** Metadata about what was assembled (for debugging and testing) */
	metadata: {
		/** List of components included in the prompt */
		components: PromptComponent[];

		/** Type of prompt builder used */
		promptType: PromptType;

		/** Whether this was a new session */
		isNewSession: boolean;

		/** Whether the session is actively streaming */
		isStreaming: boolean;
	};
}

/**
 * Components that can be included in a prompt
 */
export type PromptComponent =
	| "issue-context" // Issue title, description, comments, history
	| "session-summary" // Haiku summary of a prior over-threshold session (cold-resume restart)
	| "user-comment" // User's comment text
	| "attachment-manifest" // List of attachments
	| "guidance-rules"; // Linear agent guidance rules

/**
 * Type of prompt builder used
 */
export type PromptType =
	| "label-based" // System prompt from labels (builder/debugger/etc)
	| "label-based-prompt-command" // /label-based-prompt command
	| "mention" // @mention triggered
	| "fallback" // Default issue context
	| "continuation"; // Existing session continuation

/**
 * Input structure for buildPrompt - all information needed to assemble a prompt
 */
export interface PromptAssemblyInput {
	// ===== Session Context =====
	/** The Cyrus agent session */
	session: CyrusAgentSession;

	/** Full issue details */
	fullIssue: Issue;

	/** Repository configurations (all repos in the session) */
	repositories: RepositoryConfig[];

	/**
	 * @deprecated Use `repositories` instead. Alias for `repositories[0]`.
	 */
	repository: RepositoryConfig;

	// ===== Prompt Content =====
	/** User's comment text (or empty string for initial assignment) */
	userComment: string;

	/** Author of the comment (for multi-player context) */
	commentAuthor?: string;

	/** Timestamp of the comment (for multi-player context) */
	commentTimestamp?: string;

	/** Attachment manifest string (if any attachments) */
	attachmentManifest?: string;

	/**
	 * Haiku-generated summary of a prior session whose transcript exceeded the
	 * cold-resume threshold. When present on a new-session prompt, a
	 * `<previous_session_summary>` block is inserted so the fresh session can
	 * pick up where the summarized session left off. See
	 * `EdgeWorker.resumeAgentSession` cold-resume-summarize path.
	 */
	previousSessionSummary?: string;

	/** Linear agent guidance rules */
	guidance?: GuidanceRule[];

	// ===== Control Flags =====
	/** Whether this is a new session (vs continuation) */
	isNewSession: boolean;

	/** Whether the Claude runner is actively streaming */
	isStreaming: boolean;

	/** Whether triggered by @mention */
	isMentionTriggered?: boolean;

	/** Whether /label-based-prompt command was used */
	isLabelBasedPromptRequested?: boolean;

	/** Agent session data (for mention-triggered prompts) */
	agentSession?: WebhookAgentSession;

	/** Labels on the issue (for system prompt determination) */
	labels?: string[];

	/** GitHub username of the issue assignee (resolved from Linear gitHubUserId) */
	assigneeGitHubUsername?: string;

	/** Pre-resolved base branches from workspace creation (keyed by repositoryId) */
	resolvedBaseBranches?: Record<string, BaseBranchResolution>;

	/** Linear workspace ID (from webhook.organizationId). When provided, avoids extracting from repo config. */
	linearWorkspaceId?: string;
}

/**
 * Result from building issue context (intermediate step)
 */
export interface IssueContextResult {
	/** The assembled issue context prompt */
	prompt: string;

	/** Template version (if using versioned templates) */
	version?: string;
}

/**
 * Input for building a system prompt for a GitHub PR comment session.
 */
export interface GitHubSystemPromptInput {
	repoFullName: string;
	prNumber: number | null;
	prTitle: string | null;
	commentAuthor: string;
	commentUrl: string;
	branchRef: string;
	taskInstructions: string;
}

/**
 * Input for building a system prompt for a GitHub PR change request review session.
 */
export interface GitHubChangeRequestSystemPromptInput {
	repoFullName: string;
	prNumber: number | null;
	prTitle: string | null;
	commentAuthor: string;
	commentUrl: string;
	branchRef: string;
	reviewBody: string;
}

/**
 * Input for the turn a Buzz thread runs when someone responds on a pull request
 * opened from one of its branches.
 */
export interface BuzzPullRequestPromptInput {
	/**
	 * What arrived. A `pull_request_review` is change-request feedback and ends
	 * in a commit; an `issue_comment` that @mentions Cyrus is usually a question,
	 * and answering it with "commit and push" would be a fabrication. The two
	 * also differ in where the answer has to go — see the prompt.
	 */
	kind: "review" | "comment";
	repoFullName: string;
	prNumber: number | null;
	prTitle: string | null;
	commentAuthor: string;
	commentUrl: string;
	branchRef: string;
	/** The review body, or the comment text with the mention already stripped. */
	body: string;
}
