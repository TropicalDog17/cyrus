import type { InternalMessage } from "cyrus-core";
import type { FastifyInstance } from "fastify";

/**
 * Buzz trigger kinds Cyrus reacts to. Mirrors the `on:` tag of
 * `buzz-workflow`'s `TriggerDef` (`message_posted` / `reaction_added`); the
 * other trigger kinds (`diff_posted`, `schedule`, `webhook`) are not routed to
 * Cyrus.
 */
export type BuzzEventType = "message_posted" | "reaction_added";

/**
 * Raw JSON body POSTed by a buzz-workflow `call_webhook` step.
 *
 * IMPORTANT: every field here is id-shaped on purpose. `buzz-workflow`'s
 * `resolve_template` performs **raw** string substitution with no JSON
 * escaping, so interpolating free text (a chat message body) into a JSON
 * template produces invalid JSON the moment a user types a quote, a backslash
 * or a newline. The workflow therefore sends only hex ids, the channel id and
 * a unix timestamp — all of which are JSON-safe by construction — and the
 * message text is resolved out-of-band from the relay by event id.
 *
 * The canonical workflow definition that produces this body ships alongside
 * this package at `workflows/cyrus-trigger.yaml`.
 */
export interface BuzzWorkflowWebhookBody {
	/** Trigger kind, written literally in the workflow YAML (not templated). */
	type?: string;
	/**
	 * Nostr event id of the triggering message. For `reaction_added` this is
	 * the *target* message of the reaction, not the reaction event itself
	 * (buzz-workflow resolves the NIP-25 `e` tag before templating).
	 */
	message_id?: string;
	/** Channel UUID the event occurred in. */
	channel_id?: string;
	/** Hex pubkey of the acting user. */
	author?: string;
	/** Unix timestamp of the triggering event, as a string. */
	timestamp?: string;
	/** Emoji for `reaction_added`; empty string for `message_posted`. */
	emoji?: string;
}

/**
 * A validated Buzz trigger, emitted on the transport's `event` channel.
 */
export interface BuzzWebhookEvent {
	eventType: BuzzEventType;
	/** Nostr event id (64 lowercase hex) of the message this event concerns. */
	messageId: string;
	/** Channel UUID. */
	channelId: string;
	/** Hex pubkey of the acting user. */
	authorPubkey: string;
	/** Unix timestamp string of the triggering event. */
	timestamp: string;
	/** Reaction emoji, present only for `reaction_added`. */
	emoji?: string;
	/** Synthesized idempotency key, stable per (event, trigger kind). */
	deliveryId: string;
}

export interface BuzzEventTransportConfig {
	/** Shared Fastify server every transport registers routes on. */
	fastifyServer: FastifyInstance;
	/**
	 * Shared secret expected as `Authorization: Bearer <secret>`. The workflow
	 * supplies it via the `headers:` map on its `call_webhook` step. An empty
	 * secret disables the endpoint entirely — buzz-workflow requires a public
	 * HTTPS target, so an unauthenticated route would be internet-reachable.
	 */
	secret: string;
	/**
	 * Nostr pubkeys (64 hex, lowercase) permitted to trigger Cyrus. Events from
	 * any other key are dropped with 202 — the workflow gets a success response
	 * so it does not retry, but nothing is emitted.
	 *
	 * An empty or omitted allowlist denies everyone: this endpoint is public,
	 * and defaulting to open would let any relay user start agent sessions.
	 */
	allowedPubkeys?: readonly string[];
}

export interface BuzzEventTransportEvents {
	/** A validated, authorized Buzz trigger. */
	event: (event: BuzzWebhookEvent) => void;
	/** Unified message bus (kept for parity with the other transports). */
	message: (message: InternalMessage) => void;
	error: (error: Error) => void;
}
