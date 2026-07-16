import { AsyncLocalStorage } from "node:async_hooks";
import type { CyrusAgentSession, RunnerType } from "cyrus-core";
import {
	type CyrusToolsOptions,
	createCyrusToolsServer,
	createFetchFailureModesClient,
	type FailureModesHttpClient,
	type ResolvedSession,
} from "cyrus-mcp-tools";
import type { FastifyInstance } from "fastify";
import { Sessions, streamableHttp } from "fastify-mcp";
import type { McpConfigService } from "./McpConfigService.js";

type CyrusToolsMcpContext = {
	contextId?: string;
};

export interface CyrusToolsHostDeps {
	/** Live Fastify instance the route is registered on (SharedApplicationServer.getFastifyInstance) */
	getFastifyInstance: () => FastifyInstance;
	/**
	 * Port the shared server listens on, for getUrl(); composition root does
	 * `server.getPort?.() ?? config.serverPort ?? config.webhookPort ?? 3456`.
	 */
	getPort: () => number;
	/** cyrus-tools MCP context store + auth (owned by McpConfigService, kept as-is) */
	mcpConfigService: Pick<
		McpConfigService,
		"isAuthorizationValid" | "getContext" | "clearPrebuiltServer"
	>;
	/** Aggregator over every place live sessions live (backs cwd→session resolution) */
	getAllKnownSessions: () => CyrusAgentSession[];
	/** Register a child→parent session mapping (linear_agent_session_create*) */
	onChildSessionCreated: (
		childSessionId: string,
		parentSessionId: string,
	) => void;
	/** Deliver orchestrator feedback into a child session (linear_agent_give_feedback) */
	onFeedbackDelivery: (
		childSessionId: string,
		message: string,
	) => Promise<boolean>;
	/** Control-plane API key; undefined → log_failure_mode tool not registered */
	getFailureModesApiKey: () => string | undefined;
	/** cyrus-hosted base URL for failure-mode POSTs (composition root: getCyrusAppUrl()) */
	getFailureModesBaseUrl: () => string;
}

/**
 * Owns the `/mcp/cyrus-tools` in-process MCP endpoint: mounts the
 * fastify-mcp streamable-HTTP plugin behind an auth+context-id onRequest
 * hook, resolves the per-request contextId via AsyncLocalStorage into a
 * prebuilt cyrus-tools MCP server (looked up from McpConfigService), builds
 * CyrusToolsOptions (session callbacks + failure-modes deps), and resolves an
 * agent cwd to a ResolvedSession bundle.
 *
 * Pure wiring — no session-orchestration business logic. Child-mapping and
 * feedback delivery stay behind injected callbacks (onChildSessionCreated /
 * onFeedbackDelivery), which continue to live on EdgeWorker where the
 * session-orchestration state lives.
 */
export class CyrusToolsHost {
	readonly endpointPath = "/mcp/cyrus-tools";
	private registered = false;
	private readonly requestContext =
		new AsyncLocalStorage<CyrusToolsMcpContext>();
	private readonly sessions = new Sessions<any>();
	private failureModesClient: FailureModesHttpClient | null = null;

	constructor(private readonly deps: CyrusToolsHostDeps) {}

	async mount(): Promise<void> {
		if (this.registered) {
			return;
		}

		const fastify = this.deps.getFastifyInstance() as any;
		if (
			typeof fastify.register !== "function" ||
			typeof fastify.addHook !== "function"
		) {
			console.warn(
				"[EdgeWorker] Skipping cyrus-tools MCP endpoint registration: Fastify instance does not support register/addHook",
			);
			return;
		}

		fastify.addHook("onRequest", (request: any, _reply: any, done: any) => {
			const rawUrl =
				typeof request?.raw?.url === "string"
					? request.raw.url
					: typeof request?.url === "string"
						? request.url
						: "";
			const requestPath = rawUrl.split("?")[0];

			if (requestPath !== this.endpointPath) {
				done();
				return;
			}

			if (
				!this.deps.mcpConfigService.isAuthorizationValid(
					request.headers?.authorization,
				)
			) {
				_reply.code(401).send({
					error: "Unauthorized cyrus-tools MCP request",
				});
				done();
				return;
			}

			const rawContextHeader = request.headers?.["x-cyrus-mcp-context-id"];
			const contextId = Array.isArray(rawContextHeader)
				? rawContextHeader[0]
				: rawContextHeader;

			this.requestContext.run({ contextId }, () => {
				done();
			});
		});

		this.sessions.on("connected", (sessionId) => {
			console.log(
				`[EdgeWorker] cyrus-tools MCP session connected: ${sessionId}`,
			);
		});

		this.sessions.on("terminated", (sessionId) => {
			console.log(
				`[EdgeWorker] cyrus-tools MCP session terminated: ${sessionId}`,
			);
		});

		this.sessions.on("error", (error) => {
			console.error("[EdgeWorker] cyrus-tools MCP session error:", error);
		});

		await fastify.register(streamableHttp, {
			stateful: true,
			mcpEndpoint: this.endpointPath,
			sessions: this.sessions,
			createServer: async () => {
				const contextId = this.requestContext.getStore()?.contextId;
				if (!contextId) {
					throw new Error(
						"Missing x-cyrus-mcp-context-id header for cyrus-tools MCP request",
					);
				}

				const context = this.deps.mcpConfigService.getContext(contextId);
				if (!context) {
					throw new Error(
						`Unknown cyrus-tools MCP context '${contextId}'. Build MCP config before connecting.`,
					);
				}

				const sdkServer =
					context.prebuiltServer ||
					createCyrusToolsServer(
						context.linearClient,
						this.createToolsOptions(context.parentSessionId),
					);
				this.deps.mcpConfigService.clearPrebuiltServer(contextId);

				return sdkServer.server;
			},
		});

		this.registered = true;
		console.log(
			`✅ Cyrus tools MCP endpoint registered at ${this.endpointPath}`,
		);
	}

	getUrl(): string {
		return `http://127.0.0.1:${this.deps.getPort()}${this.endpointPath}`;
	}

	/**
	 * Lazily build the HTTP client used by `log_failure_mode` to POST to
	 * cyrus-hosted. Uses the injected base URL (the same the remote
	 * session-store client reads) so preview environments and prod share a
	 * single way to point at a control plane. Returns null when either the URL
	 * or the API key are missing — in that mode the tool is simply not
	 * registered, so customer-mode CLI users without a control plane don't see
	 * a broken tool.
	 */
	private getFailureModesClient(): FailureModesHttpClient | null {
		if (this.failureModesClient) return this.failureModesClient;
		const apiKey = this.deps.getFailureModesApiKey()?.trim();
		if (!apiKey) return null;
		const baseUrl = this.deps.getFailureModesBaseUrl();
		this.failureModesClient = createFetchFailureModesClient({
			baseUrl,
			apiKey,
		});
		return this.failureModesClient;
	}

	/**
	 * Resolve a working-directory string to the rich session bundle a
	 * Cyrus team member needs to triage a failure-mode report: the
	 * internal session id (for dedup), the runner session id + runner
	 * type (so triage can pull the Claude transcript),
	 * the Linear AgentSession + source-issue identifiers (so triage can
	 * jump to the customer thread), and the workspace path (for repro).
	 *
	 * Returns null only when no session matches. We prefer an exact
	 * workspace-path or sub-repo-path match; if neither hits, we fall
	 * back to a prefix match for nested cwds (e.g. shells in a subdir).
	 */
	resolveSessionFromCwd(cwd: string): ResolvedSession | null {
		if (!cwd) return null;
		const normalize = (p: string) => p.replace(/\/+$/, "");
		const target = normalize(cwd);

		const sessions = this.deps.getAllKnownSessions();

		const exact = sessions.find((session) => {
			if (normalize(session.workspace?.path ?? "") === target) return true;
			const repoPaths = session.workspace?.repoPaths;
			if (repoPaths) {
				for (const p of Object.values(repoPaths)) {
					if (typeof p === "string" && normalize(p) === target) return true;
				}
			}
			return false;
		});

		const prefix = exact
			? undefined
			: sessions.find((session) => {
					const root = normalize(session.workspace?.path ?? "");
					return root && target.startsWith(`${root}/`);
				});

		const session = exact ?? prefix;
		if (!session) return null;

		const runnerType: RunnerType | null = session.claudeSessionId
			? "claude"
			: session.cursorSessionId
				? "cursor"
				: session.codexSessionId
					? "codex"
					: null;
		const runnerSessionId =
			session.claudeSessionId ??
			session.cursorSessionId ??
			session.codexSessionId ??
			null;

		const sessionSource = session.id.startsWith("github-")
			? "github"
			: (session.issueContext?.trackerId ?? "linear");

		// For Linear-source sessions, `session.id` is already the Linear
		// AgentSession id (they're literally the same UUID — the v3 rename
		// from `linearAgentActivitySessionId` to `id` kept the value). So we
		// don't surface a separate `linearAgentSessionId` — the server keys
		// dedup on `session_id` and that *is* the Linear AgentSession id when
		// `session_source === 'linear'`.
		return {
			sessionId: session.id,
			runnerSessionId,
			runnerType,
			sourceIssueIdentifier:
				session.issueContext?.issueIdentifier ??
				session.issue?.identifier ??
				null,
			workspacePath: session.workspace?.path ?? null,
			sessionSource,
		};
	}

	createToolsOptions(parentSessionId?: string): CyrusToolsOptions {
		const failureModesClient = this.getFailureModesClient();
		const options: CyrusToolsOptions = {
			parentSessionId,
			onSessionCreated: (childSessionId: string, parentId: string) => {
				this.deps.onChildSessionCreated(childSessionId, parentId);
			},
			onFeedbackDelivery: async (childSessionId: string, message: string) => {
				return this.deps.onFeedbackDelivery(childSessionId, message);
			},
		};
		if (failureModesClient) {
			options.failureModes = {
				resolveSessionFromCwd: (cwd: string) => this.resolveSessionFromCwd(cwd),
				httpClient: failureModesClient,
			};
		}
		return options;
	}

	stop(): void {
		this.sessions.removeAllListeners();
		this.registered = false;
	}
}
