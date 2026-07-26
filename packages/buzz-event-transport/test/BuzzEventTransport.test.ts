import { beforeEach, describe, expect, it, vi } from "vitest";
import { BuzzEventTransport } from "../src/BuzzEventTransport.js";
import type {
	BuzzEventTransportConfig,
	BuzzWebhookEvent,
} from "../src/types.js";

const SECRET = "buzz-shared-secret";
const ALLOWED_PUBKEY = "a".repeat(64);
const STRANGER_PUBKEY = "b".repeat(64);
const MESSAGE_ID = "c".repeat(64);
const CHANNEL_ID = "6f1a2b3c-0000-4000-8000-000000000001";

function createMockFastify() {
	const routes: Record<
		string,
		(request: unknown, reply: unknown) => Promise<void>
	> = {};
	return {
		post: vi.fn((path: string, ...args: unknown[]) => {
			const handler =
				args.length === 1
					? (args[0] as (request: unknown, reply: unknown) => Promise<void>)
					: (args[1] as (request: unknown, reply: unknown) => Promise<void>);
			routes[path] = handler;
		}),
		routes,
	};
}

function createMockReply() {
	return {
		code: vi.fn().mockReturnThis(),
		send: vi.fn().mockReturnThis(),
	};
}

function messagePostedBody(overrides: Record<string, unknown> = {}) {
	return {
		type: "message_posted",
		message_id: MESSAGE_ID,
		channel_id: CHANNEL_ID,
		author: ALLOWED_PUBKEY,
		timestamp: "1753500000",
		...overrides,
	};
}

describe("BuzzEventTransport", () => {
	let fastify: ReturnType<typeof createMockFastify>;
	let transport: BuzzEventTransport;
	let events: BuzzWebhookEvent[];

	function build(overrides: Partial<BuzzEventTransportConfig> = {}) {
		fastify = createMockFastify();
		transport = new BuzzEventTransport({
			fastifyServer: fastify as never,
			secret: SECRET,
			allowedPubkeys: [ALLOWED_PUBKEY],
			...overrides,
		});
		events = [];
		transport.on("event", (event) => events.push(event));
		transport.register();
	}

	async function post(
		body: unknown,
		headers: Record<string, string> = { authorization: `Bearer ${SECRET}` },
	) {
		const reply = createMockReply();
		const handler = fastify.routes["/buzz-webhook"];
		if (!handler) throw new Error("route was not registered");
		await handler({ body, headers }, reply);
		return reply;
	}

	beforeEach(() => {
		build();
	});

	it("registers the /buzz-webhook route", () => {
		expect(fastify.post).toHaveBeenCalledWith(
			"/buzz-webhook",
			expect.any(Function),
		);
	});

	it("emits a normalized event for an allowlisted author", async () => {
		const reply = await post(messagePostedBody());

		expect(reply.code).toHaveBeenCalledWith(200);
		expect(events).toEqual([
			{
				eventType: "message_posted",
				messageId: MESSAGE_ID,
				channelId: CHANNEL_ID,
				authorPubkey: ALLOWED_PUBKEY,
				timestamp: "1753500000",
				deliveryId: `message_posted:${MESSAGE_ID}:`,
			},
		]);
	});

	it("carries the emoji and a distinct delivery id for reactions", async () => {
		await post(messagePostedBody({ type: "reaction_added", emoji: "▶️" }));

		expect(events[0]).toMatchObject({
			eventType: "reaction_added",
			emoji: "▶️",
			deliveryId: `reaction_added:${MESSAGE_ID}:▶️`,
		});
	});

	it("rejects a request with no Authorization header", async () => {
		const reply = await post(messagePostedBody(), {});

		expect(reply.code).toHaveBeenCalledWith(401);
		expect(events).toHaveLength(0);
	});

	it("rejects a request with the wrong bearer token", async () => {
		const reply = await post(messagePostedBody(), {
			authorization: "Bearer not-the-secret",
		});

		expect(reply.code).toHaveBeenCalledWith(401);
		expect(events).toHaveLength(0);
	});

	// The endpoint is internet-reachable (buzz-workflow only posts to public
	// HTTPS targets), so an unset secret must fail closed rather than open.
	it("rejects every request when no secret is configured", async () => {
		build({ secret: "" });
		const reply = await post(messagePostedBody(), {
			authorization: "Bearer ",
		});

		expect(reply.code).toHaveBeenCalledWith(401);
		expect(events).toHaveLength(0);
	});

	it("drops events from a pubkey that is not allowlisted", async () => {
		const reply = await post(messagePostedBody({ author: STRANGER_PUBKEY }));

		// 202 so the relay does not record a delivery failure for ordinary
		// chatter from people who are simply not Cyrus users.
		expect(reply.code).toHaveBeenCalledWith(202);
		expect(events).toHaveLength(0);
	});

	it("denies everyone when the allowlist is empty", async () => {
		build({ allowedPubkeys: [] });
		const reply = await post(messagePostedBody());

		expect(reply.code).toHaveBeenCalledWith(202);
		expect(events).toHaveLength(0);
	});

	it("ignores trigger kinds Cyrus does not route", async () => {
		const reply = await post(messagePostedBody({ type: "diff_posted" }));

		expect(reply.code).toHaveBeenCalledWith(400);
		expect(events).toHaveLength(0);
	});

	// buzz-workflow emits unknown `{{...}}` variables literally instead of
	// erroring, so a typo in the workflow YAML arrives as placeholder text.
	it("rejects unresolved template placeholders", async () => {
		const reply = await post(
			messagePostedBody({ message_id: "{{trigger.mesage_id}}" }),
		);

		expect(reply.code).toHaveBeenCalledWith(400);
		expect(events).toHaveLength(0);
	});

	it("rejects a non-hex author pubkey", async () => {
		const reply = await post(messagePostedBody({ author: "nostr:alice" }));

		expect(reply.code).toHaveBeenCalledWith(400);
		expect(events).toHaveLength(0);
	});

	it("rejects an oversized emoji", async () => {
		const reply = await post(
			messagePostedBody({ type: "reaction_added", emoji: "x".repeat(65) }),
		);

		expect(reply.code).toHaveBeenCalledWith(400);
		expect(events).toHaveLength(0);
	});
});
