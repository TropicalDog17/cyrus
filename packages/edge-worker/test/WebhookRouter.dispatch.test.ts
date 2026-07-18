import type { Webhook } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookRouter, type WebhookRouterDeps } from "../src/WebhookRouter.js";
import {
	makeRepo,
	makeWebhookRouterDeps,
	type SpiedWebhookRouterDeps,
} from "./webhookRouterTestUtils.js";

/**
 * Verifies WebhookRouter.dispatch() routes each Linear webhook type to exactly
 * the right target using the real cyrus-core type guards. The created/prompted
 * branches are asserted by spying on the router's own routing methods; other
 * types delegate straight through deps.
 */
describe("WebhookRouter.dispatch", () => {
	let deps: SpiedWebhookRouterDeps;
	let router: WebhookRouter;
	const repos = [makeRepo("repo-1")];

	beforeEach(() => {
		deps = makeWebhookRouterDeps();
		router = new WebhookRouter(deps as unknown as WebhookRouterDeps);
	});

	const wh = (w: unknown): Webhook => w as unknown as Webhook;

	it("routes issueUnassignedFromYou -> handleUnassigned", async () => {
		const webhook = wh({
			type: "AppUserNotification",
			action: "issueUnassignedFromYou",
			notification: { issue: { id: "i1" } },
		});
		await router.dispatch(webhook, repos);
		expect(deps.handleUnassigned).toHaveBeenCalledWith(webhook);
	});

	it("routes AgentSessionEvent/created -> routeCreatedWebhook", async () => {
		const createdSpy = vi
			.spyOn(router, "routeCreatedWebhook")
			.mockResolvedValue(undefined);
		const webhook = wh({
			type: "AgentSessionEvent",
			action: "created",
			agentSession: { id: "s1", issue: { id: "i1", identifier: "T-1" } },
			organizationId: "w1",
		});
		await router.dispatch(webhook, repos);
		expect(createdSpy).toHaveBeenCalledWith(webhook, repos);
	});

	it("routes AgentSessionEvent/prompted -> routePromptedActivity", async () => {
		const promptedSpy = vi
			.spyOn(router, "routePromptedActivity")
			.mockResolvedValue(undefined);
		const webhook = wh({
			type: "AgentSessionEvent",
			action: "prompted",
			agentSession: { id: "s1", issue: { id: "i1" } },
			agentActivity: { content: { body: "hello" } },
		});
		await router.dispatch(webhook, repos);
		expect(promptedSpy).toHaveBeenCalledWith(webhook);
	});

	it("routes Issue/update with title change -> handleContentUpdate", async () => {
		const webhook = wh({
			type: "Issue",
			action: "update",
			updatedFrom: { title: "old title" },
			data: { id: "i1" },
		});
		await router.dispatch(webhook, repos);
		expect(deps.handleContentUpdate).toHaveBeenCalledWith(webhook);
		expect(deps.handleStateChange).not.toHaveBeenCalled();
	});

	it("routes Issue/update with description change -> handleContentUpdate", async () => {
		const webhook = wh({
			type: "Issue",
			action: "update",
			updatedFrom: { description: "old" },
			data: { id: "i1" },
		});
		await router.dispatch(webhook, repos);
		expect(deps.handleContentUpdate).toHaveBeenCalledWith(webhook);
	});

	it("routes Issue/update with attachments change -> handleContentUpdate", async () => {
		const webhook = wh({
			type: "Issue",
			action: "update",
			updatedFrom: { attachments: [] },
			data: { id: "i1" },
		});
		await router.dispatch(webhook, repos);
		expect(deps.handleContentUpdate).toHaveBeenCalledWith(webhook);
	});

	it("routes Issue/update with stateId change -> handleStateChange", async () => {
		const webhook = wh({
			type: "Issue",
			action: "update",
			updatedFrom: { stateId: "state-new" },
			data: { id: "i1" },
		});
		await router.dispatch(webhook, repos);
		expect(deps.handleStateChange).toHaveBeenCalledWith(webhook);
		expect(deps.handleContentUpdate).not.toHaveBeenCalled();
	});

	const noOpCases: Array<[string, unknown]> = [
		[
			"issueAssignedToYou",
			{ type: "AppUserNotification", action: "issueAssignedToYou" },
		],
		[
			"issueCommentMention",
			{ type: "AppUserNotification", action: "issueCommentMention" },
		],
		[
			"issueNewComment",
			{ type: "AppUserNotification", action: "issueNewComment" },
		],
		[
			"issueStatusChanged",
			{ type: "AppUserNotification", action: "issueStatusChanged" },
		],
		["Issue/remove", { type: "Issue", action: "remove", data: { id: "i1" } }],
		["unknown type", { type: "Mystery", action: "whoKnows" }],
	];

	it.each(
		noOpCases,
	)("treats %s as a no-op (no dep invoked)", async (_label, payload) => {
		const createdSpy = vi
			.spyOn(router, "routeCreatedWebhook")
			.mockResolvedValue(undefined);
		const promptedSpy = vi
			.spyOn(router, "routePromptedActivity")
			.mockResolvedValue(undefined);

		await router.dispatch(wh(payload), repos);

		expect(createdSpy).not.toHaveBeenCalled();
		expect(promptedSpy).not.toHaveBeenCalled();
		expect(deps.handleUnassigned).not.toHaveBeenCalled();
		expect(deps.handleContentUpdate).not.toHaveBeenCalled();
		expect(deps.handleStateChange).not.toHaveBeenCalled();
		expect(deps.handleIssueTerminal).not.toHaveBeenCalled();
	});
});
