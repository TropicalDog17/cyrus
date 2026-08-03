import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

/**
 * Filesystem restriction set for the wrapped OMP/MCP process tree, rendered
 * from the session's `EffectiveAccessPolicy` (`toSandboxFilesystem`): broad
 * home deny, explicit read re-allows, write allowlist only.
 */
export interface OmpSandboxFilesystemConfig {
	denyRead: string[];
	allowRead: string[];
	allowWrite: string[];
	denyWrite: string[];
}

export interface OmpSandboxParentProxy {
	http?: string;
	https?: string;
	noProxy?: string;
}

export interface OmpSandboxConfig {
	/** Whether Cyrus sandboxing is enabled for this session. */
	enabled: boolean;
	filesystem: OmpSandboxFilesystemConfig;
	/** Network hosts the session may reach (MCP endpoints, egress policy). */
	allowedDomains: string[];
	deniedDomains: string[];
	/** Cyrus's configured egress proxy — SRT's parent proxy chains through it. */
	parentProxy?: OmpSandboxParentProxy;
}

export interface WrappedOmpCommand {
	argv: string[];
	env: NodeJS.ProcessEnv;
}

/**
 * Wraps the complete OMP ACP process tree in the Anthropic Sandbox Runtime
 * whenever Cyrus sandboxing is enabled (ADR 0016). The wrapper enforces the
 * same `EffectiveAccessPolicy` filesystem answer for the entire OMP/MCP
 * process tree, and SRT's parent proxy is routed through Cyrus's configured
 * egress proxy so the network policy stays authoritative.
 *
 * If sandboxing is enabled but the runtime cannot initialize (missing
 * dependencies, unsupported platform, proxy/CA failure), {@link wrapCommand}
 * throws an actionable error — OMP is unavailable; it is NEVER launched
 * unsandboxed as a fallback.
 */
export class OmpSandbox {
	private initialized = false;

	constructor(private readonly config: OmpSandboxConfig) {}

	/** Whether sandboxing is enabled for this session. */
	get enabled(): boolean {
		return this.config.enabled;
	}

	/**
	 * Wrap the OMP launch command. Returns null when sandboxing is disabled
	 * (the runner spawns directly). Throws an actionable error when enabled
	 * but the runtime cannot initialize.
	 */
	async wrapCommand(
		argv: string[],
		cwd: string,
	): Promise<WrappedOmpCommand | null> {
		if (!this.config.enabled) {
			return null;
		}

		try {
			if (!this.initialized) {
				await SandboxManager.initialize({
					network: {
						allowedDomains: this.config.allowedDomains,
						deniedDomains: this.config.deniedDomains,
						strictAllowlist: true,
					},
					filesystem: {
						denyRead: this.config.filesystem.denyRead,
						...(this.config.filesystem.allowRead.length > 0 && {
							allowRead: this.config.filesystem.allowRead,
						}),
						allowWrite: this.config.filesystem.allowWrite,
						denyWrite: this.config.filesystem.denyWrite,
					},
				});
				this.initialized = true;
			}

			const { argv: wrappedArgv, env } =
				await SandboxManager.wrapWithSandboxArgv(
					argv[0]!,
					undefined,
					{
						network: {
							allowedDomains: this.config.allowedDomains,
							deniedDomains: this.config.deniedDomains,
							strictAllowlist: true,
							...(this.config.parentProxy
								? { parentProxy: this.config.parentProxy }
								: {}),
						},
						filesystem: {
							denyRead: this.config.filesystem.denyRead,
							...(this.config.filesystem.allowRead.length > 0 && {
								allowRead: this.config.filesystem.allowRead,
							}),
							allowWrite: this.config.filesystem.allowWrite,
							denyWrite: this.config.filesystem.denyWrite,
						},
					},
					undefined,
					cwd,
				);

			return { argv: [...wrappedArgv, ...argv.slice(1)], env };
		} catch (error) {
			throw new Error(
				`OMP sandbox initialization failed: ${error instanceof Error ? error.message : String(error)}. OMP sessions require a working OS sandbox (bubblewrap/sandbox-exec, socat for the egress proxy, and CA trust). Fix the sandbox environment or disable sandboxing; Cyrus will NOT launch OMP unsandboxed.`,
			);
		}
	}
}
