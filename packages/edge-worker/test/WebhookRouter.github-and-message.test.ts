import type { InternalMessage } from "cyrus-core";
import type { GitHubWebhookEvent } from "cyrus-github-event-transport";
import { beforeEach, describe, expect, it } from "vitest";
import { WebhookRouter, type WebhookRouterDeps } from "../src/WebhookRouter.js";
import {
	makeWebhookRouterDeps,
	type SpiedWebhookRouterDeps,
} from "./webhookRouterTestUtils.js";

describe("WebhookRouter.dispatchGitHubEvent", () => {
	let deps: SpiedWebhookRouterDeps;
	let router: WebhookRouter;

	beforeEach(() => {
		deps = makeWebhookRouterDeps();
		router = new WebhookRouter(deps as unknown as WebhookRouterDeps);
	});

	it("routes eventType 'push' -> handleGitHubPush(payload)", async () => {
		const payload = { ref: "refs/heads/main" };
		const event = {
			eventType: "push",
			deliveryId: "d1",
			payload,
		} as unknown as GitHubWebhookEvent;
		await router.dispatchGitHubEvent(event);
		expect(deps.handleGitHubPush).toHaveBeenCalledWith(payload);
		expect(deps.handleGitHubComment).not.toHaveBeenCalled();
	});

	it.each([
		"issue_comment",
		"pull_request_review_comment",
		"pull_request_review",
	])("routes eventType '%s' -> handleGitHubComment(event)", async (eventType) => {
		const event = {
			eventType,
			deliveryId: "d1",
			payload: { action: "created" },
		} as unknown as GitHubWebhookEvent;
		await router.dispatchGitHubEvent(event);
		expect(deps.handleGitHubComment).toHaveBeenCalledWith(event);
		expect(deps.handleGitHubPush).not.toHaveBeenCalled();
	});
});

describe("WebhookRouter.dispatchMessage", () => {
	let deps: SpiedWebhookRouterDeps;
	let router: WebhookRouter;

	beforeEach(() => {
		deps = makeWebhookRouterDeps();
		router = new WebhookRouter(deps as unknown as WebhookRouterDeps);
	});

	const msg = (action: string): InternalMessage =>
		({
			source: "linear",
			action,
			workItemId: "issue-1",
			workItemIdentifier: "T-1",
		}) as unknown as InternalMessage;

	it("routes issue_state_change -> handleIssueTerminal", async () => {
		const message = msg("issue_state_change");
		await router.dispatchMessage(message);
		expect(deps.handleIssueTerminal).toHaveBeenCalledWith(message);
	});

	it.each([
		"session_start",
		"user_prompt",
		"stop_signal",
		"content_update",
		"unassign",
	])("treats placeholder message '%s' as a no-op debug trace (no throw, no terminal)", async (action) => {
		await expect(router.dispatchMessage(msg(action))).resolves.toBeUndefined();
		expect(deps.handleIssueTerminal).not.toHaveBeenCalled();
	});

	it("does not throw on an unknown action", async () => {
		await expect(
			router.dispatchMessage(msg("who_knows")),
		).resolves.toBeUndefined();
		expect(deps.handleIssueTerminal).not.toHaveBeenCalled();
	});
});
