# Deepen only forced seams

When refactoring for modularity, Cyrus deepens a seam into a real abstraction
only when **two or more concrete instances already exist** to force its shape;
a single-instance seam is held nominal (kept reachable, not abstracted). This
is the rule that arbitrates the standing tension between "make it easy to add
new patterns" and this codebase's YAGNI discipline: the agent/runner seam has
four instances (Claude, Cursor, Codex, Pi) and is *overdue* for a profile registry,
while the issue-tracker seam has one real instance (Linear) and must **not** grow
a general "any tracker" framework until a second real tracker forces it.

## Consequences

- Phase B of the modularity program is size-reduction and un-nesting of
  single-instance code, **not** new abstractions.
- Reviewers (human or agent) get a one-line test to reject speculative
  generality: "how many real instances force this seam?" Fewer than two → don't
  build it.
- The explicit no — we do not abstract the issue-tracker interface now — is the
  valuable part; it stops the next contributor from "helpfully" adding a plugin
  layer with one caller.
