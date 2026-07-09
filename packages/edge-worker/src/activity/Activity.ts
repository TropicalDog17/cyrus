/**
 * Neutral, tracker-agnostic Activity value produced by {@link ActivityMapper}
 * and consumed by {@link IActivitySink}.
 *
 * Replaces the previous coupling of a Linear-typed `AgentActivityContent`
 * (aliased to `LinearSDK.LinearDocument.AgentActivityContent`) plus a separate
 * `ActivityPostOptions` at the sink seam. The content field names
 * (`type`/`body`/`action`/`parameter`/`result`) are identical to what the old
 * per-tool switch produced, so existing timeline assertions survive unchanged;
 * the ephemeral/signal modifiers the mapper decides per activity type are
 * carried inline.
 */

/**
 * String-literal activity signal. Maps to a platform-specific signal enum
 * (e.g. Linear's `AgentActivitySignal`) inside the sink adapter.
 */
export type ActivitySignal = "auth" | "select" | "stop" | "continue";

/** Ephemeral / signal modifiers a mapper (or caller) decides per activity. */
export interface ActivityModifiers {
	/** Whether the activity is ephemeral (replaced by the next activity). */
	ephemeral?: boolean;
	/** Signal modifier for how the activity should be interpreted. */
	signal?: ActivitySignal;
	/** Additional metadata for the signal (e.g. auth url, select options). */
	signalMetadata?: Record<string, unknown>;
}

/** The neutral activity content the mapper emits and the sink posts. */
export type Activity = (
	| { type: "thought"; body: string }
	| { type: "action"; action: string; parameter?: string; result?: string }
	| { type: "response"; body: string }
	| { type: "error"; body: string }
	| { type: "elicitation"; body: string }
) &
	ActivityModifiers;

/** Result of posting an activity through a sink. */
export interface ActivityPostResult {
	/** The ID of the created activity, if available. */
	activityId?: string;
}
