# Project Buzz threads as two-tier Linear programs

A Buzz thread projects as a **program with work units**, amending
[0013](0013-front-cyrus-with-buzz-project-linear.md)'s one-issue-per-thread model: the
thread's issue is the program, each work unit a sub-issue owning one branch and one PR.
Two tiers only: Cyrus created the thread's issue and holds its id, so **binding the
parent needs no Linear read**, while Linear's *Project* tier is already the repo-routing
key. Three Linear reads sit on the execution path. Two are best-effort — the `projectKeys`
name→id lookup and each status write's issue-and-states re-read — but every `createIssue`
first resolves its team, and that one is not: a failure there costs the unit's issue and
leaves a half-created program.

- **Sub-issues are created in one batch at plan approval, never lazily.** 📝 stops meaning
  "just track it" and posts the slices, their rationale and the dependency edges as a
  *question*, not a gate (plan feedback is prose; gates refuse prose) — but with **no
  timeout, parking like a gate**, since defaulting into an option would commit the
  program's Linear write set unattended. Committing creates the program issue, *all*
  sub-issues and the edges as `blockedBy` relations. **Approval authorises the program**:
  one ▶️ releases it and units then advance on their own in dependency order, against the
  persisted work-unit map — the sole source of truth for the edges, so advancing adds no
  further Linear read and the relations are write-only. Cyrus stops to ask only when a unit
  fails, when every remaining unit is blocked, or when the plan is exhausted. Nothing
  self-promotes: a human wrote the plan, approved it, and released the gate; what follows
  is executing an approved plan, not conversation escalating unattended. A bare ▶️ skips
  the plan question and still mints **two**
  issues, a program and its one unit; 0013's single flat issue is superseded, not a
  degenerate case. A slice splits out only if it ships as its own reviewable pull
  request, is verifiable without its siblings, and needs no mid-flight operator decision.
- **Units run sequentially within a thread**: `BuzzActivitySink` posts flat, so parallel
  units destroy each other's prompts; setup scripts take a **global mutex**.
- **Branches keep the `BUZZ-xxxxxx-<slug>` prefix**, so creation needs no Linear write,
  and PR review routes into the originating thread with no `PR-<n>` session (one branch,
  one worktree, held by the unit's session). The Linear↔PR link is `Closes DEV-nnn` in
  the PR body — the only mechanism observed to work — prompt text a Buzz session cannot
  emit while its identity is the synthesized key: **the unit's Linear identifier must
  reach the session's prompt context**, and that plumbing, not a branch rename, is the
  work this creates.
- **Cyrus keeps writing In Progress and In Review**, merge→`Done` being the only
  integration write observed; closing the program stays a question to the human.
- **Thread state persists** into `~/.cyrus/state/edge-worker-state.json`: phase, program
  id, work-unit map, and per open prompt its event id, kind and options. Elicitations
  need a live SDK session and die loudly, so a thread hydrated in any phase but `triage`
  or `execute` **reverts to `triage`** and re-offers the gate on its next message:
  redoing a plan round trip is acceptable, a dead thread is not.

Rejected: lazy per-▶️ creation (Linear becomes a log, not a backlog); strict 1 thread : 1
PR; a second ▶️ implicitly promoting the thread's issue to a parent (the program tier
must be explicit); a gate per unit (seven releases for a seven-PR plan already approved,
and it needs a prompt-per-unit mechanism that does not exist — a settled prompt is deleted
and `phase` latches to `execute`); advancing by plain reply (typing, for the most repeated
act); hard-blocking the whole program on failure (some PRs float freely) and
never blocking (PR 6 runs after PR 5 died); a checkbox plan on the program issue (Linear
renders sub-issue progress; two sources drift); reading the edges back from Linear (a
third execution-path read, and the one that cannot be best-effort — a failure must run a
blocked unit or refuse every unit); a second per-thread state store, and re-deriving
state from Linear as the *only* mechanism (per [0012](0012-deepen-only-forced-seams.md),
whose failure mode is the bug it would fix); and a WIP cap of 3 across threads, from
`/bedtime`, **declined**.

## Consequences

- Per-unit naming is a real refactor: `sessionKey`, branch, worktree and the projection
  map are thread-keyed and must become unit-keyed under a thread-keyed session — a stage
  of its own, sequenced ahead of everything assuming many units per thread.
- Plan approval performs 1 + N awaited `createIssue` calls plus M relation writes in one
  queued task, none atomic, so units need a per-unit idempotency key or re-approval
  duplicates the survivors, and a Linear outage stalls the thread for its retry budget.
  Two capabilities are missing from `IIssueTrackerService`: it cannot write a `blockedBy`
  relation, and it cannot resolve a project name to an id — it exposes projects only on an
  already-fetched issue, which is how routing reads them today.
- Reaction delivery exists only on the **polling** ingress, so polling is load-bearing,
  webhook ingress is unsupported for gated threads, and re-arming after boot is
  at-least-once. `teamKeys` becomes a hard prerequisite of any repository hosting a
  thread, and the prompt-text link fails silently: units left non-terminal, `Done`
  reachable only by name.
- Also corrected from 0013: authz is not "a pubkey allowlist enforced in the transport
  through the existing `UserAccessControl` seam" but two independent plain allowlists,
  one per ingress, neither touching that seam; nor is Linear ingress demotable.
