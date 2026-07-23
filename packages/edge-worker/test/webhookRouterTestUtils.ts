import { type Mock, vi } from "vitest";
import type {
	WebhookAccessResult,
	WebhookRouterDeps,
} from "../src/WebhookRouter.js";

/**
 * A WebhookRouterDeps whose every callback is a vitest spy, plus fake
 * repositoryRouter / askUserQuestionHandler collaborators exposing only the
 * methods WebhookRouter reads. Override any field for a specific scenario.
 */
export type SpiedWebhookRouterDeps = {
	[K in keyof WebhookRouterDeps]: WebhookRouterDeps[K] extends (
		...args: infer A
	) => infer R
		? Mock<(...args: A) => R>
		: WebhookRouterDeps[K];
} & {
	repositoryRouter: {
		determineRepositoryForWebhook: Mock;
		elicitUserRepositorySelection: Mock;
		hasPendingSelection: Mock;
		reconcileCacheOnProjectMismatch: Mock;
	};
	askUserQuestionHandler: {
		hasPendingQuestion: Mock;
	};
};

const allowed: WebhookAccessResult = { allowed: true };

export function makeWebhookRouterDeps(
	overrides: Partial<SpiedWebhookRouterDeps> = {},
): SpiedWebhookRouterDeps {
	const deps: SpiedWebhookRouterDeps = {
		repositoryRouter: {
			determineRepositoryForWebhook: vi
				.fn()
				.mockResolvedValue({ type: "none" }),
			elicitUserRepositorySelection: vi.fn().mockResolvedValue(undefined),
			hasPendingSelection: vi.fn().mockReturnValue(false),
			reconcileCacheOnProjectMismatch: vi.fn().mockResolvedValue(null),
		},
		askUserQuestionHandler: {
			hasPendingQuestion: vi.fn().mockReturnValue(false),
		},
		isParked: vi.fn().mockReturnValue(false),
		getCachedRepositories: vi.fn().mockReturnValue(null),
		getRepositoryForSession: vi.fn().mockReturnValue(null),
		cacheIssueRepositories: vi.fn(),
		allRepositories: vi.fn().mockReturnValue([]),
		postSessionLostResponse: vi.fn().mockResolvedValue(undefined),
		checkUserAccess: vi.fn().mockReturnValue(allowed),
		handleBlockedUser: vi.fn().mockResolvedValue(undefined),
		checkBlockedByDependencies: vi.fn().mockResolvedValue({
			blocked: false,
			blockingIssueIds: [],
			blockingIdentifiers: [],
		}),
		parkSession: vi.fn().mockResolvedValue(undefined),
		startSession: vi.fn().mockResolvedValue(undefined),
		continuePromptedActivity: vi.fn().mockResolvedValue(undefined),
		stopSession: vi.fn().mockResolvedValue(undefined),
		handleParkedReprompt: vi.fn().mockResolvedValue(undefined),
		handleRepositorySelection: vi.fn().mockResolvedValue(undefined),
		handleAskUserQuestion: vi.fn().mockResolvedValue(undefined),
		handleUnassigned: vi.fn().mockResolvedValue(undefined),
		handleContentUpdate: vi.fn().mockResolvedValue(undefined),
		handleStateChange: vi.fn().mockResolvedValue(undefined),
		handleGitHubComment: vi.fn().mockResolvedValue(undefined),
		handleGitHubPush: vi.fn().mockResolvedValue(undefined),
		handleIssueTerminal: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as SpiedWebhookRouterDeps;
	return deps;
}

/** Minimal RepositoryConfig-shaped fixture for routing assertions. */
export function makeRepo(id: string, name = id): any {
	return { id, name };
}
