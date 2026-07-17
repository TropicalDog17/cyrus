import type { ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { PromptBuilder } from "../src/PromptBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

// `determineSystemPromptFromLabels` only touches the logger and reads the
// bundled prompt templates from disk, so the git/tracker deps can be stubbed.
function makeBuilder(): PromptBuilder {
	return new PromptBuilder({
		logger: silentLogger,
		repositories: new Map(),
		issueTrackers: new Map(),
		gitService: {} as never,
		gitHubUsernameResolver: {} as never,
	});
}

type DebuggerLabelPrompt = NonNullable<
	RepositoryConfig["labelPrompts"]
>["debugger"];

function repoWithDebuggerLabelPrompt(
	debuggerConfig: DebuggerLabelPrompt,
): RepositoryConfig {
	return {
		id: "repo-a",
		name: "Repo A",
		repositoryPath: "/repos/repo-a",
		labelPrompts: { debugger: debuggerConfig },
	} as unknown as RepositoryConfig;
}

describe("PromptBuilder — label-prompt model/effort extraction", () => {
	it("surfaces model and effort from the complex-form label prompt config", async () => {
		const repository = repoWithDebuggerLabelPrompt({
			labels: ["Bug"],
			model: "opus",
			effort: "max",
		});

		const result = await makeBuilder().determineSystemPromptFromLabels(
			["Bug"],
			[repository],
		);

		expect(result?.type).toBe("debugger");
		expect(result?.model).toBe("opus");
		expect(result?.effort).toBe("max");
		// Sanity: the actual template still loads.
		expect(result?.prompt.length).toBeGreaterThan(0);
	});

	it("leaves model and effort undefined for the simple string[] form", async () => {
		const repository = repoWithDebuggerLabelPrompt(["Bug"]);

		const result = await makeBuilder().determineSystemPromptFromLabels(
			["Bug"],
			[repository],
		);

		expect(result?.type).toBe("debugger");
		expect(result?.model).toBeUndefined();
		expect(result?.effort).toBeUndefined();
	});

	it("leaves model and effort undefined when the complex form omits them", async () => {
		const repository = repoWithDebuggerLabelPrompt({ labels: ["Bug"] });

		const result = await makeBuilder().determineSystemPromptFromLabels(
			["Bug"],
			[repository],
		);

		expect(result?.type).toBe("debugger");
		expect(result?.model).toBeUndefined();
		expect(result?.effort).toBeUndefined();
	});
});
