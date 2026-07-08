import type { RepositoryConfig } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	RepositoryClassifier,
	type RunClassification,
} from "../src/RepositoryClassifier.js";

/**
 * Build a minimal RepositoryConfig for classifier tests.
 */
function repo(
	id: string,
	name: string,
	overrides: Partial<RepositoryConfig> = {},
): RepositoryConfig {
	return {
		id,
		name,
		repositoryPath: `/path/to/${id}`,
		baseBranch: "main",
		workspaceBaseDir: "/workspace",
		linearWorkspaceId: "workspace-1",
		...overrides,
	} as RepositoryConfig;
}

/**
 * Create a classifier with a stubbed model runner returning a fixed answer.
 */
function classifierReturning(answer: string | null): {
	classifier: RepositoryClassifier;
	run: ReturnType<typeof vi.fn>;
} {
	const run = vi.fn<RunClassification>().mockResolvedValue(answer);
	const classifier = new RepositoryClassifier({ runClassification: run });
	return { classifier, run };
}

describe("RepositoryClassifier", () => {
	const backend = repo("repo-1", "backend", {
		githubUrl: "git@github.com:acme/backend",
	});
	const frontend = repo("repo-2", "frontend", {
		githubUrl: "git@github.com:acme/frontend",
	});
	const repos = [backend, frontend];

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("candidate short-circuits", () => {
		it("returns null when there are no candidate repositories", async () => {
			const { classifier, run } = classifierReturning("backend");
			const result = await classifier.classifyRepository({ repositories: [] });
			expect(result).toBeNull();
			expect(run).not.toHaveBeenCalled();
		});

		it("selects the only candidate without calling the model", async () => {
			const { classifier, run } = classifierReturning("anything");
			const result = await classifier.classifyRepository({
				repositories: [backend],
			});
			expect(result?.repository).toBe(backend);
			expect(run).not.toHaveBeenCalled();
		});
	});

	describe("answer matching", () => {
		it("matches an exact repository name (case-insensitive)", async () => {
			const { classifier } = classifierReturning("Frontend");
			const result = await classifier.classifyRepository({
				repositories: repos,
			});
			expect(result?.repository).toBe(frontend);
		});

		it("strips surrounding markdown/quotes before matching", async () => {
			const { classifier } = classifierReturning("`backend`.");
			const result = await classifier.classifyRepository({
				repositories: repos,
			});
			expect(result?.repository).toBe(backend);
		});

		it("matches an exact GitHub URL", async () => {
			const { classifier } = classifierReturning(
				"git@github.com:acme/frontend",
			);
			const result = await classifier.classifyRepository({
				repositories: repos,
			});
			expect(result?.repository).toBe(frontend);
		});

		it("matches a leading 1-based list index", async () => {
			const { classifier } = classifierReturning("2");
			const result = await classifier.classifyRepository({
				repositories: repos,
			});
			expect(result?.repository).toBe(frontend);
		});

		it("matches an unambiguous whole-word name contained in a sentence", async () => {
			const { classifier } = classifierReturning(
				"I would choose backend for this.",
			);
			const result = await classifier.classifyRepository({
				repositories: repos,
			});
			expect(result?.repository).toBe(backend);
		});

		it("returns null when the answer is ambiguous", async () => {
			const { classifier } = classifierReturning("backend or frontend");
			const result = await classifier.classifyRepository({
				repositories: repos,
			});
			expect(result).toBeNull();
		});

		it("returns null on the NONE sentinel", async () => {
			const { classifier } = classifierReturning("NONE");
			const result = await classifier.classifyRepository({
				repositories: repos,
			});
			expect(result).toBeNull();
		});

		it("returns null when the answer matches no candidate", async () => {
			const { classifier } = classifierReturning("mobile-app");
			const result = await classifier.classifyRepository({
				repositories: repos,
			});
			expect(result).toBeNull();
		});
	});

	describe("failure handling", () => {
		it("returns null when the model returns no answer", async () => {
			const { classifier } = classifierReturning(null);
			const result = await classifier.classifyRepository({
				repositories: repos,
			});
			expect(result).toBeNull();
		});

		it("returns null (never throws) when the runner rejects", async () => {
			const run = vi
				.fn<RunClassification>()
				.mockRejectedValue(new Error("boom"));
			const classifier = new RepositoryClassifier({ runClassification: run });
			await expect(
				classifier.classifyRepository({ repositories: repos }),
			).resolves.toBeNull();
		});
	});

	describe("model selection", () => {
		it("defaults to a fast model when none is provided", async () => {
			const { classifier, run } = classifierReturning("backend");
			await classifier.classifyRepository({ repositories: repos });
			expect(run).toHaveBeenCalledTimes(1);
			expect(run.mock.calls[0]?.[0]?.model).toBe("haiku");
		});

		it("uses an explicitly provided model", async () => {
			const { classifier, run } = classifierReturning("backend");
			await classifier.classifyRepository({
				repositories: repos,
				model: "sonnet",
			});
			expect(run.mock.calls[0]?.[0]?.model).toBe("sonnet");
		});

		it("passes the issue context into the prompt", async () => {
			const { classifier, run } = classifierReturning("backend");
			await classifier.classifyRepository({
				repositories: repos,
				issueIdentifier: "DEV-117",
				issueTitle: "Fix login token refresh",
				issueDescription: "Tokens expire early on the API server.",
			});
			const prompt = run.mock.calls[0]?.[0]?.prompt ?? "";
			expect(prompt).toContain("DEV-117");
			expect(prompt).toContain("Fix login token refresh");
			expect(prompt).toContain("Tokens expire early on the API server.");
			expect(prompt).toContain("backend");
			expect(prompt).toContain("frontend");
		});
	});
});
