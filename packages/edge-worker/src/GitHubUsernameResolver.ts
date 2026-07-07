import type { ILogger } from "cyrus-core";

/**
 * Resolve a numeric GitHub user ID (as provided by Linear's `gitHubUserId`
 * field) to a GitHub login (username) via the public GitHub REST API.
 *
 * This is a non-prompt duty split out of PromptBuilder so that the prompt
 * builders can depend on a small, injectable collaborator instead of owning
 * the REST call themselves.
 */
export class GitHubUsernameResolver {
	private readonly logger: ILogger;

	constructor(logger: ILogger) {
		this.logger = logger;
	}

	/**
	 * Resolve a GitHub user ID (numeric string from Linear) to a GitHub username.
	 * Uses the public GitHub REST API: GET https://api.github.com/user/{id}
	 * @param gitHubUserId The numeric GitHub user ID from Linear's gitHubUserId field
	 * @returns The GitHub username (login), or undefined if resolution fails
	 */
	async resolve(gitHubUserId: string): Promise<string | undefined> {
		try {
			const response = await fetch(
				`https://api.github.com/user/${gitHubUserId}`,
				{
					headers: {
						Accept: "application/vnd.github.v3+json",
						"User-Agent": "Cyrus-Agent",
					},
				},
			);

			if (!response.ok) {
				this.logger.warn(
					`GitHub API returned ${response.status} for user ID ${gitHubUserId}`,
				);
				return undefined;
			}

			const data = (await response.json()) as { login?: string };
			if (data.login) {
				this.logger.debug(
					`Resolved GitHub user ID ${gitHubUserId} to username: ${data.login}`,
				);
				return data.login;
			}

			return undefined;
		} catch (error) {
			this.logger.warn(
				`Failed to resolve GitHub username for user ID ${gitHubUserId}:`,
				error,
			);
			return undefined;
		}
	}
}
