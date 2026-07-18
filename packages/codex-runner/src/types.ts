import type {
	AgentMessage,
	AgentRunnerConfig,
	AgentSessionInfo,
} from "cyrus-core";

export interface CodexRunnerConfig extends AgentRunnerConfig {
	/**
	 * API key for the Codex CLI. Falls back to `CODEX_API_KEY`, then
	 * `OPENAI_API_KEY`. Forwarded to the ACP adapter's environment so it can
	 * authenticate the underlying Codex session.
	 */
	codexApiKey?: string;

	/**
	 * Command that launches the Codex ACP adapter (a stdio JSON-RPC server that
	 * bridges the Codex runtime to ACP). When unset, the runner spawns
	 * `npx -y @agentclientprotocol/codex-acp`. Override via the
	 * `CODEX_ACP_COMMAND` env var (whitespace-separated `command arg arg`).
	 */
	acpCommand?: string;

	/**
	 * Path to a specific Codex executable for the adapter to drive instead of its
	 * bundled dependency. Forwarded as `CODEX_PATH`. Falls back to the
	 * `CODEX_PATH` env var.
	 */
	codexPath?: string;
}

export interface CodexSessionInfo extends AgentSessionInfo {
	/** The ACP session id assigned by the Codex adapter on `session/new`. */
	sessionId: string | null;
}

export interface CodexRunnerEvents {
	message: (message: AgentMessage) => void;
	error: (error: Error) => void;
	complete: (messages: AgentMessage[]) => void;
}
