import { tmpdir } from "node:os";
import type { LinearClient } from "@linear/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import OpenAI from "openai";
import { registerImageTools } from "../image-tools/index.js";
import { registerSoraTools } from "../sora-tools/index.js";
import { registerAgentSessionTools } from "./agent-session-tools.js";
import { registerIssueTools } from "./issue-tools.js";
import {
	type FailureModesHttpClient,
	type ResolveSessionFromCwd,
	registerLogFailureModeTool,
} from "./log-failure-mode.js";
import { registerUploadTool } from "./upload-tool.js";

/**
 * Options for creating Cyrus tools with session management capabilities
 */
export interface CyrusToolsOptions {
	/**
	 * Callback to register a child-to-parent session mapping
	 * Called when a new agent session is created
	 */
	onSessionCreated?: (childSessionId: string, parentSessionId: string) => void;

	/**
	 * Callback to deliver feedback to a parent session
	 * Called when feedback is given to a child session
	 */
	onFeedbackDelivery?: (
		childSessionId: string,
		message: string,
	) => Promise<boolean>;

	/**
	 * The ID of the current parent session (if any)
	 */
	parentSessionId?: string;

	/**
	 * Optional dependencies for the `log_failure_mode` tool. When omitted,
	 * the tool is not registered (e.g. in CLI mode without a control plane).
	 */
	failureModes?: {
		resolveSessionFromCwd: ResolveSessionFromCwd;
		httpClient: FailureModesHttpClient;
	};
}

/**
 * Create a standard MCP SDK server with Cyrus tools.
 */
export function createCyrusToolsServer(
	linearClient: LinearClient,
	options: CyrusToolsOptions = {},
): McpServer {
	const server = new McpServer({
		name: "cyrus-tools",
		version: "1.0.0",
	});

	registerUploadTool(server, linearClient);

	registerAgentSessionTools(server, linearClient, {
		parentSessionId: options.parentSessionId,
		onSessionCreated: options.onSessionCreated,
		onFeedbackDelivery: options.onFeedbackDelivery,
	});

	registerIssueTools(server, linearClient);

	// Register the log_failure_mode tool whenever the harness wires it up
	// (EdgeWorker provides the cwd→session resolver and an HTTP client to
	// cyrus-hosted). Omitted in CLI mode where there is no control plane.
	if (options.failureModes) {
		registerLogFailureModeTool(server, {
			resolveSessionFromCwd: options.failureModes.resolveSessionFromCwd,
			httpClient: options.failureModes.httpClient,
			fallbackSessionId: options.parentSessionId,
		});
	}

	// Register OpenAI-based tools if OPENAI_API_KEY is available
	const openaiApiKey = process.env.OPENAI_API_KEY;
	if (openaiApiKey) {
		const openaiClient = new OpenAI({
			apiKey: openaiApiKey,
			timeout: 600 * 1000, // 10 minutes
		});
		const outputDirectory = tmpdir();

		registerImageTools(server, openaiClient, outputDirectory);
		registerSoraTools(server, openaiClient, outputDirectory);
	}

	return server;
}
