import type {
	Activity,
	ActivityPostResult,
	ActivitySignal,
} from "../activity/Activity.js";

// Re-export the neutral activity signal/result types from their canonical home
// (the activity module) so existing importers of `./sinks` keep working.
export type { Activity, ActivityPostResult, ActivitySignal };

/**
 * Interface for activity sinks that receive and process agent session activities.
 *
 * IActivitySink decouples activity posting from IIssueTrackerService, enabling
 * multiple activity sinks (Linear workspaces, GitHub, etc.) to receive session
 * activities based on session context.
 *
 * This is the single funnel every activity-post path collapses onto: the
 * ephemeral/signal/signalMetadata modifiers ride inline on the neutral
 * {@link Activity} rather than a separate options bag.
 *
 * Implementations should:
 * - Provide a unique identifier (workspace ID, org ID, etc.)
 * - Support posting activities to agent sessions
 * - Support creating new agent sessions on issues
 */
export interface IActivitySink {
	/**
	 * Unique identifier for this sink (e.g., Linear workspace ID, GitHub org ID).
	 * Used to route activities to the correct sink.
	 */
	readonly id: string;

	/**
	 * Post an activity to an existing agent session.
	 *
	 * @param sessionId - The agent session ID to post to
	 * @param activity - The neutral activity (thought/action/response/error/
	 *   elicitation) with any ephemeral/signal modifiers carried inline
	 * @returns Promise that resolves with the result of the activity post
	 */
	post(sessionId: string, activity: Activity): Promise<ActivityPostResult>;

	/**
	 * Create a new agent session on an issue.
	 *
	 * @param issueId - The issue ID to attach the session to
	 * @returns Promise that resolves with the created session ID
	 */
	createAgentSession(issueId: string): Promise<string>;
}
