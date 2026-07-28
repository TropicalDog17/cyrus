import { timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createLogger, type ILogger } from "cyrus-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
	BuzzEventTransportConfig,
	BuzzEventTransportEvents,
	BuzzEventType,
	BuzzWebhookEvent,
	BuzzWorkflowWebhookBody,
} from "./types.js";

/** 64 lowercase hex characters — a Nostr event id or pubkey. */
const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Upper bound on a reaction emoji. Buzz reactions are either a literal emoji
 * character or a `:shortcode:`; anything longer is malformed input, not a
 * reaction we should act on.
 */
const MAX_EMOJI_LENGTH = 64;

export declare interface BuzzEventTransport {
	on<K extends keyof BuzzEventTransportEvents>(
		event: K,
		listener: BuzzEventTransportEvents[K],
	): this;
	emit<K extends keyof BuzzEventTransportEvents>(
		event: K,
		...args: Parameters<BuzzEventTransportEvents[K]>
	): boolean;
}

/**
 * BuzzEventTransport — ingress for Buzz conversations.
 *
 * Buzz is a Nostr-backed chat platform. Rather than subscribing to relay
 * events over Nostr (which would mean re-implementing upstream's event
 * schemas, signing and NIP-OA attestation in TypeScript), Cyrus consumes
 * `buzz-workflow` triggers: a workflow in the Buzz channel fires a
 * `call_webhook` step that POSTs to this endpoint. That is the plain HTTP
 * webhook shape the {@link IAgentEventTransport} contract already expects.
 *
 * Two layers of authorization apply, and both are mandatory:
 *
 * 1. `Authorization: Bearer <secret>` — proves the POST came from our own
 *    workflow rather than an arbitrary internet caller. buzz-workflow requires
 *    a public HTTPS target, so this route is reachable by anyone.
 * 2. A Nostr pubkey allowlist — proves the *human* who typed in the channel is
 *    permitted to spend agent sessions. Buzz channels can be open, so channel
 *    membership is not an authorization signal.
 *
 * See `workflows/` for the workflow definitions that produce the request bodies
 * this transport parses. There are two, because a buzz-workflow declares
 * exactly one trigger: `cyrus-trigger.yaml` (`message_posted`) and
 * `cyrus-reaction.yaml` (`reaction_added`). Both must be installed on a channel
 * or reactions never arrive and an execution gate can never be released.
 *
 * Like `GitHubEventTransport`, this class satisfies `IAgentEventTransport`
 * structurally (`register` / `on` / `removeAllListeners`) but does not declare
 * `implements`: that interface's `event` channel is typed to the Linear-shaped
 * `AgentEvent`, and narrowing it to a Buzz payload is not assignable.
 * Deepening the transport seam to a platform-neutral event type is deliberately
 * out of scope — per ADR 0012 we abstract only when two instances force the
 * shape, and GitHub already carries this same exemption.
 */
export class BuzzEventTransport extends EventEmitter {
	private readonly config: BuzzEventTransportConfig;
	private readonly logger: ILogger;
	private readonly allowedPubkeys: ReadonlySet<string>;

	constructor(config: BuzzEventTransportConfig, logger?: ILogger) {
		super();
		this.config = config;
		this.logger = logger ?? createLogger({ component: "BuzzEventTransport" });
		this.allowedPubkeys = new Set(
			(config.allowedPubkeys ?? []).map((key) => key.trim().toLowerCase()),
		);
	}

	/** Register the `POST /buzz-webhook` endpoint with the Fastify server. */
	register(): void {
		this.config.fastifyServer.post(
			"/buzz-webhook",
			async (request: FastifyRequest, reply: FastifyReply) => {
				try {
					await this.handleWebhook(request, reply);
				} catch (error) {
					const err = new Error("Buzz webhook error");
					if (error instanceof Error) {
						err.cause = error;
					}
					this.logger.error("Buzz webhook error", err);
					this.emit("error", err);
					reply.code(500).send({ error: "Internal server error" });
				}
			},
		);

		if (!this.config.secret) {
			this.logger.warn(
				"Registered POST /buzz-webhook with no secret configured — every request will be rejected. Set CYRUS_BUZZ_WEBHOOK_SECRET in ~/.cyrus/.env to enable it.",
			);
			return;
		}

		this.logger.info(
			`Registered POST /buzz-webhook endpoint (${this.allowedPubkeys.size} allowlisted pubkey(s))`,
		);
	}

	private async handleWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		if (!this.authorizeRequest(request, reply)) {
			return;
		}

		const parsed = this.parseBody(request.body);
		if (!parsed) {
			reply.code(400).send({ error: "Malformed Buzz workflow payload" });
			return;
		}

		if (!this.allowedPubkeys.has(parsed.authorPubkey)) {
			// 202, not 403: the workflow did nothing wrong, and a non-2xx would
			// make the relay log a delivery failure for ordinary chatter from
			// people who simply are not Cyrus users.
			this.logger.debug(
				`Dropping Buzz ${parsed.eventType} from unauthorized pubkey ${parsed.authorPubkey}`,
			);
			reply.code(202).send({ success: true, ignored: true });
			return;
		}

		this.logger.info(
			`Received Buzz ${parsed.eventType} on channel ${parsed.channelId} (event ${parsed.messageId})`,
		);

		this.emit("event", parsed);
		reply.code(200).send({ success: true });
	}

	/**
	 * Verify the shared secret. An unset secret fails closed — this endpoint is
	 * internet-reachable by design.
	 */
	private authorizeRequest(
		request: FastifyRequest,
		reply: FastifyReply,
	): boolean {
		if (!this.config.secret) {
			reply.code(401).send({ error: "Buzz webhook secret is not configured" });
			return false;
		}

		const authHeader = request.headers.authorization;
		if (!authHeader) {
			reply.code(401).send({ error: "Missing Authorization header" });
			return false;
		}

		const expected = `Bearer ${this.config.secret}`;
		const provided = Buffer.from(authHeader);
		const expectedBuffer = Buffer.from(expected);
		if (
			provided.length !== expectedBuffer.length ||
			!timingSafeEqual(provided, expectedBuffer)
		) {
			reply.code(401).send({ error: "Invalid authorization token" });
			return false;
		}

		return true;
	}

	/**
	 * Validate the workflow body into a {@link BuzzWebhookEvent}, or null when
	 * it does not describe an event we can act on.
	 */
	private parseBody(body: unknown): BuzzWebhookEvent | null {
		if (typeof body !== "object" || body === null) {
			this.logger.debug("Buzz webhook body is not a JSON object");
			return null;
		}

		const raw = body as BuzzWorkflowWebhookBody;

		const eventType = raw.type;
		if (eventType !== "message_posted" && eventType !== "reaction_added") {
			this.logger.debug(`Ignoring unsupported Buzz trigger type: ${eventType}`);
			return null;
		}

		const messageId = raw.message_id?.trim().toLowerCase() ?? "";
		const authorPubkey = raw.author?.trim().toLowerCase() ?? "";
		const channelId = raw.channel_id?.trim() ?? "";
		const timestamp = raw.timestamp?.trim() ?? "";

		// An unresolved `{{trigger.x}}` placeholder reaches us literally —
		// buzz-workflow emits unknown variables verbatim rather than erroring —
		// so these shape checks double as a guard against workflow-YAML typos.
		if (!HEX_64.test(messageId)) {
			this.logger.debug(`Buzz webhook has invalid message_id: ${messageId}`);
			return null;
		}
		if (!HEX_64.test(authorPubkey)) {
			this.logger.debug(`Buzz webhook has invalid author: ${authorPubkey}`);
			return null;
		}
		if (!channelId || channelId.includes("{{")) {
			this.logger.debug(`Buzz webhook has invalid channel_id: ${channelId}`);
			return null;
		}

		const emoji = raw.emoji?.trim();
		if (emoji && emoji.length > MAX_EMOJI_LENGTH) {
			this.logger.debug("Buzz webhook emoji exceeds maximum length");
			return null;
		}

		return {
			eventType: eventType as BuzzEventType,
			messageId,
			channelId,
			authorPubkey,
			timestamp,
			...(emoji ? { emoji } : {}),
			deliveryId: `${eventType}:${messageId}:${emoji ?? ""}`,
		};
	}
}
