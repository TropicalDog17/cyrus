/**
 * Identity for the work units of a Buzz thread's program.
 *
 * A thread is one conversation and several pieces of work (ADR 0014): the
 * conversation stays thread-keyed — every unit's activity threads back under the
 * same root event — while execution is unit-keyed, one branch, one worktree and
 * one agent session each. That makes identity two-level, and this module is the
 * only place the two levels are related.
 *
 * The first unit deliberately carries **no** suffix: it reuses the thread's own
 * `BUZZ-xxxxxx` key, its branch and its worktree. A thread that was live before
 * work units existed keeps the branch a human already has checked out and the
 * agent session it was talking to, so nothing on disk has to be migrated and no
 * shipped thread changes shape. Tidying it into `-u1` would rename every live
 * worktree and split each thread's session in two.
 */

/** Position of the first work unit, which *is* the thread's own identity. */
export const FIRST_UNIT_INDEX = 1;

/**
 * The `-u<n>` suffix naming every unit after the first.
 *
 * Safe to strip as well as to append: a thread's key is `BUZZ-` plus hex and its
 * session id is `buzz-` plus a 64-character hex event id, neither of which can
 * end in `-u<digits>`. So the suffix is present exactly when a unit put it
 * there.
 */
const UNIT_SUFFIX = /-u(\d+)$/;

/** The synthesized key naming a unit's branch, worktree and agent session. */
export function unitKeyFor(sessionKey: string, index: number): string {
	return index <= FIRST_UNIT_INDEX ? sessionKey : `${sessionKey}-u${index}`;
}

/** A unit's branch: its key, then a slug of its own title. */
export function unitBranchNameFor(unitKey: string, title: string): string {
	return `${unitKey}-${slugify(title)}`;
}

/**
 * The session a unit executes under.
 *
 * Derived from the unit's key rather than from its position in the program: the
 * key is the persisted record, plan order is not. A key with no suffix is the
 * thread's first unit and runs *as* the thread's session, which is what lets a
 * pre-two-tier thread resume the conversation it already had.
 */
export function unitSessionIdFor(
	threadSessionId: string,
	unitKey: string,
): string {
	const suffix = UNIT_SUFFIX.exec(unitKey);
	return suffix ? `${threadSessionId}-u${suffix[1]}` : threadSessionId;
}

/**
 * Inverse of {@link unitSessionIdFor}: the thread a session belongs to.
 *
 * Total over any session id — a thread's own id maps to itself — so everything
 * keyed on threads (the question handler, the reply router, the projection)
 * widens to units without branching on whether a unit is involved.
 */
export function threadSessionIdOf(sessionId: string): string {
	return sessionId.replace(UNIT_SUFFIX, "");
}

/** Branch-safe slug of a title, bounded so a branch name stays readable. */
export function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 30) || "thread"
	);
}
