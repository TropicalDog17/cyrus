import type { AgentSessionPromptedWebhook } from "cyrus-core";
import { beforeEach, describe, expect, it } from "vitest";
import { WebhookRouter, type WebhookRouterDeps } from "../src/WebhookRouter.js";
import {
	makeRepo,
	makeWebhookRouterDeps,
	type SpiedWebhookRouterDeps,
} from "./webhookRouterTestUtils.js";

/**
 * Verifies routePromptedActivity honors the branch precedence mandated by
 * packages/CLAUDE.md, including that the stop signal wins over every other
 * branch and performs no repository lookup, and the Branch-3 fallback ladder.
 */
describe("WebhookRouter.routePromptedActivity", () => {
	let deps: SpiedWebhookRouterDeps;
	let router: WebhookRouter;

	beforeEach(() => {
		deps = makeWebhookRouterDeps();
		router = new WebhookRouter(deps as unknown as WebhookRouterDeps);
	});

	let activityCounter = 0;

	const prompted = (
		body: string,
		opts: {
			signal?: string;
			issueId?: string | null;
			agentSessionId?: string;
			/** Omit the whole agentActivity.id with `null` (exercises the fallback key). */
			activityId?: string | null;
			createdAt?: string;
		} = {},
	): AgentSessionPromptedWebhook => {
		const {
			signal,
			issueId = "issue-1",
			agentSessionId = "session-1",
			// Real activities always carry a distinct id; default to a fresh one so
			// tests only collide on the dedup key when they mean to.
			activityId = `activity-${++activityCounter}`,
			createdAt,
		} = opts;
		return {
			type: "AgentSessionEvent",
			action: "prompted",
			organizationId: "workspace-1",
			...(createdAt ? { createdAt } : {}),
			agentSession: {
				id: agentSessionId,
				issue: issueId ? { id: issueId, identifier: "T-1" } : undefined,
			},
			agentActivity: {
				...(activityId ? { id: activityId } : {}),
				content: { body },
				...(signal ? { signal } : {}),
			},
		} as unknown as AgentSessionPromptedWebhook;
	};

	describe("Branch 0: duplicate delivery guard", () => {
		it("routes a redelivered activity (same id) only once", async () => {
			deps.getCachedRepositories.mockReturnValue([makeRepo("repo-1")]);
			const webhook = prompted("create pr for me", { activityId: "act-1" });

			await router.routePromptedActivity(webhook);
			await router.routePromptedActivity(webhook);

			expect(deps.continuePromptedActivity).toHaveBeenCalledTimes(1);
		});

		it("stops the session only once for a redelivered stop activity", async () => {
			const webhook = prompted("stop", {
				signal: "stop",
				activityId: "act-stop",
			});

			await router.routePromptedActivity(webhook);
			await router.routePromptedActivity(webhook);

			// A second delivery must not look like the intentional double-stop that
			// EdgeWorker escalates into a hard kill.
			expect(deps.stopSession).toHaveBeenCalledTimes(1);
		});

		it("routes distinct activities (genuine re-prompts) every time", async () => {
			deps.getCachedRepositories.mockReturnValue([makeRepo("repo-1")]);

			await router.routePromptedActivity(
				prompted("first", { activityId: "act-1" }),
			);
			await router.routePromptedActivity(
				prompted("second", { activityId: "act-2" }),
			);

			expect(deps.continuePromptedActivity).toHaveBeenCalledTimes(2);
		});

		it("falls back to createdAt+sessionId when the activity has no id", async () => {
			deps.getCachedRepositories.mockReturnValue([makeRepo("repo-1")]);
			const at = "2026-07-09T16:32:19.854Z";

			await router.routePromptedActivity(
				prompted("go", { activityId: null, createdAt: at }),
			);
			await router.routePromptedActivity(
				prompted("go", { activityId: null, createdAt: at }),
			);
			await router.routePromptedActivity(
				prompted("go", { activityId: null, createdAt: "2026-07-09T16:40:00Z" }),
			);

			expect(deps.continuePromptedActivity).toHaveBeenCalledTimes(2);
		});

		it("prunes old keys instead of growing without bound", async () => {
			deps.getCachedRepositories.mockReturnValue([makeRepo("repo-1")]);
			const seen = () =>
				(
					router as unknown as {
						processedPromptedActivityKeys: Set<string>;
					}
				).processedPromptedActivityKeys.size;

			for (let i = 0; i < 501; i++) {
				await router.routePromptedActivity(
					prompted("work", { activityId: `bulk-${i}` }),
				);
			}

			expect(seen()).toBe(251);
			// The most recent key survives the prune, so its redelivery is still caught.
			await router.routePromptedActivity(
				prompted("work", { activityId: "bulk-500" }),
			);
			expect(deps.continuePromptedActivity).toHaveBeenCalledTimes(501);
		});
	});

	describe("Branch 1: stop signal (checked FIRST)", () => {
		it("routes signal==='stop' -> stopSession and performs NO repo lookup", async () => {
			await router.routePromptedActivity(
				prompted("do a bunch more work please", { signal: "stop" }),
			);
			expect(deps.stopSession).toHaveBeenCalledTimes(1);
			expect(deps.getCachedRepositories).not.toHaveBeenCalled();
			expect(deps.continuePromptedActivity).not.toHaveBeenCalled();
		});

		it.each([
			"stop",
			"stop session",
			"stop working",
			"  Stop.  ",
			"STOP!",
		])("routes bare-text %j -> stopSession", async (body) => {
			await router.routePromptedActivity(prompted(body));
			expect(deps.stopSession).toHaveBeenCalledTimes(1);
			expect(deps.getCachedRepositories).not.toHaveBeenCalled();
		});

		it("does NOT treat 'stop the deployment pipeline' as a stop request", async () => {
			deps.getCachedRepositories.mockReturnValue([makeRepo("repo-1")]);
			await router.routePromptedActivity(
				prompted("stop the deployment pipeline"),
			);
			expect(deps.stopSession).not.toHaveBeenCalled();
			expect(deps.continuePromptedActivity).toHaveBeenCalledTimes(1);
		});

		it("stop wins over parked AND pending-selection (precedence regression)", async () => {
			deps.isParked.mockReturnValue(true);
			deps.repositoryRouter.hasPendingSelection.mockReturnValue(true);
			await router.routePromptedActivity(prompted("stop", { signal: "stop" }));
			expect(deps.stopSession).toHaveBeenCalledTimes(1);
			expect(deps.handleParkedReprompt).not.toHaveBeenCalled();
			expect(deps.handleRepositorySelection).not.toHaveBeenCalled();
		});
	});

	describe("Branch 1.5: parked re-prompt", () => {
		it("routes isParked(issueId) -> handleParkedReprompt (over selection/question)", async () => {
			deps.isParked.mockReturnValue(true);
			deps.repositoryRouter.hasPendingSelection.mockReturnValue(true);
			deps.askUserQuestionHandler.hasPendingQuestion.mockReturnValue(true);
			const webhook = prompted("any prompt");
			await router.routePromptedActivity(webhook);
			expect(deps.handleParkedReprompt).toHaveBeenCalledWith(
				webhook,
				"issue-1",
			);
			expect(deps.handleRepositorySelection).not.toHaveBeenCalled();
			expect(deps.handleAskUserQuestion).not.toHaveBeenCalled();
		});
	});

	describe("Branch 2: pending repository selection", () => {
		it("routes hasPendingSelection -> handleRepositorySelection", async () => {
			deps.repositoryRouter.hasPendingSelection.mockReturnValue(true);
			deps.askUserQuestionHandler.hasPendingQuestion.mockReturnValue(true);
			const webhook = prompted("frontend-repo");
			await router.routePromptedActivity(webhook);
			expect(deps.handleRepositorySelection).toHaveBeenCalledWith(webhook);
			expect(deps.handleAskUserQuestion).not.toHaveBeenCalled();
			expect(deps.getCachedRepositories).not.toHaveBeenCalled();
		});
	});

	describe("Branch 2.5: pending AskUserQuestion", () => {
		it("routes hasPendingQuestion -> handleAskUserQuestion", async () => {
			deps.askUserQuestionHandler.hasPendingQuestion.mockReturnValue(true);
			const webhook = prompted("my answer");
			await router.routePromptedActivity(webhook);
			expect(deps.handleAskUserQuestion).toHaveBeenCalledWith(webhook);
			expect(deps.getCachedRepositories).not.toHaveBeenCalled();
		});
	});

	describe("Branch 3: normal continuation", () => {
		it("continues with cache-resolved repos when access allowed", async () => {
			const repo = makeRepo("repo-1");
			deps.getCachedRepositories.mockReturnValue([repo]);
			const webhook = prompted("keep going");
			await router.routePromptedActivity(webhook);
			expect(deps.checkUserAccess).toHaveBeenCalledWith(webhook, repo);
			expect(deps.continuePromptedActivity).toHaveBeenCalledWith(webhook, [
				repo,
			]);
		});

		it("reconciles a stale project cache before the cache lookup", async () => {
			const repo = makeRepo("repo-1");
			const allRepos = [repo, makeRepo("repo-2")];
			deps.getCachedRepositories.mockReturnValue([repo]);
			deps.allRepositories.mockReturnValue(allRepos);
			const webhook = prompted("keep going");
			await router.routePromptedActivity(webhook);
			expect(
				deps.repositoryRouter.reconcileCacheOnProjectMismatch,
			).toHaveBeenCalledWith(webhook, allRepos);
		});

		it("bails with an error log (no continuation) when issueId is missing", async () => {
			await router.routePromptedActivity(prompted("hi", { issueId: null }));
			expect(deps.getCachedRepositories).not.toHaveBeenCalled();
			expect(deps.continuePromptedActivity).not.toHaveBeenCalled();
		});

		it("fallback 1: recovers repo from the session map and caches it", async () => {
			const repo = makeRepo("repo-recovered");
			deps.getCachedRepositories.mockReturnValue(null);
			deps.getRepositoryForSession.mockReturnValue(repo);
			const webhook = prompted("keep going");
			await router.routePromptedActivity(webhook);
			expect(deps.cacheIssueRepositories).toHaveBeenCalledWith("issue-1", [
				"repo-recovered",
			]);
			expect(deps.continuePromptedActivity).toHaveBeenCalledWith(webhook, [
				repo,
			]);
			expect(
				deps.repositoryRouter.determineRepositoryForWebhook,
			).not.toHaveBeenCalled();
		});

		it("fallback 2: re-routes via determineRepositoryForWebhook and caches", async () => {
			const repo = makeRepo("repo-rerouted");
			deps.getCachedRepositories.mockReturnValue(null);
			deps.getRepositoryForSession.mockReturnValue(null);
			deps.repositoryRouter.determineRepositoryForWebhook.mockResolvedValue({
				type: "selected",
				repositories: [repo],
				routingMethod: "team-based",
			});
			const webhook = prompted("keep going");
			await router.routePromptedActivity(webhook);
			expect(deps.cacheIssueRepositories).toHaveBeenCalledWith("issue-1", [
				"repo-rerouted",
			]);
			expect(deps.continuePromptedActivity).toHaveBeenCalledWith(webhook, [
				repo,
			]);
		});

		it("fallback exhausted: posts the lost-session response and stops", async () => {
			deps.getCachedRepositories.mockReturnValue(null);
			deps.getRepositoryForSession.mockReturnValue(null);
			deps.repositoryRouter.determineRepositoryForWebhook.mockResolvedValue({
				type: "none",
			});
			await router.routePromptedActivity(prompted("keep going"));
			expect(deps.postSessionLostResponse).toHaveBeenCalledWith("session-1");
			expect(deps.continuePromptedActivity).not.toHaveBeenCalled();
		});

		it("blocks a mid-session prompt when access is denied", async () => {
			const repo = makeRepo("repo-1");
			deps.getCachedRepositories.mockReturnValue([repo]);
			deps.checkUserAccess.mockReturnValue({
				allowed: false,
				reason: "not whitelisted",
				userName: "Mallory",
			});
			const webhook = prompted("keep going");
			await router.routePromptedActivity(webhook);
			expect(deps.handleBlockedUser).toHaveBeenCalledWith(
				webhook,
				repo,
				"not whitelisted",
			);
			expect(deps.continuePromptedActivity).not.toHaveBeenCalled();
		});
	});
});
