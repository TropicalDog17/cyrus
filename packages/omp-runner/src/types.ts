import type { McpServer } from "@agentclientprotocol/sdk";
import type {
	AgentMessage,
	AgentRunnerConfig,
	AgentSessionInfo,
} from "cyrus-core";

/**
 * How OMP permission requests are decided. Implemented by the edge-worker's
 * `OmpToolPolicy` (rendered from `EffectiveAccessPolicy`); the runner never
 * recomputes paths or policy itself.
 */
export interface OmpPermissionPolicy {
	/**
	 * Decide the outcome for a permission request targeting a built-in or MCP
	 * tool. Return `true` to allow, `false` to reject. An operation the policy
	 * cannot classify MUST return `false` (fail closed) — and user approval can
	 * never widen the OS sandbox, so no path exists to "ask the human".
	 */
	allowsTool(operation: string, detail?: string): boolean;
}

export interface OmpRunnerConfig extends AgentRunnerConfig {
	/**
	 * Command that launches OMP as an ACP server. Defaults to `omp`, resolved
	 * from PATH. The runner always appends `acp --print` (a repository
	 * invariant: `--print` prevents an accidental interactive launch if mode
	 * parsing ever changes).
	 */
	ompCommand?: string;

	/**
	 * Extra workspace roots passed as repeated `--add-dir` launch flags. OMP's
	 * ACP handler ignores `additionalDirectories` (ADR 0016), so roots must be
	 * launch-scoped.
	 */
	ompAdditionalDirectories?: string[];

	/**
	 * Built-in tools to enable, passed as a comma-separated `--tools` flag.
	 * Empty array means `--no-tools` (only MCP tools).
	 */
	ompTools?: string[];

	/**
	 * Session-private OMP state directory, passed as `--session-dir`. Scoped
	 * under `cyrusHome/runner-data/omp/<cyrusSessionId>` (see ADR 0016); never
	 * other sessions' transcripts.
	 */
	ompSessionDir?: string;

	/**
	 * Path to a generated OMP overlay config file (mode 0600, outside the
	 * worktree) passed as `--config`. Secrets never live in it.
	 */
	ompOverlayConfigPath?: string;

	/**
	 * The exact MCP catalog for this session — the ONLY servers OMP may
	 * connect to. Nothing ambient is discovered.
	 */
	ompMcpServers?: McpServer[];

	/**
	 * Permission policy rendered from Cyrus's EffectiveAccessPolicy. Absent →
	 * every permission request is rejected (fail closed).
	 */
	ompPermissionPolicy?: OmpPermissionPolicy;

	/**
	 * OS sandbox wrapper (SRT). When present and enabled, the complete OMP
	 * process tree is wrapped; initialization failure makes OMP unavailable
	 * (never an unsandboxed fallback).
	 */
	ompSandbox?: import("./OmpSandbox.js").OmpSandbox;

	/** Bounded wait for the ACP initialize handshake. Default 30s. */
	ompStartupTimeoutMs?: number;

	/** Bounded wait for a prompt turn to finish. Default 20min. */
	ompPromptTimeoutMs?: number;
}

export interface OmpSessionInfo extends AgentSessionInfo {
	/** The real OMP session UUID returned by `session/new` / `session/resume`. */
	sessionId: string | null;
}

export interface OmpRunnerEvents {
	message: (message: AgentMessage) => void;
	error: (error: Error) => void;
	complete: (messages: AgentMessage[]) => void;
}
