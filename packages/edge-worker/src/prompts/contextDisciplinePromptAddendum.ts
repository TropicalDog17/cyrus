/**
 * Single source of truth for the context-discipline guidance appended to every
 * customer-facing Claude system prompt.
 *
 * Why this exists: the dominant cost driver on long Cyrus sessions is the volume
 * of accumulated conversation context that is re-sent on every turn. The
 * structural fix is early auto-compaction (`EdgeWorkerConfig.claudeAutoCompactWindow`
 * → SDK `settings.autoCompactWindow`). This addendum is the *behavioral* comple-
 * ment: a short nudge to avoid needlessly growing that context (redundant
 * re-reads, whole-file reads where a range/grep suffices) and to prefer scoping
 * genuinely oversized work rather than ballooning one session.
 *
 * The delegation lines exist because re-read discipline alone is demonstrably
 * insufficient: a traced session still read one file 13 times, largely to recover
 * context after an auto-compact — a case the "still in this conversation" clause
 * does not even cover, since the compact had already evicted the file. Sweeping
 * many files into the main thread is what makes the context large in the first
 * place; a subagent (spawned via the `Agent` tool) does that reading in its own
 * context and returns only the conclusion. Note the tool is `Agent`, not the
 * older `Task` name — naming a tool that does not exist would be worse than
 * saying nothing.
 *
 * Deliberately terse. Every token here is paid on every turn of every session,
 * so a long lecture would work against the very cost goal it serves. Claude Code
 * already has strong read-discipline instincts; this only reinforces them and
 * makes the scoping and delegation options explicit.
 *
 * Updating this constant is the only place we need to change to evolve the
 * context-discipline policy across all Claude surfaces.
 */
export const CONTEXT_DISCIPLINE_PROMPT_ADDENDUM = `
<context_discipline>
Keep the working context lean — on long sessions the accumulated conversation is
re-sent every turn, so needless growth is the main driver of cost and latency.

- Reuse what you have already read; do not re-read a file whose contents are
  still in this conversation unless you have reason to believe it changed.
- Prefer targeted reads (a line range, or a grep/search) over reading an entire
  large file when you only need part of it.
- After you edit a file, trust that the edit applied — do not re-read it just to
  confirm, unless a later step actually depends on the new contents.
- When answering a question needs a sweep across many files — reconnaissance,
  tracing a call path, "where does X live" — delegate it with the Agent tool and
  ask for a compact answer with file:line references, rather than reading each
  file into this conversation. Read directly the files you are about to edit.
- After an auto-compact, re-orient with one delegated search rather than serially
  re-reading the files you had already read before the compact.
- If a task is genuinely too large to complete well in one focused session, it is
  fine to say so and propose splitting it into smaller scoped issues rather than
  attempting everything in one ever-growing session.

This is about avoiding *wasted* work, not about cutting corners: read whatever you
genuinely need to do the task correctly.
</context_discipline>
`.trim();

/**
 * Append the context-discipline addendum to a system prompt fragment,
 * normalizing spacing so the boundary doesn't collide with prior content.
 */
export function appendContextDisciplineAddendum(
	existing: string | undefined | null,
): string {
	const base = (existing ?? "").trimEnd();
	if (base.length === 0) return CONTEXT_DISCIPLINE_PROMPT_ADDENDUM;
	return `${base}\n\n${CONTEXT_DISCIPLINE_PROMPT_ADDENDUM}`;
}
