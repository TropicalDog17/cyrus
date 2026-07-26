import type { BuzzWebhookEvent } from "cyrus-buzz-event-transport";
import type { ILogger } from "cyrus-core";
import type { BuzzApprovalRegistry } from "./BuzzApprovalRegistry.js";
import type { BuzzCliClient, BuzzEventRecord } from "./BuzzCliClient.js";

export interface BuzzPollingSourceDeps {
	logger: ILogger;
	client: BuzzCliClient;
	/** Channels to watch. Read at each tick so config reload takes effect. */
	getChannelIds(): string[];
	/** Pubkeys whose activity Cyrus acts on. Empty denies everyone. */
	getAllowedPubkeys(): readonly string[];
	/** Open prompts, so reactions are only fetched for events that want them. */
	approvals: BuzzApprovalRegistry;
	/** Cyrus's own pubkey, so it never reacts to or answers itself. */
	getSelfPubkey(): string | undefined;
	onEvent(event: BuzzWebhookEvent): void;
	intervalMs: number;
}

/** Poll no faster than this — each tick is one relay round trip per channel. */
const MIN_INTERVAL_MS = 2_000;

/**
 * How far back the first tick looks. Long enough that a restart mid-conversation
 * does not silently drop the message that was in flight, short enough that
 * starting Cyrus does not replay a day of backlog as new sessions.
 */
const INITIAL_LOOKBACK_SECONDS = 120;

/**
 * Pulls Buzz activity by polling the relay instead of receiving webhooks.
 *
 * WHY THIS EXISTS ALONGSIDE {@link BuzzEventTransport}
 * ---------------------------------------------------
 * buzz-workflow's `call_webhook` action runs an SSRF check
 * (`buzz_core::network::is_private_ip`) that rejects, among others, CGNAT
 * `100.64.0.0/10` — the range every Tailscale address falls in. A relay that
 * reaches Cyrus only over a tailnet therefore *cannot* drive the webhook
 * transport, and no amount of configuration fixes it: the check runs on the
 * resolved address, and redirects are disabled.
 *
 * Polling has the further property that it needs no inbound exposure at all,
 * which is the point of a tailnet-only deployment. The webhook transport stays
 * because it is the lower-latency path wherever Cyrus does have a public
 * hostname; `buzz.ingress` picks one.
 *
 * Both paths emit the same {@link BuzzWebhookEvent}, so everything downstream —
 * dedupe, routing, the gate — is identical regardless of how the event arrived.
 */
export class BuzzPollingSource {
	private readonly deps: BuzzPollingSourceDeps;
	private readonly intervalMs: number;
	/** Per-channel high-water mark (unix seconds) for the `--since` filter. */
	private readonly since = new Map<string, number>();
	/** Reactions already dispatched, as `<eventId>:<emoji>:<pubkey>`. */
	private readonly seenReactions = new Set<string>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private ticking = false;

	constructor(deps: BuzzPollingSourceDeps) {
		this.deps = deps;
		this.intervalMs = Math.max(MIN_INTERVAL_MS, deps.intervalMs);
	}

	start(): void {
		if (this.timer) return;

		const startFrom = Math.floor(Date.now() / 1000) - INITIAL_LOOKBACK_SECONDS;
		for (const channelId of this.deps.getChannelIds()) {
			this.since.set(channelId, startFrom);
		}

		this.timer = setInterval(() => {
			void this.tick();
		}, this.intervalMs);
		this.timer.unref?.();

		this.deps.logger.info(
			`Buzz polling ingress started (every ${this.intervalMs}ms, ${this.deps.getChannelIds().length} channel(s))`,
		);
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	/**
	 * One poll cycle. Exposed for tests, which drive it directly rather than
	 * waiting on a timer.
	 *
	 * Ticks never overlap: a slow relay must not stack up concurrent cycles that
	 * would each re-read the same window and double-dispatch it.
	 */
	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			await this.pollMessages();
			await this.pollReactions();
		} catch (error) {
			this.deps.logger.error(
				"Buzz poll cycle failed",
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.ticking = false;
		}
	}

	private async pollMessages(): Promise<void> {
		const fallbackSince =
			Math.floor(Date.now() / 1000) - INITIAL_LOOKBACK_SECONDS;

		for (const channelId of this.deps.getChannelIds()) {
			const since = this.since.get(channelId) ?? fallbackSince;

			let messages: BuzzEventRecord[];
			try {
				messages = await this.deps.client.getMessages({ channelId, since });
			} catch (error) {
				this.deps.logger.warn(
					`Failed to poll Buzz channel ${channelId}: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}

			for (const message of messages) {
				// Advance the mark even for messages that are filtered out below,
				// so a channel full of chatter from unlisted pubkeys does not make
				// every tick re-read the same window forever.
				this.since.set(
					channelId,
					Math.max(this.since.get(channelId) ?? since, message.created_at),
				);

				if (!this.isActionable(message.pubkey)) continue;

				this.deps.onEvent({
					eventType: "message_posted",
					messageId: message.id,
					channelId,
					authorPubkey: message.pubkey,
					timestamp: String(message.created_at),
					deliveryId: `message_posted:${message.id}:`,
				});
			}
		}
	}

	/**
	 * Check reactions only on events that something is waiting for.
	 *
	 * buzz-cli has no "reactions since" query — `reactions get` returns the whole
	 * current set for one event — so an unbounded reaction poll would be one
	 * relay round trip per message ever posted. Scoping it to open prompts keeps
	 * the cost proportional to how many humans Cyrus is currently waiting on.
	 */
	private async pollReactions(): Promise<void> {
		for (const eventId of this.deps.approvals.pendingEventIds()) {
			let groups: Awaited<ReturnType<BuzzCliClient["getReactions"]>>;
			try {
				groups = await this.deps.client.getReactions({ eventId });
			} catch (error) {
				this.deps.logger.warn(
					`Failed to poll reactions on ${eventId}: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}

			for (const group of groups) {
				for (const pubkey of group.pubkeys) {
					const key = `${eventId}:${group.emoji}:${pubkey}`;
					if (this.seenReactions.has(key)) continue;
					this.seenReactions.add(key);

					if (!this.isActionable(pubkey)) continue;

					this.deps.onEvent({
						eventType: "reaction_added",
						messageId: eventId,
						channelId: "",
						authorPubkey: pubkey,
						timestamp: String(Math.floor(Date.now() / 1000)),
						emoji: group.emoji,
						deliveryId: `reaction_added:${eventId}:${group.emoji}:${pubkey}`,
					});
				}
			}
		}
	}

	/**
	 * Both authorization layers, applied identically to messages and reactions:
	 * never act on Cyrus's own events (which would loop), and only act on
	 * allowlisted humans. An empty allowlist denies everyone, matching the
	 * webhook transport — Buzz membership is not authorization to spend tokens.
	 */
	private isActionable(pubkey: string): boolean {
		const self = this.deps.getSelfPubkey();
		if (self && pubkey.toLowerCase() === self.toLowerCase()) return false;

		const allowed = this.deps.getAllowedPubkeys();
		return allowed.some(
			(candidate) => candidate.trim().toLowerCase() === pubkey.toLowerCase(),
		);
	}
}
