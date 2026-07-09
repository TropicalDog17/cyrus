import type { AgentSessionCreatedWebhook, RepositoryConfig } from "cyrus-core";

/**
 * Everything needed to replay {@link SessionOrchestrator.startSession} when a
 * blocked-by dependency is later resolved. These fields MUST stay a superset of
 * {@link StartSessionRequest} so that {@link ParkedSessionRegistry.wake} can
 * hand the stored payload straight back to `startSession` without drift.
 *
 * (Was the inline `Map` value type on `EdgeWorker.parkedSessions`.)
 */
export interface ParkedSession {
	agentSession: AgentSessionCreatedWebhook["agentSession"];
	repositories: RepositoryConfig[];
	linearWorkspaceId: string;
	guidance?: AgentSessionCreatedWebhook["guidance"];
	commentBody?: string | null;
	baseBranchOverrides?: Map<string, string>;
	routingMethod?: string;
	blockingIssueIds: string[];
}

/**
 * Owns the block/park/wake state machine for sessions parked behind blocked-by
 * dependencies, keyed by Linear issue ID (the blocked issue).
 *
 * This registry is a pure, in-memory state store: it performs NO I/O. Detection
 * of the block condition (Linear-relations lookups), the acknowledgment / wake
 * activity posts, and the runner replay all stay in EdgeWorker and call into
 * this registry — keeping the transitions unit-testable in isolation.
 */
export class ParkedSessionRegistry {
	private parked = new Map<string, ParkedSession>();

	/** Park a session behind its current blockers. */
	park(issueId: string, parked: ParkedSession): void {
		this.parked.set(issueId, parked);
	}

	/** Whether a session is currently parked for this issue. */
	isParked(issueId: string): boolean {
		return this.parked.has(issueId);
	}

	/** Read a parked entry without removing it. */
	get(issueId: string): ParkedSession | undefined {
		return this.parked.get(issueId);
	}

	/** Remove and return a parked entry (the caller then replays it). */
	wake(issueId: string): ParkedSession | undefined {
		const parked = this.parked.get(issueId);
		if (parked) {
			this.parked.delete(issueId);
		}
		return parked;
	}

	/**
	 * Core transition: drop `completedIssueId` from every parked entry's
	 * `blockingIssueIds`, and return the issue IDs whose blocker list is now
	 * empty (ready to wake). Does NOT delete the entries — the caller wakes each
	 * one (posting the wake activity and replaying `startSession`).
	 */
	resolveBlocker(completedIssueId: string): string[] {
		const ready: string[] = [];
		for (const [blockedIssueId, parked] of this.parked.entries()) {
			if (!parked.blockingIssueIds.includes(completedIssueId)) {
				continue;
			}
			parked.blockingIssueIds = parked.blockingIssueIds.filter(
				(id) => id !== completedIssueId,
			);
			if (parked.blockingIssueIds.length === 0) {
				ready.push(blockedIssueId);
			}
		}
		return ready;
	}

	/** Overwrite the blocker list for a parked entry (reprompt re-check path). */
	setBlockers(issueId: string, blockingIssueIds: string[]): void {
		const parked = this.parked.get(issueId);
		if (parked) {
			parked.blockingIssueIds = blockingIssueIds;
		}
	}

	/** Read-only view for tests / inspection. */
	getAll(): ReadonlyMap<string, ParkedSession> {
		return this.parked;
	}
}
