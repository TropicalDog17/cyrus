import { execSync } from "node:child_process";
import type { SandboxSettings } from "cyrus-claude-runner";
import type { ILogger, SandboxConfig } from "cyrus-core";
import { EgressProxy } from "./EgressProxy.js";

/**
 * Owns the lifecycle of the sandbox egress proxy and its TLS interception
 * CA certificate: boot-time start, config-reload transitions, and shutdown.
 */
export class SandboxManager {
	/** Egress proxy for sandbox network traffic filtering and header injection */
	private egressProxy: EgressProxy | null = null;
	/** Base SDK sandbox settings to pass to ClaudeRunner sessions (set when proxy starts) */
	private sdkSandboxSettings: SandboxSettings | null = null;
	/** CA cert path for MITM TLS termination (passed per-session env, not process.env) */
	private egressCaCertPath: string | null = null;

	private readonly cyrusHome: string;
	private readonly logger: ILogger;

	constructor(deps: { cyrusHome: string; logger: ILogger }) {
		this.cyrusHome = deps.cyrusHome;
		this.logger = deps.logger;
	}

	getSdkSettings(): SandboxSettings | undefined {
		return this.sdkSandboxSettings ?? undefined;
	}

	getCaCertPath(): string | undefined {
		return this.egressCaCertPath ?? undefined;
	}

	/**
	 * Start egress proxy if sandbox is enabled.
	 * The proxy intercepts Bash-spawned subprocess traffic only (git, gh, npm, etc.).
	 * Claude's inference API, MCP servers, and built-in file tools bypass the proxy.
	 */
	async start(sandboxConfig: SandboxConfig | undefined): Promise<void> {
		if (sandboxConfig?.enabled) {
			this.logger.info("🛡️  Sandbox egress proxy: starting...");
			this.egressProxy = new EgressProxy(
				sandboxConfig!,
				this.cyrusHome,
				this.logger,
			);
			await this.egressProxy.start();

			// Store base SDK sandbox settings — merged per-session with worktree path
			this.sdkSandboxSettings = {
				enabled: true,
				network: {
					httpProxyPort: this.egressProxy.getHttpProxyPort(),
					socksProxyPort: this.egressProxy.getSocksProxyPort(),
				},
			};

			const systemWideCert = sandboxConfig?.systemWideCert === true;
			this.logCertTrustInstructions(
				this.egressProxy.getCACertPath(),
				systemWideCert,
			);

			// When systemWideCert is true, the OS cert store handles trust
			// for all tools — skip per-session cert env vars.
			if (!systemWideCert) {
				this.egressCaCertPath = this.egressProxy.buildCACertBundle();
			}
		} else {
			this.logger.info(
				"🛡️  Sandbox egress proxy: disabled (set sandbox.enabled=true in config.json to enable)",
			);
		}
	}

	/**
	 * Apply sandbox config changes from a config reload.
	 * Handles three transitions:
	 * - enabled → enabled: update network policy on the running proxy
	 * - disabled → enabled: start a new proxy
	 * - enabled → disabled: stop the running proxy
	 */
	async applyConfigChanges(
		sandboxConfig: SandboxConfig | undefined,
	): Promise<void> {
		const wasEnabled = this.egressProxy !== null;
		const isEnabled = sandboxConfig?.enabled === true;

		if (wasEnabled && isEnabled) {
			// Policy update — proxy stays running, rules change
			// Pass current policy (or empty object to reset to allow-all)
			this.egressProxy!.updateNetworkPolicy(sandboxConfig?.networkPolicy ?? {});
			// Handle systemWideCert toggling while proxy is running
			if (sandboxConfig?.systemWideCert) {
				this.egressCaCertPath = null;
			} else if (!this.egressCaCertPath) {
				this.egressCaCertPath = this.egressProxy!.buildCACertBundle();
			}
		} else if (!wasEnabled && isEnabled) {
			// Start proxy for the first time
			this.logger.info("🛡️  Sandbox egress proxy: starting (config change)...");
			this.egressProxy = new EgressProxy(
				sandboxConfig!,
				this.cyrusHome,
				this.logger,
			);
			await this.egressProxy.start();

			this.sdkSandboxSettings = {
				enabled: true,
				network: {
					httpProxyPort: this.egressProxy.getHttpProxyPort(),
					socksProxyPort: this.egressProxy.getSocksProxyPort(),
				},
			};
			const systemWideCert = sandboxConfig?.systemWideCert === true;
			this.logCertTrustInstructions(
				this.egressProxy.getCACertPath(),
				systemWideCert,
			);

			if (!systemWideCert) {
				this.egressCaCertPath = this.egressProxy.buildCACertBundle();
			}
		} else if (wasEnabled && !isEnabled) {
			// Stop proxy
			this.logger.info(
				"🛡️  Sandbox egress proxy: stopping (disabled in config)",
			);
			await this.egressProxy!.stop();
			this.egressProxy = null;
			this.sdkSandboxSettings = null;
			this.egressCaCertPath = null;
		}
	}

	async stop(): Promise<void> {
		if (this.egressProxy) {
			await this.egressProxy.stop();
			this.egressProxy = null;
			this.sdkSandboxSettings = null;
			this.egressCaCertPath = null;
		}
	}

	/**
	 * Log instructions for trusting the egress proxy CA certificate.
	 * When systemWideCert is true, logs that env vars are skipped and trust
	 * is expected from the OS cert store. Otherwise logs env var list and
	 * checks macOS keychain trust status.
	 */
	private logCertTrustInstructions(
		certPath: string,
		systemWideCert = false,
	): void {
		this.logger.info(`🛡️  Sandbox TLS interception CA certificate: ${certPath}`);

		if (systemWideCert) {
			this.logger.info(
				"🛡️  systemWideCert: true — per-session CA cert env vars are skipped (OS cert store handles trust)",
			);
		} else {
			this.logger.info(
				"🛡️  Per-session env vars are set automatically: NODE_EXTRA_CA_CERTS, GIT_SSL_CAINFO, SSL_CERT_FILE, REQUESTS_CA_BUNDLE, PIP_CERT, CURL_CA_BUNDLE, CARGO_HTTP_CAINFO, AWS_CA_BUNDLE, DENO_CERT",
			);
		}

		const trusted = this.isCertTrustedSystemWide();
		if (trusted) {
			this.logger.info("🛡️  CA certificate is trusted system-wide ✓");
			if (!systemWideCert) {
				this.logger.info(
					"🛡️  Tip: set sandbox.systemWideCert: true in config.json to skip per-session cert env vars",
				);
			}
		} else {
			if (process.platform === "darwin") {
				this.logger.warn(
					"🛡️  CA certificate is NOT trusted in the macOS System keychain. To trust (requires sudo):",
				);
				this.logger.warn(
					`🛡️  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${certPath}`,
				);
			} else if (process.platform === "linux") {
				this.logger.warn(
					"🛡️  CA certificate is NOT trusted system-wide. To trust (requires sudo):",
				);
				this.logger.warn(
					`🛡️  sudo cp ${certPath} /usr/local/share/ca-certificates/cyrus-egress-ca.crt && sudo update-ca-certificates`,
				);
			}
			if (systemWideCert) {
				this.logger.warn(
					"🛡️  systemWideCert is true but cert is not trusted — tools using the OS cert store will fail TLS verification",
				);
			}
		}
	}

	/**
	 * Check whether the Cyrus egress proxy CA is trusted at the OS level.
	 * macOS: searches the System keychain. Linux: checks update-ca-certificates output.
	 */
	private isCertTrustedSystemWide(): boolean {
		try {
			if (process.platform === "darwin") {
				execSync(
					'security find-certificate -c "Cyrus Egress Proxy CA" /Library/Keychains/System.keychain',
					{ stdio: "ignore" },
				);
				return true;
			}
			if (process.platform === "linux") {
				// Check if our cert exists in the system CA certificates directory
				execSync(
					"test -f /usr/local/share/ca-certificates/cyrus-egress-ca.crt",
					{ stdio: "ignore" },
				);
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}
}
