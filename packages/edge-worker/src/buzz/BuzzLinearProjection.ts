import type {
	IIssueTrackerService,
	ILogger,
	RepositoryConfig,
} from "cyrus-core";
import type {
	BuzzProjectedProgram,
	BuzzTrackRequest,
} from "./BuzzSessionCoordinator.js";

export interface BuzzLinearProjectionDeps {
	logger: ILogger;
	/** Tracker for a repository's workspace, or null when it has none. */
	getIssueTracker(repository: RepositoryConfig): IIssueTrackerService | null;
	/** Human-readable URL of a Buzz thread, if the deployment has one. */
	buildThreadUrl?(channelId: string, threadRootId: string): string | undefined;
}

/**
 * Address that opens a Buzz thread in the desktop app.
 *
 * The scheme is the only address a reader can follow: `buzz.relayUrl` is a
 * relay *API* base with no web view of a thread, so an `https://` link derived
 * from it would be dead in every projected issue. Shape is fixed by the
 * desktop's own handler — `buzz://message?channel=<uuid>&id=<eventId>[&thread=<rootId>]`
 * — and a thread root is both the message to open and the thread to open it in.
 */
export function buzzThreadDeepLink(
	channelId: string,
	threadRootId: string,
): string {
	const params = new URLSearchParams({
		channel: channelId,
		id: threadRootId,
		thread: threadRootId,
	});
	return `buzz://message?${params.toString()}`;
}

/**
 * The team a projection would land in, or undefined when the repository has none
 * usable.
 *
 * `teamKeys` is `z.array(z.string())` with no `.min(1)` and nothing normalizing
 * it, so `[""]` is a configuration a human can write and a config push can
 * deliver. Every caller that asks "is this repository projectable?" must decide
 * it the same way this does, or a warning goes silent on exactly the config that
 * needed it.
 */
export function projectionTeamKey(
	repository: RepositoryConfig,
): string | undefined {
	return repository.teamKeys?.find((key) => key.trim().length > 0);
}

/** Why a repository cannot be projected. Ordered as `track()` decides it. */
export type UnprojectableReason = "no-tracker" | "no-team-keys";

/** One projected issue, remembered so later updates find it. */
interface ProjectedIssue {
	issueId: string;
	identifier: string;
	url: string;
	/** Kept so follow-up writes resolve the same workspace's tracker. */
	repository: RepositoryConfig;
}

/** Attempts per write, including the first. Linear writes are idempotent-ish
 * here (create runs once per session), so a short retry is safe. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

/**
 * Records Buzz work in Linear as a passive projection.
 *
 * Linear is no longer the surface Cyrus is driven from — the conversation lives
 * in Buzz. What Linear still gives is a durable, searchable record that
 * outlives a chat scrollback, so this writes one issue per tracked Buzz thread
 * and then keeps it current.
 *
 * THE ISSUE IS CREATED UNASSIGNED, ON PURPOSE
 * -------------------------------------------
 * Assignment (and @mention) is exactly what makes Linear open an agent session.
 * An issue Cyrus creates to *record* work it is already doing must therefore
 * stay unassigned, or the projection would trigger a second session — not on the
 * same branch, since a Linear-origin session derives `DEV-nnn-<slug>` while this
 * thread holds `BUZZ-xxxxxx-<slug>`, which is worse: two worktrees doing the same
 * work, both able to open a pull request. This is a load-bearing property, not a
 * default that happens to be convenient.
 *
 * Every write is best-effort: a Linear outage must never stall or fail a Buzz
 * session, because the session is the work and the issue is only its shadow.
 */
export class BuzzLinearProjection {
	private readonly deps: BuzzLinearProjectionDeps;
	private readonly bySessionId = new Map<string, ProjectedIssue>();

	constructor(deps: BuzzLinearProjectionDeps) {
		this.deps = deps;
	}

	/** The issue projected for a session, if one was created. */
	get(sessionId: string): ProjectedIssue | undefined {
		return this.bySessionId.get(sessionId);
	}

	/**
	 * Create the tracking issue for a Buzz thread.
	 *
	 * @returns the issue identifier, or null when nothing was created.
	 */
	/**
	 * Why `track` would refuse this repository, or null when it would try.
	 *
	 * Exists so a caller can tell an operator something true. `track` returns a
	 * bare null for three different reasons, and the remedy differs: a missing
	 * `teamKeys` is the operator's to fix, while a workspace with no tracker at
	 * all is a deployment that does not use Linear and cannot be helped by
	 * editing `teamKeys`. Asking here keeps that knowledge in the one class that
	 * has it, rather than giving this one an egress seam.
	 */
	unprojectableReason(
		repository: RepositoryConfig,
	): UnprojectableReason | null {
		if (!this.deps.getIssueTracker(repository)) return "no-tracker";
		if (!projectionTeamKey(repository)) return "no-team-keys";
		return null;
	}

	async track(request: BuzzTrackRequest): Promise<string | null> {
		const existing = this.bySessionId.get(request.sessionId);
		if (existing) return existing.identifier;

		const tracker = this.deps.getIssueTracker(request.repository);
		if (!tracker) {
			this.deps.logger.debug(
				`No issue tracker for ${request.repository.name}; skipping Buzz projection`,
			);
			return null;
		}

		const teamKey = projectionTeamKey(request.repository);
		if (!teamKey) {
			this.deps.logger.warn(
				`Cannot project Buzz thread ${request.sessionKey}: repository "${request.repository.name}" has no teamKeys`,
			);
			return null;
		}

		const created = await this.attempt(
			`create issue for ${request.sessionKey}`,
			() =>
				tracker.createIssue({
					teamId: teamKey,
					title: request.title,
					description: this.buildDescription(request),
					// Deliberately no assigneeId — see the class doc.
				}),
		);
		if (!created) return null;

		const projected: ProjectedIssue = {
			issueId: created.id,
			identifier: created.identifier,
			url: created.url,
			repository: request.repository,
		};
		this.bySessionId.set(request.sessionId, projected);

		this.deps.logger.info(
			`Projected Buzz thread ${request.sessionKey} to ${projected.identifier}`,
		);
		return projected.identifier;
	}

	/**
	 * Append a note to a projected issue — a branch name, a PR link, the final
	 * summary. Silently does nothing when the thread was never projected.
	 */
	async note(sessionId: string, body: string): Promise<void> {
		const projected = this.bySessionId.get(sessionId);
		if (!projected) return;

		const tracker = this.deps.getIssueTracker(projected.repository);
		if (!tracker) return;

		await this.attempt(`comment on ${projected.identifier}`, () =>
			tracker.createComment(projected.issueId, { body }),
		);
	}

	/** Move a projected issue to a workflow state by name, e.g. `In Progress`. */
	async setState(sessionId: string, stateName: string): Promise<void> {
		const projected = this.bySessionId.get(sessionId);
		if (!projected) return;

		const tracker = this.deps.getIssueTracker(projected.repository);
		if (!tracker) return;

		await this.attempt(
			`move ${projected.identifier} to ${stateName}`,
			async () => {
				const issue = await tracker.fetchIssue(projected.issueId);
				const teamId = (await issue.team)?.id;
				if (!teamId) throw new Error("issue has no team");

				const states = await tracker.fetchWorkflowStates(teamId);
				const target = states.nodes.find(
					(state) => state.name.toLowerCase() === stateName.toLowerCase(),
				);
				if (!target) {
					// Workflow states are per-team and renameable; a missing one is a
					// configuration mismatch, not a transient failure worth retrying.
					throw new NonRetryableError(
						`no workflow state named "${stateName}" in this team`,
					);
				}
				return tracker.updateIssue(projected.issueId, { stateId: target.id });
			},
		);
	}

	/**
	 * Re-seed a hydrated thread's projection from persisted state.
	 *
	 * `track()` refuses to create a second issue only because it finds the first
	 * one in this map, which a restart empties. Without this, the first gate
	 * decision after a restart would project a duplicate issue for a thread that
	 * already has one — and the duplicate would then collect the status writes,
	 * leaving the original stale.
	 */
	restore(
		sessionId: string,
		program: BuzzProjectedProgram,
		repository: RepositoryConfig,
	): void {
		this.bySessionId.set(sessionId, { ...program, repository });
	}

	/** Forget a session's projection, e.g. when its thread is torn down. */
	forget(sessionId: string): void {
		this.bySessionId.delete(sessionId);
	}

	private buildDescription(request: BuzzTrackRequest): string {
		const lines = [
			`**Buzz thread:** \`${request.threadRootId}\` in channel \`${request.channelId}\``,
		];

		const url = this.deps.buildThreadUrl?.(
			request.channelId,
			request.threadRootId,
		);
		if (url) lines.push(`**Link:** ${url}`);

		lines.push(
			"",
			request.summary,
			"",
			"---",
			`_Projected from Buzz session ${request.sessionKey}. This issue is intentionally unassigned: assigning it would start a second agent session on the same work._`,
		);
		return lines.join("\n");
	}

	/**
	 * Run a tracker write with a bounded retry, swallowing the final failure.
	 *
	 * Buzz sessions must not stall on Linear. The retry exists because a single
	 * 5xx losing the record of an entire piece of work is worse than a two-second
	 * delay on a path nothing awaits.
	 */
	private async attempt<T>(
		label: string,
		operation: () => Promise<T>,
	): Promise<T | null> {
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			try {
				return await operation();
			} catch (error) {
				if (error instanceof NonRetryableError || attempt === MAX_ATTEMPTS) {
					this.deps.logger.warn(
						`Buzz projection failed to ${label}: ${error instanceof Error ? error.message : String(error)}`,
					);
					return null;
				}
				await delay(RETRY_DELAY_MS * attempt);
			}
		}
		return null;
	}
}

/** A failure that retrying cannot fix, e.g. a misconfigured workflow state. */
class NonRetryableError extends Error {}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}
