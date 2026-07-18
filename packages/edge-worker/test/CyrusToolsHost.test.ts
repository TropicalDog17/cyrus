import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CyrusToolsHost,
	type CyrusToolsHostDeps,
} from "../src/CyrusToolsHost.js";

// Mock fastify-mcp so constructing the host (which does `new Sessions()` in a
// field initializer) and mount() (which calls `fastify.register(streamableHttp)`)
// never touch the real streamable-HTTP plugin.
vi.mock("fastify-mcp", () => {
	class Sessions {
		on = vi.fn();
		removeAllListeners = vi.fn();
	}
	return { Sessions, streamableHttp: { __plugin: "streamableHttp" } };
});

function makeSession(overrides: Record<string, unknown> = {}) {
	return {
		id: "sess-1",
		claudeSessionId: "claude-1",
		workspace: { path: "/repo/worktrees/S-1" },
		issueContext: { issueIdentifier: "S-1", trackerId: "linear" },
		...overrides,
	} as any;
}

function makeDeps(overrides: Partial<CyrusToolsHostDeps> = {}): {
	deps: CyrusToolsHostDeps;
	fastify: any;
	getRegistered: () => { plugin: unknown; opts: any } | null;
	getOnRequest: () => (request: any, reply: any, done: any) => void;
} {
	let registered: { plugin: unknown; opts: any } | null = null;
	const hooks: Record<string, any> = {};
	const fastify = {
		register: vi.fn(async (plugin: unknown, opts: any) => {
			registered = { plugin, opts };
		}),
		addHook: vi.fn((name: string, fn: any) => {
			hooks[name] = fn;
		}),
	};

	const deps: CyrusToolsHostDeps = {
		getFastifyInstance: () => fastify as any,
		getPort: () => 4321,
		mcpConfigService: {
			isAuthorizationValid: vi.fn(() => true),
			getContext: vi.fn(() => undefined),
			clearPrebuiltServer: vi.fn(),
		} as any,
		getAllKnownSessions: vi.fn(() => []),
		onChildSessionCreated: vi.fn(),
		onFeedbackDelivery: vi.fn(async () => true),
		getFailureModesApiKey: () => undefined,
		getFailureModesBaseUrl: () => "https://app.example.com",
		...overrides,
	};

	return {
		deps,
		fastify,
		getRegistered: () => registered,
		getOnRequest: () => hooks.onRequest,
	};
}

describe("CyrusToolsHost", () => {
	describe("getUrl", () => {
		it("composes the loopback URL from the injected port + endpoint path", () => {
			const { deps } = makeDeps({ getPort: () => 9090 });
			const host = new CyrusToolsHost(deps);
			expect(host.getUrl()).toBe("http://127.0.0.1:9090/mcp/cyrus-tools");
			expect(host.endpointPath).toBe("/mcp/cyrus-tools");
		});
	});

	describe("resolveSessionFromCwd", () => {
		let host: CyrusToolsHost;
		function withSessions(sessions: unknown[]) {
			const { deps } = makeDeps({
				getAllKnownSessions: () => sessions as any,
			});
			host = new CyrusToolsHost(deps);
			return host;
		}

		it("returns null for an empty cwd", () => {
			withSessions([makeSession()]);
			expect(host.resolveSessionFromCwd("")).toBeNull();
		});

		it("returns null when no session matches", () => {
			withSessions([makeSession()]);
			expect(host.resolveSessionFromCwd("/somewhere/else")).toBeNull();
		});

		it("matches on exact workspace path and derives a claude runner", () => {
			withSessions([makeSession()]);
			expect(host.resolveSessionFromCwd("/repo/worktrees/S-1")).toEqual({
				sessionId: "sess-1",
				runnerSessionId: "claude-1",
				runnerType: "claude",
				sourceIssueIdentifier: "S-1",
				workspacePath: "/repo/worktrees/S-1",
				sessionSource: "linear",
			});
		});

		it("normalizes trailing slashes on both cwd and workspace path", () => {
			withSessions([
				makeSession({ workspace: { path: "/repo/worktrees/S-1/" } }),
			]);
			const result = host.resolveSessionFromCwd("/repo/worktrees/S-1//");
			expect(result?.sessionId).toBe("sess-1");
		});

		it("matches on a sub-repo path from workspace.repoPaths", () => {
			withSessions([
				makeSession({
					workspace: {
						path: "/repo/worktrees/S-1",
						repoPaths: { api: "/repo/worktrees/S-1/services/api" },
					},
				}),
			]);
			const result = host.resolveSessionFromCwd(
				"/repo/worktrees/S-1/services/api",
			);
			expect(result?.sessionId).toBe("sess-1");
		});

		it("falls back to a prefix match for nested cwds", () => {
			withSessions([makeSession()]);
			const result = host.resolveSessionFromCwd(
				"/repo/worktrees/S-1/packages/core/src",
			);
			expect(result?.sessionId).toBe("sess-1");
		});

		it("prefers an exact match over a prefix match", () => {
			const parent = makeSession({
				id: "parent",
				workspace: { path: "/repo/worktrees/S-1" },
			});
			const nested = makeSession({
				id: "nested",
				workspace: { path: "/repo/worktrees/S-1/sub" },
			});
			withSessions([parent, nested]);
			// cwd exactly equals the nested workspace → exact wins over the
			// parent's prefix match, regardless of array order.
			expect(
				host.resolveSessionFromCwd("/repo/worktrees/S-1/sub")?.sessionId,
			).toBe("nested");
		});

		it("derives a cursor runner when only cursorSessionId is set", () => {
			withSessions([
				makeSession({ claudeSessionId: undefined, cursorSessionId: "cur-1" }),
			]);
			const result = host.resolveSessionFromCwd("/repo/worktrees/S-1");
			expect(result?.runnerType).toBe("cursor");
			expect(result?.runnerSessionId).toBe("cur-1");
		});

		it("reports a null runner when neither runner session id is set", () => {
			withSessions([
				makeSession({ claudeSessionId: undefined, cursorSessionId: undefined }),
			]);
			const result = host.resolveSessionFromCwd("/repo/worktrees/S-1");
			expect(result?.runnerType).toBeNull();
			expect(result?.runnerSessionId).toBeNull();
		});

		it("marks github-prefixed session ids as a github source", () => {
			withSessions([makeSession({ id: "github-42", issueContext: undefined })]);
			const result = host.resolveSessionFromCwd("/repo/worktrees/S-1");
			expect(result?.sessionSource).toBe("github");
		});

		it("uses issueContext.trackerId as the session source when present", () => {
			withSessions([
				makeSession({
					issueContext: { issueIdentifier: "S-1", trackerId: "jira" },
				}),
			]);
			expect(
				host.resolveSessionFromCwd("/repo/worktrees/S-1")?.sessionSource,
			).toBe("jira");
		});

		it("defaults the session source to linear", () => {
			withSessions([makeSession({ issueContext: { issueIdentifier: "S-1" } })]);
			expect(
				host.resolveSessionFromCwd("/repo/worktrees/S-1")?.sessionSource,
			).toBe("linear");
		});

		it("falls back from issueContext to issue.identifier for the source issue", () => {
			withSessions([
				makeSession({
					issueContext: undefined,
					issue: { identifier: "ABC-9" },
				}),
			]);
			expect(
				host.resolveSessionFromCwd("/repo/worktrees/S-1")
					?.sourceIssueIdentifier,
			).toBe("ABC-9");
		});
	});

	describe("createToolsOptions", () => {
		it("threads the parent session id and delegates the session callbacks", async () => {
			const onChildSessionCreated = vi.fn();
			const onFeedbackDelivery = vi.fn(async () => true);
			const { deps } = makeDeps({
				onChildSessionCreated,
				onFeedbackDelivery,
			});
			const host = new CyrusToolsHost(deps);

			const options = host.createToolsOptions("parent-1");
			expect(options.parentSessionId).toBe("parent-1");

			options.onSessionCreated?.("child-1", "parent-1");
			expect(onChildSessionCreated).toHaveBeenCalledWith("child-1", "parent-1");

			await options.onFeedbackDelivery?.("child-1", "hello");
			expect(onFeedbackDelivery).toHaveBeenCalledWith("child-1", "hello");
		});

		it("omits the failureModes block when no API key is configured", () => {
			const { deps } = makeDeps({ getFailureModesApiKey: () => undefined });
			const host = new CyrusToolsHost(deps);
			expect(host.createToolsOptions().failureModes).toBeUndefined();
		});

		it("omits the failureModes block when the API key is only whitespace", () => {
			const { deps } = makeDeps({ getFailureModesApiKey: () => "   " });
			const host = new CyrusToolsHost(deps);
			expect(host.createToolsOptions().failureModes).toBeUndefined();
		});

		it("wires and caches the failure-modes client when an API key is present", () => {
			const { deps } = makeDeps({ getFailureModesApiKey: () => "secret-key" });
			const host = new CyrusToolsHost(deps);

			const first = host.createToolsOptions();
			const second = host.createToolsOptions();
			expect(first.failureModes).toBeDefined();
			expect(typeof first.failureModes?.resolveSessionFromCwd).toBe("function");
			// The HTTP client is built lazily once and cached across calls.
			expect(first.failureModes?.httpClient).toBe(
				second.failureModes?.httpClient,
			);
		});
	});

	describe("mount", () => {
		let warnSpy: ReturnType<typeof vi.spyOn>;
		let logSpy: ReturnType<typeof vi.spyOn>;
		beforeEach(() => {
			warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		});
		afterEach(() => {
			warnSpy.mockRestore();
			logSpy.mockRestore();
		});

		it("registers the streamable-HTTP plugin at the endpoint path", async () => {
			const { deps, fastify, getRegistered } = makeDeps();
			const host = new CyrusToolsHost(deps);
			await host.mount();

			expect(fastify.register).toHaveBeenCalledTimes(1);
			const registered = getRegistered();
			expect(registered?.opts.mcpEndpoint).toBe("/mcp/cyrus-tools");
			expect(registered?.opts.stateful).toBe(true);
		});

		it("is idempotent — a second mount does not re-register", async () => {
			const { deps, fastify } = makeDeps();
			const host = new CyrusToolsHost(deps);
			await host.mount();
			await host.mount();
			expect(fastify.register).toHaveBeenCalledTimes(1);
		});

		it("skips registration when the Fastify instance lacks register/addHook", async () => {
			const { deps, fastify } = makeDeps({
				getFastifyInstance: () => ({}) as any,
			});
			const host = new CyrusToolsHost(deps);
			await host.mount();
			expect(fastify.register).not.toHaveBeenCalled();
			expect(warnSpy).toHaveBeenCalled();
		});

		describe("onRequest auth hook", () => {
			it("passes through requests for other paths without checking auth", async () => {
				const isAuthorizationValid = vi.fn(() => true);
				const { deps, getOnRequest } = makeDeps({
					mcpConfigService: {
						isAuthorizationValid,
						getContext: vi.fn(),
						clearPrebuiltServer: vi.fn(),
					} as any,
				});
				const host = new CyrusToolsHost(deps);
				await host.mount();

				const done = vi.fn();
				getOnRequest()({ raw: { url: "/status" }, headers: {} }, {}, done);
				expect(done).toHaveBeenCalledTimes(1);
				expect(isAuthorizationValid).not.toHaveBeenCalled();
			});

			it("rejects unauthorized requests to the endpoint with a 401", async () => {
				const { deps, getOnRequest } = makeDeps({
					mcpConfigService: {
						isAuthorizationValid: vi.fn(() => false),
						getContext: vi.fn(),
						clearPrebuiltServer: vi.fn(),
					} as any,
				});
				const host = new CyrusToolsHost(deps);
				await host.mount();

				const send = vi.fn();
				const code = vi.fn(() => ({ send }));
				const done = vi.fn();
				getOnRequest()(
					{ raw: { url: "/mcp/cyrus-tools" }, headers: {} },
					{ code },
					done,
				);
				expect(code).toHaveBeenCalledWith(401);
				expect(send).toHaveBeenCalled();
				expect(done).toHaveBeenCalledTimes(1);
			});

			it("admits authorized requests to the endpoint", async () => {
				const { deps, getOnRequest } = makeDeps({
					mcpConfigService: {
						isAuthorizationValid: vi.fn(() => true),
						getContext: vi.fn(),
						clearPrebuiltServer: vi.fn(),
					} as any,
				});
				const host = new CyrusToolsHost(deps);
				await host.mount();

				const code = vi.fn();
				const done = vi.fn();
				getOnRequest()(
					{
						raw: { url: "/mcp/cyrus-tools?x=1" },
						headers: {
							authorization: "Bearer ok",
							"x-cyrus-mcp-context-id": "ctx-1",
						},
					},
					{ code },
					done,
				);
				expect(code).not.toHaveBeenCalled();
				expect(done).toHaveBeenCalledTimes(1);
			});
		});

		it("createServer throws when the request carries no context id", async () => {
			const { deps, getRegistered } = makeDeps();
			const host = new CyrusToolsHost(deps);
			await host.mount();
			const createServer = getRegistered()?.opts.createServer;
			await expect(createServer()).rejects.toThrow(
				/Missing x-cyrus-mcp-context-id/,
			);
		});
	});

	describe("stop", () => {
		it("tears down session listeners and allows a fresh mount", async () => {
			vi.spyOn(console, "log").mockImplementation(() => {});
			const { deps, fastify } = makeDeps();
			const host = new CyrusToolsHost(deps);
			await host.mount();
			host.stop();
			// registered flag reset → mount registers again.
			await host.mount();
			expect(fastify.register).toHaveBeenCalledTimes(2);
			vi.restoreAllMocks();
		});
	});
});
