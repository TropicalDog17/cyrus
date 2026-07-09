import type {
	IIssueTrackerService,
	ILogger,
	RepositoryConfig,
} from "cyrus-core";

/**
 * Thin helper for the one non-activity issue-tracker write EdgeWorker still
 * routes through here: creating a comment.
 *
 * All genuine activity posting has collapsed onto {@link IActivitySink.post}:
 * the per-tool render table lives in `ActivityMapper`, and the genuine content
 * formatters (repo-setup-hook, routing, label-role) live in `./activity/
 * formatters.ts`. `createComment` is not an agent activity, so it stays here.
 */
export class ActivityPoster {
	private issueTrackers: Map<string, IIssueTrackerService>;

	constructor(
		issueTrackers: Map<string, IIssueTrackerService>,
		_repositories: Map<string, RepositoryConfig>,
		_logger: ILogger,
	) {
		this.issueTrackers = issueTrackers;
	}

	async postComment(
		issueId: string,
		body: string,
		workspaceId: string,
		parentId?: string,
	): Promise<void> {
		const issueTracker = this.issueTrackers.get(workspaceId);
		if (!issueTracker) {
			throw new Error(`No issue tracker found for workspace ${workspaceId}`);
		}
		const commentInput: { body: string; parentId?: string } = {
			body,
		};
		// Add parent ID if provided (for reply)
		if (parentId) {
			commentInput.parentId = parentId;
		}
		await issueTracker.createComment(issueId, commentInput);
	}
}
