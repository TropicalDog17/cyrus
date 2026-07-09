import type { Activity, ActivityPostResult } from "../activity/Activity.js";
import type { IActivitySink } from "./IActivitySink.js";

/**
 * A no-op activity sink that silently discards all activities.
 * Used for platforms like Slack where activities are not posted to an external tracker.
 */
export class NoopActivitySink implements IActivitySink {
	readonly id: string;

	constructor(id = "noop") {
		this.id = id;
	}

	async post(
		_sessionId: string,
		_activity: Activity,
	): Promise<ActivityPostResult> {
		return {};
	}

	async createAgentSession(_issueId: string): Promise<string> {
		return "";
	}
}
