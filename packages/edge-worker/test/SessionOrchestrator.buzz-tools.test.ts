import { READONLY_DEFAULT_ALLOWED_TOOLS } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BuzzSessionPhase,
	SessionOrchestrator,
	type SessionOrchestratorDeps,
	type StartBuzzSessionRequest,
} from "../src/SessionOrchestrator.js";

vi.mock("node:fs/promises", () => ({
	mkdir: vi.fn(async () => undefined),
}));
vi.mock("cyrus-claude-runner", () => ({
	ClaudeRunner: vi.fn(function (this: any) {
		this.start = vi.fn(async () => ({ sessionId: "runner-sess" }));
		this.stop = vi.fn();
	}),
}));
vi.mock("cyrus-cursor-runner", () => ({
	CursorRunner: vi.fn(),
}));

const REPO = {
	id: "repo-1",
	name: "Repo One",
	repositoryPath: "/repo",
	baseBranch: "main",
	linearWorkspaceId: "ws-1",
} as any;

/** What `buildAllowedTools(repository)` returns for this repo — the "full" set. */
const REPOSITORY_TOOLS = ["Read", "Edit", "Write", "Bash"];

function makeLogger(): any {
	const logger: any = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
	logger.withContext = vi.fn(() => logger);
	return logger;
}

/**
 * Only the collaborators `startBuzzSession` reaches, so a missing one surfaces
 * as a failure here rather than being absorbed by an unrelated stub.
 */
function makeDeps(): {
	deps: SessionOrchestratorDeps;
	buildIssueConfig: ReturnType<typeof vi.fn>;
} {
	const buildIssueConfig = vi.fn((input: any) => ({
		config: { model: "m", _input: input } as any,
		runnerType: "claude" as const,
	}));

	const session = {
		id: "buzz-thread-root",
		issueContext: { issueId: "BUZZ-a1b2c3", issueIdentifier: "BUZZ-a1b2c3" },
		workspace: { path: "/repo/wt/BUZZ-a1b2c3" },
	};

	const deps = {
		logger: makeLogger(),
		cyrusHome: "/home/u/.cyrus",
		agentSessionManager: {
			getSession: vi.fn(() => session),
			getActiveSessionsByBranchName: vi.fn(() => []),
			createCyrusAgentSession: vi.fn(),
			setActivitySink: vi.fn(),
			getAgentRunner: vi.fn(() => undefined),
			addAgentRunner: vi.fn(),
		},
		warmPool: {
			isEnabled: vi.fn(() => false),
			acquireWarm: vi.fn(() => undefined),
		},
		runnerConfigBuilder: { buildIssueConfig },
		skillsPluginResolver: {
			resolve: vi.fn(async () => []),
			discoverSkillNames: vi.fn(async () => []),
		},
		getConfig: vi.fn(() => ({}) as any),
		getClaudeSessionStore: vi.fn(() => null),
		getWarmSessionRegistry: vi.fn(() => ({})),
		getSandboxSettings: vi.fn(() => undefined),
		getEgressCaCertPath: vi.fn(() => undefined),
		buildAllowedTools: vi.fn(() => [...REPOSITORY_TOOLS]),
		buildDisallowedTools: vi.fn(() => []),
		buildSkillSessionContext: vi.fn(() => ({
			repositoryId: REPO.id,
			repoPaths: [REPO.repositoryPath],
		})),
		resolveSkillRepoPaths: vi.fn(() => [REPO.repositoryPath]),
		createAskUserQuestionCallback: vi.fn(() => async () => ({}) as any),
		savePersistedState: vi.fn(async () => {}),
		setSessionRepository: vi.fn(),
	} as unknown as SessionOrchestratorDeps;

	return { deps, buildIssueConfig };
}

function makeReq(
	overrides: Partial<StartBuzzSessionRequest> = {},
): StartBuzzSessionRequest {
	return {
		repository: REPO,
		workspace: { path: "/repo/wt/BUZZ-a1b2c3", isGitWorktree: true },
		sessionId: "buzz-thread-root",
		sessionKey: "BUZZ-a1b2c3",
		threadRootId: "thread-root",
		branchName: "buzz/a1b2c3",
		title: "Make the thing work",
		taskInstructions: "INSTRUCTIONS",
		activitySink: {} as any,
		...overrides,
	};
}

/** The `allowedTools` array that actually reached the runner config builder. */
async function allowedToolsFor(
	phase: BuzzSessionPhase,
): Promise<string[] | undefined> {
	const { deps, buildIssueConfig } = makeDeps();
	const orch = new SessionOrchestrator(deps);

	await orch.startBuzzSession(makeReq({ phase }));

	return buildIssueConfig.mock.calls[0]?.[0]?.allowedTools;
}

describe("startBuzzSession allowedTools (the execution gate)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("gives an execute phase the repository's full tool set", async () => {
		expect(await allowedToolsFor("execute")).toEqual(REPOSITORY_TOOLS);
	});

	it("gives a triage phase the read-only preset plus AskUserQuestion", async () => {
		expect(await allowedToolsFor("triage")).toEqual([
			...READONLY_DEFAULT_ALLOWED_TOOLS,
			"AskUserQuestion",
		]);
	});

	// The regression this selection is written positively for: write access is
	// opt-in for `execute` alone, so a phase the union does not admit — one added
	// later, or one deserialized from an older persisted record — is read-only
	// rather than silently handed Edit/Write/Bash.
	it("gives a phase the union does not admit the read-only tool set", async () => {
		const unknownPhase = "planning" as unknown as BuzzSessionPhase;

		expect(await allowedToolsFor(unknownPhase)).toEqual([
			...READONLY_DEFAULT_ALLOWED_TOOLS,
			"AskUserQuestion",
		]);
	});
});
