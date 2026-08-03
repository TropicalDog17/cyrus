# Close assignments from observed facts

Cyrus holds an **assignment lease** for every OMP (deterministic-closure) issue
session: a typed record that says which PR candidate the assignment is
currently pointing at, what the gate has observed, and — above all — whether
the assignment is still Cyrus's to work. A lease is released only by a
host-observed fact, never by model text and never by a runner success.

## Vocabulary

- **Assignment lease** — the typed state machine (per Issue/repository) that
  tracks one unreleased unit of work from acquisition to merge, escalation, or
  needs-input release.
- **Candidate head** — the PR head SHA the lease currently points at. All
  approval/gate activity is bound to this SHA; a push advances it.
- **Closure fact** — a durable, validated artifact (`agentic-pipeline`'s
  `.pr.json`, `.human.json`, `.integrate.json`, `.abandoned.json`) that drives
  a lease transition.
- **Gate finding** — a tagged finding from a human review (`TEXT::recurring` /
  `TEXT::one-off`), recorded through the pipeline's `gate human`.
- **Needs input** — a host-recorded `request_user_input` elicitation: the
  lease is released, the worktree and runner session identity are retained,
  and a later answer reacquires the lease.
- **Escalation** — a host-observed `/reject`, `/escalate`, or external
  stop/cancel of a live assignment, recorded as a fact before the lease is
  released.

## Release facts

The only facts that release a lease:

1. a host-recorded needs-input request (released pending the user's answer),
2. a host/user escalation (rejected, escalated, externally stopped), or
3. a **successful merge** — validated `integrate.json` says `merged: true` for
   the same run/PR/head the lease points at.

Model text and runner success are **never** closure facts: OMP's successful
`session/prompt` result ends the Prompt turn, not the assignment (ADR 0016's
isolated-host model makes each turn a fresh process; the assignment continues
until a merge fact lands). A human `approved` verdict is not a release either —
it authorizes `integrate run`, and the merge fact is what closes.

## Authority split

- **`agentic-pipeline`** is the authority for capture, blind gate, supersession
  (head-SHA drift archives stale verdicts), integration, and learning artifacts.
- **Cyrus** is the authority for the lease lifecycle, needs-input elicitation,
  and the Linear projection — it consumes validated pipeline facts and never
  writes gate files itself.

## Consequences

- `AgentSessionManager.completeSession` stops releasing assignments: after a
  runner success it posts the result/usage, tears down the runner process,
  retains the session/worktree/profile identity, and moves the lease to
  `awaiting_pr`.
- `needs-rework` resumes the SAME OMP profile/session with the tagged findings;
  a fresh harness session is never created for remediation.
- A push to the candidate head invalidates all SHA-A approval/gate activity
  (the pipeline's `supersede_verdict` reopens the gate); stale-SHA approvals
  can never merge.
- External `Done`/`Canceled` or unassignment events still stop work, but record
  a host escalation/cancellation fact before releasing a live lease.
