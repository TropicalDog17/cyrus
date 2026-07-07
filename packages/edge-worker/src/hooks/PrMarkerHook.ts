import { execFileSync, spawnSync } from "node:child_process";
import type {
	HookCallbackMatcher,
	HookEvent,
	PostToolUseHookInput,
} from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";

/**
 * The hidden HTML marker that identifies a PR/MR description as Cyrus-authored.
 * Its presence is what tells our GitHub/GitLab webhook handlers that a
 * "Changes requested" or comment event should be forwarded back to Cyrus.
 */
export const CYRUS_PR_MARKER = "<!-- generated-by-cyrus -->";

/**
 * The live PR/MR facts observed while ensuring the marker. Returned so the caller can drive the
 * compounding loop (capture → judge → gate) off a real `prOpened` event instead of polling.
 */
export interface PrMarkerResult {
	/** Provider name (`"github"` | `"gitlab"`). */
	provider: string;
	number: number;
	/** Head branch (`headRefName`) — the loop derives the issue id from this. */
	headBranch: string;
	/** Head commit SHA (`headRefOid`). */
	headSha?: string;
	/** Base branch (`baseRefName`). */
	baseBranch?: string;
	/** ISO-8601 creation timestamp — folds into the run_id. */
	createdAt?: string;
	url?: string;
}

/**
 * Provider-specific knowledge about how to detect PR/MR mutating commands and
 * how to read/write the description on the underlying forge. Adding support
 * for a new forge means adding a new provider — no changes to the hook itself.
 */
export interface PrMarkerProvider {
	/** Provider name, used only for log messages. */
	readonly name: string;
	/** Returns true when `command` will create or update a PR/MR via this provider. */
	matches(command: string): boolean;
	/**
	 * Idempotently ensures the marker is present at the end of the live PR/MR
	 * description for the branch checked out at `cwd`, and returns the PR facts
	 * (or `null` when no PR/MR exists yet, or when this provider does not feed
	 * the loop). Marker-write failures still return the facts — the PR exists.
	 */
	ensureMarker(cwd: string, log: ILogger): PrMarkerResult | null;
}

/**
 * Append the marker to a body, preserving a single trailing newline.
 * Idempotent: returns the original body when the marker is already present.
 */
export function appendMarker(body: string | null | undefined): string {
	const current = body ?? "";
	if (current.includes(CYRUS_PR_MARKER)) {
		return current;
	}
	const trimmed = current.replace(/\s+$/, "");
	if (trimmed.length === 0) {
		return CYRUS_PR_MARKER;
	}
	return `${trimmed}\n\n${CYRUS_PR_MARKER}`;
}

/**
 * GitHub provider — uses the `gh` CLI. Also covers `gt submit` (Graphite),
 * which submits via the GitHub API and ends up viewable through `gh pr view`.
 */
export class GitHubPrMarkerProvider implements PrMarkerProvider {
	readonly name = "github";

	matches(command: string): boolean {
		// Strip surrounding shell noise; we only care whether the command line
		// contains a PR-mutating gh/gt invocation.
		return (
			/\bgh\s+pr\s+(create|edit)\b/.test(command) ||
			/\bgt\s+submit\b/.test(command)
		);
	}

	ensureMarker(cwd: string, log: ILogger): PrMarkerResult | null {
		let payload: {
			body?: string;
			number?: number;
			headRefName?: string;
			headRefOid?: string;
			baseRefName?: string;
			createdAt?: string;
			url?: string;
		};
		try {
			const json = execFileSync(
				"gh",
				[
					"pr",
					"view",
					"--json",
					"body,number,headRefName,headRefOid,baseRefName,createdAt,url",
				],
				{
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			payload = JSON.parse(json);
		} catch {
			// No PR for this branch yet, gh not authenticated, or not a GitHub
			// repo. Either way, nothing for us to ensure — bail silently.
			return null;
		}

		if (typeof payload.number !== "number") {
			return null;
		}
		const updated = appendMarker(payload.body);
		if (updated !== (payload.body ?? "")) {
			const result = spawnSync(
				"gh",
				["pr", "edit", String(payload.number), "--body-file", "-"],
				{
					cwd,
					input: updated,
					encoding: "utf8",
					stdio: ["pipe", "pipe", "pipe"],
				},
			);
			if (result.status !== 0) {
				// Marker write failed, but the PR exists — still surface its facts so the loop can
				// capture. The marker is only needed for later comment-forwarding, not for capture.
				log.warn(
					`[PrMarkerHook] gh pr edit failed for #${payload.number}: ${
						result.stderr?.trim() || "unknown error"
					}`,
				);
			} else {
				log.info(
					`[PrMarkerHook] Appended Cyrus marker to GitHub PR #${payload.number}`,
				);
			}
		}
		return {
			provider: this.name,
			number: payload.number,
			headBranch: payload.headRefName ?? "",
			headSha: payload.headRefOid,
			baseBranch: payload.baseRefName,
			createdAt: payload.createdAt,
			url: payload.url,
		};
	}
}

/**
 * GitLab provider — uses the `glab` CLI.
 */
export class GitLabMrMarkerProvider implements PrMarkerProvider {
	readonly name = "gitlab";

	matches(command: string): boolean {
		return /\bglab\s+mr\s+(create|update|edit)\b/.test(command);
	}

	ensureMarker(cwd: string, log: ILogger): PrMarkerResult | null {
		let payload: { description?: string; iid?: number };
		try {
			const json = execFileSync("glab", ["mr", "view", "--output", "json"], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			payload = JSON.parse(json) as { description?: string; iid?: number };
		} catch {
			return null;
		}

		if (typeof payload.iid !== "number") {
			return null;
		}
		const updated = appendMarker(payload.description);
		if (updated === (payload.description ?? "")) {
			// Marker already present — GitLab does not feed the loop, so nothing more to return.
			return null;
		}

		const result = spawnSync(
			"glab",
			["mr", "update", String(payload.iid), "--description", updated],
			{
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		if (result.status !== 0) {
			log.warn(
				`[PrMarkerHook] glab mr update failed for !${payload.iid}: ${
					result.stderr?.trim() || "unknown error"
				}`,
			);
			return null;
		}
		log.info(
			`[PrMarkerHook] Appended Cyrus marker to GitLab MR !${payload.iid}`,
		);
		// The compounding loop is GitHub-only in this fork; GitLab MRs are not captured.
		return null;
	}
}

/**
 * Build the PostToolUse hook that ensures Cyrus's identifying marker is
 * present on every PR/MR Cyrus creates or updates.
 *
 * Wired alongside the screenshot/stop hooks in RunnerConfigBuilder. Designed
 * around the strategy pattern: `providers` is injectable so tests can stub
 * forge interactions and so new forges can be added without touching this
 * function.
 */
export function buildPrMarkerHook(
	log: ILogger,
	providers: PrMarkerProvider[] = [
		new GitHubPrMarkerProvider(),
		new GitLabMrMarkerProvider(),
	],
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	return {
		PostToolUse: [
			{
				matcher: "Bash",
				hooks: [
					async (input) => {
						const post = input as PostToolUseHookInput;
						const command =
							(post.tool_input as { command?: string } | undefined)?.command ??
							"";
						const provider = providers.find((p) => p.matches(command));
						if (!provider) {
							return {};
						}
						try {
							provider.ensureMarker(post.cwd, log);
						} catch (err) {
							log.warn(
								`[PrMarkerHook] ${provider.name} provider threw: ${
									(err as Error).message
								}`,
							);
						}
						return {};
					},
				],
			},
		],
	};
}
