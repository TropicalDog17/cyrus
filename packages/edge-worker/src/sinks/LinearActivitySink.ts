import {
	type AgentActivityContent,
	AgentActivitySignal,
	type IIssueTrackerService,
} from "cyrus-core";
import type { Activity, ActivitySignal } from "../activity/Activity.js";
import type { ActivityPostResult, IActivitySink } from "./IActivitySink.js";

/**
 * Linear-specific implementation of IActivitySink.
 *
 * LinearActivitySink wraps an IIssueTrackerService instance to provide activity
 * sink functionality for Linear workspaces. It delegates activity posting and
 * session creation to the underlying issue tracker service.
 *
 * @example
 * ```typescript
 * const sink = new LinearActivitySink(issueTracker, 'workspace-123');
 * const sessionId = await sink.createAgentSession('issue-id-456');
 * await sink.post(sessionId, { type: 'thought', body: 'Analyzing the issue...' });
 * ```
 */
export class LinearActivitySink implements IActivitySink {
	/**
	 * Unique identifier for this sink (Linear workspace ID).
	 */
	public readonly id: string;

	private readonly issueTracker: IIssueTrackerService;

	/**
	 * Create a new LinearActivitySink.
	 *
	 * @param issueTracker - The IIssueTrackerService instance to delegate to
	 * @param workspaceId - The Linear workspace ID (used as sink ID)
	 */
	constructor(issueTracker: IIssueTrackerService, workspaceId: string) {
		this.issueTracker = issueTracker;
		this.id = workspaceId;
	}

	/**
	 * Map a platform-agnostic ActivitySignal string to Linear's AgentActivitySignal enum.
	 */
	private mapSignal(signal: ActivitySignal): AgentActivitySignal {
		switch (signal) {
			case "auth":
				return AgentActivitySignal.Auth;
			case "select":
				return AgentActivitySignal.Select;
			case "stop":
				return AgentActivitySignal.Stop;
			case "continue":
				return AgentActivitySignal.Continue;
		}
	}

	/**
	 * Post an activity to an existing agent session.
	 *
	 * Splits the ephemeral/signal/signalMetadata modifiers off the neutral
	 * {@link Activity} and forwards the remaining content
	 * (type/body/action/parameter/result) to
	 * `IIssueTrackerService.createAgentActivity()`.
	 *
	 * @param sessionId - The agent session ID to post to
	 * @param activity - The neutral activity with modifiers carried inline
	 * @returns Promise that resolves with the activity post result
	 */
	async post(
		sessionId: string,
		activity: Activity,
	): Promise<ActivityPostResult> {
		const { ephemeral, signal, signalMetadata, ...content } = activity;

		const result = await this.issueTracker.createAgentActivity({
			agentSessionId: sessionId,
			content: content as AgentActivityContent,
			...(ephemeral !== undefined && { ephemeral }),
			...(signal && { signal: this.mapSignal(signal) }),
			...(signalMetadata && { signalMetadata }),
		});

		if (result.success && result.agentActivity) {
			const agentActivity = await result.agentActivity;
			return { activityId: agentActivity.id };
		}

		return {};
	}

	/**
	 * Create a new agent session on an issue.
	 *
	 * @param issueId - The issue ID to attach the session to
	 * @returns Promise that resolves with the created session ID
	 */
	async createAgentSession(issueId: string): Promise<string> {
		const result = await this.issueTracker.createAgentSessionOnIssue({
			issueId,
		});

		if (!result.success) {
			throw new Error(
				`Failed to create agent session for issue ${issueId}: request was not successful`,
			);
		}

		// Extract session ID from the result
		// Result has `agentSession` property that may be a Promise
		const session = await result.agentSession;
		if (!session) {
			throw new Error(
				`Failed to create agent session for issue ${issueId}: session is undefined`,
			);
		}
		return session.id;
	}
}
