import type {
	AgentMessage,
	AgentRunnerConfig,
	AgentSessionInfo,
} from "cyrus-core";

export interface PiRunnerConfig extends AgentRunnerConfig {
	/**
	 * Command used to launch Pi. Defaults to the CLI shipped by the pinned
	 * `@earendil-works/pi-coding-agent` dependency. A whitespace-separated
	 * override can be supplied via `CYRUS_PI_COMMAND`.
	 */
	piCommand?: string;

	/**
	 * Extra environment variables for the Pi process. Used by Cyrus to forward
	 * sandbox proxy certificate settings without mutating the parent process.
	 */
	additionalEnv?: Record<string, string>;
}

export interface PiSessionInfo extends AgentSessionInfo {
	/** Pi's durable session UUID, returned by the RPC `get_state` command. */
	sessionId: string | null;
}

export interface PiRunnerEvents {
	message: (message: AgentMessage) => void;
	error: (error: Error) => void;
	complete: (messages: AgentMessage[]) => void;
}

export interface PiRpcResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

export interface PiUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: {
		total?: number;
	};
}

export interface PiAssistantMessage {
	role: "assistant";
	content?: unknown;
	usage?: PiUsage;
	stopReason?: string;
	errorMessage?: string;
}

export type PiRpcEvent = Record<string, unknown> & {
	type: string;
};
