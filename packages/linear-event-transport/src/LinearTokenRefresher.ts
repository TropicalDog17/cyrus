/**
 * OAuth token-refresh machinery for the Linear issue-tracker adapter.
 *
 * Extracted from LinearIssueTrackerService: this is the only stateful,
 * concurrent, side-effecting logic in that adapter (401 interception,
 * workspace-level coalescing of concurrent refreshes, and the HTTP call to
 * Linear's OAuth token endpoint). LinearIssueTrackerService composes an
 * instance of this class - it delegates the client request-patch to
 * `patchClient()` and the promise-clear half of `setAccessToken()` to
 * `clearRefreshPromise()`.
 *
 * @module issue-tracker/adapters/LinearTokenRefresher
 */

import type { LinearClient } from "@linear/sdk";
import type { ILogger } from "cyrus-core";

/**
 * OAuth configuration for automatic token refresh.
 */
export interface LinearOAuthConfig {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
	/** Workspace ID for coalescing concurrent refreshes across instances */
	workspaceId: string;
	/** Called when tokens are refreshed - use to persist new tokens */
	onTokenRefresh?: (tokens: {
		accessToken: string;
		refreshToken: string;
	}) => void | Promise<void>;
}

/**
 * Owns the OAuth token-refresh lifecycle for a Linear-backed issue tracker.
 *
 * Patches a `LinearClient`'s underlying GraphQL client to intercept 401
 * responses, coalesce concurrent refresh attempts (both per-instance and,
 * via static maps, across instances sharing a workspace), and retry the
 * original request once with the refreshed token.
 */
export class LinearTokenRefresher {
	private oauthConfig?: LinearOAuthConfig;
	private logger: ILogger;
	private refreshPromise: Promise<string> | null = null;

	/**
	 * Static map for workspace-level coalescing of concurrent token refreshes.
	 * Multiple instances sharing the same workspace will share a single refresh HTTP call.
	 */
	private static pendingRefreshes: Map<string, Promise<string>> = new Map();

	/**
	 * Static map storing the current refresh token per workspace.
	 * All instances sharing a workspace read/write from this shared state.
	 */
	private static workspaceRefreshTokens: Map<string, string> = new Map();

	/**
	 * Create a new LinearTokenRefresher.
	 *
	 * @param oauthConfig - Optional OAuth config for automatic token refresh on 401 errors
	 * @param logger - Logger instance
	 */
	constructor(oauthConfig: LinearOAuthConfig | undefined, logger: ILogger) {
		this.oauthConfig = oauthConfig;
		this.logger = logger;

		// Register initial refresh token in shared static map
		if (oauthConfig?.refreshToken) {
			LinearTokenRefresher.workspaceRefreshTokens.set(
				oauthConfig.workspaceId,
				oauthConfig.refreshToken,
			);
		}
	}

	/**
	 * Patches `linearClient.client.request` to intercept 401 errors, refresh
	 * the access token (coalescing concurrent refreshes), and retry the
	 * original request once with the new token.
	 *
	 * Only patches if oauthConfig is provided AND linearClient.client exists
	 * (the .client property may not exist in test mocks).
	 */
	patchClient(linearClient: LinearClient): void {
		if (!(this.oauthConfig && linearClient.client)) {
			return;
		}

		const client = linearClient.client;
		const originalRequest = client.request.bind(client);

		// Track the current refresh promise - coalesces concurrent 401 errors.
		// Cleared when refresh fails or when setAccessToken() is called.

		client.request = async <Data, Variables extends Record<string, unknown>>(
			document: string,
			variables?: Variables,
			requestHeaders?: RequestInit["headers"],
			isRetry = false,
		): Promise<Data> => {
			try {
				return (await originalRequest(
					document,
					variables,
					requestHeaders,
				)) as Data;
			} catch (error) {
				// Don't retry if this is already a retry attempt (prevents infinite loops)
				// or if it's not a token expiration error
				if (isRetry || !this.isTokenExpiredError(error)) throw error;

				// Coalesce concurrent refresh attempts - everyone shares the same promise.
				if (!this.refreshPromise) {
					this.refreshPromise = this.doTokenRefresh().catch((refreshError) => {
						// On failure, clear the promise so next 401 can retry fresh
						this.refreshPromise = null;
						this.logger.error("Token refresh failed:", refreshError);
						throw refreshError;
					});
				}

				try {
					const newToken = await this.refreshPromise;
					// Clear cached promise so future token expirations trigger a fresh refresh.
					// Workspace-level coalescing via pendingRefreshes still deduplicates concurrent calls.
					this.refreshPromise = null;
					client.setHeader("Authorization", `Bearer ${newToken}`);

					// Retry the request with the new token (marked as retry to prevent loops)
					return (await (client.request as any)(
						document,
						variables,
						requestHeaders,
						true, // isRetry flag
					)) as Data;
				} catch (_refreshError) {
					// If refresh failed, throw the original 401 error for clarity
					throw error;
				}
			}
		};
	}

	/**
	 * Performs the OAuth token refresh with workspace-level coalescing.
	 * Multiple concurrent refresh requests for the same workspace share a single HTTP call.
	 * @returns The new access token
	 */
	private async doTokenRefresh(): Promise<string> {
		if (!this.oauthConfig) {
			throw new Error("OAuth config not provided");
		}

		const { workspaceId } = this.oauthConfig;

		// Check if there's already a pending refresh for this workspace
		const pendingRefresh =
			LinearTokenRefresher.pendingRefreshes.get(workspaceId);
		if (pendingRefresh) {
			this.logger.info(`Coalescing token refresh for workspace ${workspaceId}`);
			return pendingRefresh;
		}

		// Create the refresh promise and store it
		const refreshPromise = this.executeTokenRefresh();
		LinearTokenRefresher.pendingRefreshes.set(workspaceId, refreshPromise);

		try {
			return await refreshPromise;
		} finally {
			// One of the key guarantees of finally — it runs regardless of how the try block exits (return, throw, or normal completion).
			LinearTokenRefresher.pendingRefreshes.delete(workspaceId);
		}
	}

	/**
	 * Executes the actual OAuth token refresh HTTP request.
	 * @internal
	 */
	private async executeTokenRefresh(): Promise<string> {
		const { clientId, clientSecret, workspaceId, onTokenRefresh } =
			this.oauthConfig!;

		// Read current refresh token from shared static map (may have been updated by another instance)
		const refreshToken =
			LinearTokenRefresher.workspaceRefreshTokens.get(workspaceId);
		if (!refreshToken) {
			throw new Error(
				`No refresh token available for workspace ${workspaceId}`,
			);
		}

		this.logger.info(`Refreshing token for workspace ${workspaceId}...`);

		const params = new URLSearchParams({
			grant_type: "refresh_token",
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
		});

		// https://linear.app/developers/oauth-2-0-authentication
		const response = await fetch("https://api.linear.app/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		});

		if (!response.ok) {
			throw new Error(`Token refresh failed: ${response.status}`);
		}

		const data = (await response.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		// Update shared static map for all instances sharing this workspace
		LinearTokenRefresher.workspaceRefreshTokens.set(
			workspaceId,
			data.refresh_token,
		);

		// Notify caller so they can persist tokens to disk
		if (onTokenRefresh) {
			try {
				await onTokenRefresh({
					accessToken: data.access_token,
					refreshToken: data.refresh_token,
				});
			} catch (err) {
				this.logger.error("onTokenRefresh callback failed:", err);
			}
		}

		this.logger.info(
			`Token refreshed successfully for workspace ${workspaceId}`,
		);
		return data.access_token;
	}

	/**
	 * Check if an error is a 401 token expiration error.
	 */
	private isTokenExpiredError(error: unknown): boolean {
		const err = error as { status?: number; response?: { status?: number } };
		return err?.status === 401 || err?.response?.status === 401;
	}

	/**
	 * Clear any cached refresh promise so subsequent 401s trigger a fresh
	 * refresh rather than reusing a stale resolved promise with an old token.
	 * Called by LinearIssueTrackerService.setAccessToken().
	 */
	clearRefreshPromise(): void {
		this.refreshPromise = null;
	}
}
