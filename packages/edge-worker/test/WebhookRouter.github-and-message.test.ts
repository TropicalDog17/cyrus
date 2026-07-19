import type { InternalMessage } from "cyrus-core";
import type {
	GitHubCommentWebhookEvent,
	GitHubPushPayload,
	GitHubWebhookEvent,
} from "cyrus-github-event-transport";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhookRouter, type WebhookRouterDeps } from "../src/WebhookRouter.js";
import {
	makeRepo,
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

/** Minimal issue_comment event on a PR, mentioning @cyrusagent. */
function makeIssueCommentEvent(
	overrides: {
		commentBody?: string;
		commentAuthor?: string;
		isPr?: boolean;
	} = {},
): GitHubCommentWebhookEvent {
	const {
		commentBody = "@cyrusagent do the thing",
		commentAuthor = "someone",
		isPr = true,
	} = overrides;
	return {
		eventType: "issue_comment",
		deliveryId: "d1",
		payload: {
			action: "created",
			issue: {
				id: 1,
				number: 42,
				title: "Fix failing tests",
				body: null,
				state: "open",
				html_url: "https://github.com/testorg/my-repo/issues/42",
				url: "https://api.github.com/repos/testorg/my-repo/issues/42",
				user: { login: "someone" } as any,
				...(isPr
					? {
							pull_request: {
								url: "https://api.github.com/repos/testorg/my-repo/pulls/42",
								html_url: "https://github.com/testorg/my-repo/pull/42",
								diff_url: "https://github.com/testorg/my-repo/pull/42.diff",
								patch_url: "https://github.com/testorg/my-repo/pull/42.patch",
							},
						}
					: {}),
			},
			comment: {
				id: 100,
				body: commentBody,
				html_url: "https://github.com/testorg/my-repo/issues/42#comment-100",
				url: "https://api.github.com/repos/testorg/my-repo/issues/comments/100",
				user: { login: commentAuthor } as any,
				created_at: "2025-01-15T10:30:00Z",
				updated_at: "2025-01-15T10:30:00Z",
			},
			repository: {
				id: 1,
				name: "my-repo",
				full_name: "testorg/my-repo",
				html_url: "https://github.com/testorg/my-repo",
				clone_url: "https://github.com/testorg/my-repo.git",
				ssh_url: "git@github.com:testorg/my-repo.git",
				default_branch: "main",
				owner: { login: "testorg" } as any,
			},
			sender: { login: commentAuthor } as any,
		},
	} as unknown as GitHubCommentWebhookEvent;
}

/** Minimal pull_request_review event requesting changes. */
function makePrReviewEvent(
	overrides: { state?: string; reviewBody?: string | null } = {},
): GitHubCommentWebhookEvent {
	const { state = "changes_requested", reviewBody = "Please fix the tests" } =
		overrides;
	return {
		eventType: "pull_request_review",
		deliveryId: "d2",
		payload: {
			action: "submitted",
			review: {
				id: 777,
				node_id: "MDE3",
				body: reviewBody,
				state,
				html_url:
					"https://github.com/testorg/my-repo/pull/42#pullrequestreview-777",
				user: { login: "reviewer" } as any,
				submitted_at: "2025-01-15T10:30:00Z",
				commit_id: "abc123",
			},
			pull_request: {
				number: 42,
				title: "Fix failing tests",
				head: { ref: "fix-tests" },
				base: { ref: "main" },
			} as any,
			repository: {
				id: 1,
				name: "my-repo",
				full_name: "testorg/my-repo",
				html_url: "https://github.com/testorg/my-repo",
				clone_url: "https://github.com/testorg/my-repo.git",
				ssh_url: "git@github.com:testorg/my-repo.git",
				default_branch: "main",
				owner: { login: "testorg" } as any,
			},
			sender: { login: "reviewer" } as any,
		},
	} as unknown as GitHubCommentWebhookEvent;
}

describe("WebhookRouter.gateGitHubComment", () => {
	let deps: SpiedWebhookRouterDeps;
	let router: WebhookRouter;
	const originalBotUsername = process.env.GITHUB_BOT_USERNAME;

	beforeEach(() => {
		deps = makeWebhookRouterDeps();
		router = new WebhookRouter(deps as unknown as WebhookRouterDeps);
		delete process.env.GITHUB_BOT_USERNAME;
	});

	afterEach(() => {
		if (originalBotUsername === undefined) {
			delete process.env.GITHUB_BOT_USERNAME;
		} else {
			process.env.GITHUB_BOT_USERNAME = originalBotUsername;
		}
	});

	it("skips a comment on a non-PR issue", () => {
		const event = makeIssueCommentEvent({ isPr: false });
		expect(router.gateGitHubComment(event, {})).toEqual({ proceed: false });
	});

	it("skips a self-comment from the configured bot user", () => {
		process.env.GITHUB_BOT_USERNAME = "cyrusagent";
		const event = makeIssueCommentEvent({
			commentAuthor: "cyrusagent",
			commentBody: "@cyrusagent done",
		});
		expect(router.gateGitHubComment(event, {})).toEqual({ proceed: false });
	});

	it("skips a pull_request_review that is not requesting changes", () => {
		const event = makePrReviewEvent({ state: "approved" });
		expect(router.gateGitHubComment(event, {})).toEqual({ proceed: false });
	});

	it("skips a pull_request_review when prReviewTrigger is false", () => {
		const event = makePrReviewEvent();
		expect(router.gateGitHubComment(event, { prReviewTrigger: false })).toEqual(
			{ proceed: false },
		);
	});

	it("skips a comment missing the configured @mention", () => {
		process.env.GITHUB_BOT_USERNAME = "cyrusagent";
		const event = makeIssueCommentEvent({
			commentBody: "just a regular comment",
		});
		expect(router.gateGitHubComment(event, {})).toEqual({ proceed: false });
	});

	it("proceeds for a mentioning comment on a PR", () => {
		process.env.GITHUB_BOT_USERNAME = "cyrusagent";
		const event = makeIssueCommentEvent({
			commentBody: "@cyrusagent please help",
		});
		expect(router.gateGitHubComment(event, {})).toEqual({ proceed: true });
	});

	it("proceeds for a changes_requested pull_request_review when prReviewTrigger is unset", () => {
		const event = makePrReviewEvent();
		expect(router.gateGitHubComment(event, {})).toEqual({ proceed: true });
	});

	it("proceeds for a changes_requested pull_request_review when prReviewTrigger is true", () => {
		const event = makePrReviewEvent();
		expect(router.gateGitHubComment(event, { prReviewTrigger: true })).toEqual({
			proceed: true,
		});
	});
});

describe("WebhookRouter.resolveGitHubPushTarget", () => {
	let deps: SpiedWebhookRouterDeps;
	let router: WebhookRouter;

	const repo = {
		...makeRepo("test-repo"),
		githubUrl: "https://github.com/testorg/my-repo",
	};

	const makePushPayload = (
		overrides: Partial<GitHubPushPayload> = {},
	): GitHubPushPayload =>
		({
			ref: "refs/heads/main",
			before: "aaa",
			after: "bbb",
			created: false,
			deleted: false,
			forced: false,
			compare: "https://github.com/testorg/my-repo/compare/aaa...bbb",
			commits: [],
			head_commit: null,
			repository: { full_name: "testorg/my-repo" } as any,
			pusher: { name: "someone", email: "someone@example.com" },
			sender: { login: "someone" } as any,
			...overrides,
		}) as unknown as GitHubPushPayload;

	beforeEach(() => {
		deps = makeWebhookRouterDeps({ allRepositories: () => [repo] as any });
		router = new WebhookRouter(deps as unknown as WebhookRouterDeps);
	});

	it("returns null for a tag ref", () => {
		const payload = makePushPayload({ ref: "refs/tags/v1.0.0" });
		expect(router.resolveGitHubPushTarget(payload)).toBeNull();
	});

	it("returns null for a branch deletion", () => {
		const payload = makePushPayload({ deleted: true });
		expect(router.resolveGitHubPushTarget(payload)).toBeNull();
	});

	it("returns null when no configured repository matches", () => {
		const payload = makePushPayload({
			repository: { full_name: "someorg/other-repo" } as any,
		});
		expect(router.resolveGitHubPushTarget(payload)).toBeNull();
	});

	it("returns the matched repository and derived branch name", () => {
		const payload = makePushPayload({ ref: "refs/heads/feature/x" });
		expect(router.resolveGitHubPushTarget(payload)).toEqual({
			repository: repo,
			branchName: "feature/x",
		});
	});
});

describe("WebhookRouter.findRepositoryByGitHubUrl", () => {
	let deps: SpiedWebhookRouterDeps;
	let router: WebhookRouter;

	it("returns the repository whose githubUrl matches the full name", () => {
		const repo = {
			...makeRepo("test-repo"),
			githubUrl: "https://github.com/testorg/my-repo",
		};
		deps = makeWebhookRouterDeps({ allRepositories: () => [repo] as any });
		router = new WebhookRouter(deps as unknown as WebhookRouterDeps);

		expect(router.findRepositoryByGitHubUrl("testorg/my-repo")).toBe(repo);
	});

	it("returns null when no repository matches", () => {
		deps = makeWebhookRouterDeps({ allRepositories: () => [] });
		router = new WebhookRouter(deps as unknown as WebhookRouterDeps);

		expect(router.findRepositoryByGitHubUrl("testorg/my-repo")).toBeNull();
	});

	it("skips repositories without a githubUrl", () => {
		const repo = { ...makeRepo("test-repo") };
		deps = makeWebhookRouterDeps({ allRepositories: () => [repo] as any });
		router = new WebhookRouter(deps as unknown as WebhookRouterDeps);

		expect(router.findRepositoryByGitHubUrl("testorg/my-repo")).toBeNull();
	});
});
