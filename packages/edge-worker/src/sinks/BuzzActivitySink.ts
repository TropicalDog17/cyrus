import type { ILogger } from "cyrus-core";
import type { Activity, ActivityPostResult } from "../activity/Activity.js";
import type { BuzzCliClient } from "../buzz/BuzzCliClient.js";
import type { IActivitySink } from "./IActivitySink.js";

/**
 * Posts agent activity back into the Buzz thread that started the session.
 *
 * Two deliberate departures from {@link LinearActivitySink}:
 *
 * 1. **Only conversational activity is posted.** Linear renders `thought` and
 *    `action` entries in a collapsible agent-session timeline; a Buzz thread is
 *    a chat log read by humans, where a running commentary of every tool call
 *    is noise that buries the answer. Thoughts and actions are dropped, and so
 *    are ephemeral activities — "replaced by the next activity" has no meaning
 *    in an append-only Nostr thread.
 * 2. **Failures never propagate.** Buzz egress is a side effect of a session,
 *    not a precondition for it; a relay hiccup must not abort a run that is
 *    already writing code. Errors are logged and swallowed, matching how the
 *    manager's own `postToSink` treats a throwing sink.
 *
 * `sessionId` here is the Buzz thread root event id, which the session sets as
 * its `externalSessionId`.
 */
export class BuzzActivitySink implements IActivitySink {
	readonly id: string;
	private readonly client: BuzzCliClient;
	private readonly channelId: string;
	private readonly logger: ILogger;
	private readonly onResponse?: (threadRootId: string, body: string) => void;

	constructor(
		client: BuzzCliClient,
		channelId: string,
		logger: ILogger,
		/**
		 * Notified for each `response` posted. The Linear projection uses the last
		 * one as a session's summary; observing it here is cheaper than
		 * re-reading the thread back off the relay afterwards.
		 */
		onResponse?: (threadRootId: string, body: string) => void,
	) {
		this.client = client;
		this.channelId = channelId;
		this.id = `buzz:${channelId}`;
		this.logger = logger;
		this.onResponse = onResponse;
	}

	async post(
		sessionId: string,
		activity: Activity,
	): Promise<ActivityPostResult> {
		const body = this.renderBody(activity);
		if (!body) {
			return {};
		}

		if (activity.type === "response") {
			this.onResponse?.(sessionId, body);
		}

		try {
			const eventId = await this.client.sendMessage({
				channelId: this.channelId,
				content: body,
				replyTo: sessionId,
			});
			return eventId ? { activityId: eventId } : {};
		} catch (error) {
			this.logger.error(
				`Failed to post ${activity.type} to Buzz thread ${sessionId}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return {};
		}
	}

	/**
	 * Buzz threads are created by humans talking, never by Cyrus. Nothing calls
	 * this today; failing loudly beats inventing a thread id that would silently
	 * route replies into the void.
	 */
	async createAgentSession(issueId: string): Promise<string> {
		throw new Error(
			`BuzzActivitySink cannot create a session for ${issueId}: Buzz sessions originate from an existing chat thread`,
		);
	}

	/** Render an activity as thread-reply text, or null to skip posting it. */
	private renderBody(activity: Activity): string | null {
		if (activity.ephemeral) {
			return null;
		}

		switch (activity.type) {
			case "response":
			case "elicitation":
				return activity.body.trim() || null;
			case "error":
				return `⚠️ ${activity.body.trim()}`;
			default:
				return null;
		}
	}
}
