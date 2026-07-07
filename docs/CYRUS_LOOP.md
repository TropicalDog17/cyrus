# Cyrus compounding loop

This fork embeds a compounding **Verify → blind-gate → Learn** loop (`packages/cyrus-loop`, ported
from the Python `agentic-pipeline`). It reacts to Cyrus's own events — no polling — and turns every
gated PR into a labeled row in `runs.jsonl` plus, on a recurring finding, a durable failure rule.

## What it does

1. **Capture** (`prOpened`) — when Cyrus opens/updates a PR, the loop captures the diff and runs the
   mechanical evidence ledger (tests / lint / build / typecheck / diffscan), then runs a
   citation-locked judge and stores its verdict **hidden**.
2. **Blind gate** (`sessionComplete`) — when the session ends, the loop posts a review to Linear
   carrying **only the diff + the ledger** (never the judge's opinion), and asks for a human verdict.
3. **Verdict** — a human replies on the Linear issue with a command (below). Only an **approved**
   human verdict authorizes the merge (`gh pr merge`). Every gated run — approved or not — is
   appended to `runs.jsonl`; recurring findings become failure rules the next run loads as context.

The judge is **advisory**: its verdict is revealed only *after* the human records theirs (so it can
be scored, never so it can influence the human), and a judge failure never blocks the gate.

## Recording a verdict (Linear comment)

Reply to the gate comment on the issue with one of:

```
/approve                 # merge the PR
/reject                  # do not merge
/rework                  # needs a follow-up issue
```

Optionally add findings on their own lines (only `recurring` and `one-off` tags are accepted):

```
/reject
- missed null check :: recurring
- nit: rename var :: one-off
```

A `recurring` finding compounds into a rule in the repo's `failures/<repo>.md`.

## Configuration — `~/.cyrus/loop.json`

The loop reads its **own** config file (kept separate from `~/.cyrus/config.json`). Every field is
optional; the defaults below apply when the file is absent. Override the path with
`CYRUS_LOOP_CONFIG`.

```json
{
  "enabled": true,
  "repos": [],
  "judge": { "enabled": true, "model": "claude-opus-4-8", "maxTokens": 2048 },
  "mergeMethod": "squash",
  "autoMerge": true,
  "deleteBranch": false
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; `false` makes the loop ignore every event. |
| `repos` | `[]` | Allowlist by Cyrus repo `name`/`id`. Empty ⇒ **all** repos. |
| `judge.enabled` | `true` | Run the (advisory, hidden) judge on capture. |
| `judge.model` | `claude-opus-4-8` | Anthropic model for the judge backend. |
| `judge.maxTokens` | `2048` | Judge response budget. |
| `mergeMethod` | `squash` | `squash` \| `merge` \| `rebase` for `gh pr merge`. |
| `autoMerge` | `true` | On an approved verdict, merge automatically. |
| `deleteBranch` | `false` | Pass `--delete-branch` to `gh pr merge`. |

## Requirements

- **`gh`** authenticated in the repo — for diff capture and merge.
- **`ANTHROPIC_API_KEY`** — for the judge only. Absent ⇒ the judge is skipped (logged), the gate
  still posts and the human verdict still authorizes the merge.
- The loop is **GitHub-only** in this fork.

## Data layout

Loop state lives under `~/.cyrus/loop/` (override with `AGENTIC_PIPELINE_DATA`):

```
~/.cyrus/loop/
  runs.jsonl            # the labeled dataset (one line per gated run)
  diffs/<run_id>.diff   # captured diff
  ledgers/<run_id>.jsonl# mechanical evidence
  gates/<run_id>.*.json # blind-gate human/judge verdicts (judge hidden until reveal)
  failures/<repo>.md    # compounded failure rules loaded as context
```

Run ids are `<YYYY-MM-DD>-<ISSUE>-pr<N>` (e.g. `2026-07-05-DEV-123-pr7`).
