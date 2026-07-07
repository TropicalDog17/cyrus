# Plan: Port the compounding pipeline into the Cyrus fork (TS) + trim Cyrus lean

## Context

The `agentic-pipeline` (Python, uv/DSPy) wraps Cyrus as an *opaque* executor: Linear as
queue, `~/.cyrus/config.json` read-only, `gh` PR polling for the verify trigger. The
pipeline's compounding loop (Verify → blind gate → Learn, on a `runs.jsonl` substrate)
is not yet running.

Decision taken by the user: **permanently fork Cyrus and rebuild the brain in TypeScript
inside the fork** (0 Python at runtime). This removes the language boundary and the poll,
and lets the loop react to Cyrus events directly. Two workstreams:

- **Workstream L (Loop)** — port `pipeline/*.py` → a new `packages/cyrus-loop` TS package,
  wired to EdgeWorker via events (`prOpened`, `sessionComplete`) instead of a `gh` poll.
- **Workstream T (Trim)** — reduce the fork to **Linear + GitHub + Claude** by deleting the
  gemini/codex/cursor runners, gitlab/slack transports, simple-agent-runner, and
  (optionally) config-updater.

The two workstreams are designed to run in parallel with minimal file contention (see
Lane structure). This document is the execution spec for a multi-agent run: every task is
bite-sized, has explicit file ownership, dependencies, and acceptance criteria.

---

## Locked decisions

1. **Brain in TS, inside the fork.** New package `packages/cyrus-loop`. No Python at runtime.
2. **Events, not polling.** `prOpened` + `sessionComplete` emitted on the EdgeWorker bus
   replace `pr_watch.py`'s `gh pr list` loop. The *capture* logic (diff + ledger + supersede
   + `should_capture` idempotency) is ported and driven by the event.
3. **Separate config file `~/.cyrus/loop.json`.** Read independently by the loop package —
   avoids the 2-site `ConfigManager` merge-whitelist / `globalKeys` churn
   (`ConfigManager.ts:200-263` and `:339-363`).
4. **Judge = raw `@anthropic-ai/sdk`** (`^0.105.0`, already in tree) `messages.create` with a
   tool schema — NOT `ClaudeRunner`/agent-SDK. Keep the deterministic citation-locked
   validator regardless of backend.
5. **DSPy deferred.** It is runtime-inert and gated behind ≥30–50 labeled runs. Runtime =
   versioned prompt files (`prompts/scope-v1.md`, `judge-v1.md`) + the ported validator.
   When volume arrives, add a **hand-rolled BootstrapFewShot-lite in TS** (inject top-K
   high-agreement examples) — no DSPy, no Python. Out of scope for this plan.
6. **The code + `docs/DELTAS.md` win over `DESIGN.md`** wherever they disagree (run_id has
   `-pr<N>`; `judge_eval` has the two `cv_*` cells; gate is pre-merge; rework = flat label +
   `relatedTo` relation; budgets advisory-only).

---

## Target architecture

```
Cyrus fork (TS, trimmed)                         packages/cyrus-loop (TS, new)
  Linear webhook → route → worktree → Claude
  PrMarkerHook ──emit prOpened──────────────▶  onPrOpened: capture diff+ledger, run judge
  AgentSessionManager.completeSession                     store judge verdict (hidden)
        └──emit sessionComplete────────────▶  post BLIND gate to Linear (elicitation)
                                              collect human verdict (prompted webhook)
  gh pr merge  ◀──on approved verdict──────  reveal → derive judge_eval → append runs.jsonl
                                              learn: findings → failures.md rules
  reads: injected IIssueTrackerService, RepositoryConfig, worktree path
  own state: ~/.cyrus/loop.json, data/runs.jsonl, data/ledgers, data/gates, failures/
```

---

## Workstream L — Python → TS port map

Legend: **Faithful** = replicate logic + invariants exactly (port the Python tests too).
**Adapted** = the loop is *inside* Cyrus now, so replace external plumbing with injected
Cyrus services. **Dropped** = superseded by events / in-process access.

| Python module | TS module (`packages/cyrus-loop/src/`) | Mode | Risk | Notes |
|---|---|---|---|---|
| `paths.py` | `paths.ts` | Faithful | Low | `RUN_ID_RE`, `parseRunId`/`makeRunId`; env `AGENTIC_PIPELINE_DATA` → loop data dir |
| `schema.py` + `schemas/*.json` | `schemas.ts` (zod) | Faithful | Med | Keep **regex patterns, not `.datetime()`/format**. Zod is source of truth (repo already uses zod). Provide `canonicalStringify` (sorted keys) to match Python `sort_keys=True` bytes |
| `config.py` | `config.ts` | Adapted | Low | `js-yaml` for `route.yaml`/`budgets.yaml`; path-keyed cache |
| `append_run.py` | `runLog.ts` | **Faithful** | **HIGH** | The durability core. See L2 for the flock/fsync/newline-guard/torn-tail design |
| `spec.py` | `spec.ts` | Faithful | Low | Section parse, `filesExpected` (path-looking bullets only), `acceptance` |
| `prompts.ts` | `promptVersion.ts` | Faithful | Low | Frontmatter wins over inline `<!-- version -->`; **missing tag throws** |
| `route.py` | `route.ts` | Faithful | Med | Decision table (first-match), chore rule predicates, concrete-target regex + `_NOT_TARGETS` denylist; `estimate==null` → feature; diff gate always manual |
| `context.py` | `context.ts` | Faithful | Low | Content-hash pin (first 8 hex sha256); `_global.md` only for **non-work** repos |
| `budgets.py` | `budgets.ts` | Faithful | Low | Advisory only; missing datum ≠ exceedance |
| `ledger.py` | `ledger.ts` | Faithful | **HIGH** | Process-group kill on timeout; E4 warn-never-fail; empty `filesExpected`→pass; retry-append never truncates; sha256; git diff via `--relative` |
| `judge.py` | `judge.ts` | Faithful | Med | Citation-locked validator + `deriveJudgeEval` matrix + raw-SDK backend. Any dangling/missing citation → whole response forced `cannot-verify` |
| `gate.py` | `gate.ts` | Faithful | Med | Blind protocol: `wx` (O_EXCL) human verdict; reveal throws before human file; `storeJudgeVerdict` re-validates; supersede archives; `head_sha` binding |
| `learn.py` | `learn.ts` | Faithful | Med | Three-way finding routing; rule-id mint+append under one lock; `crosscheckGate` refuses on mismatch/missing; prompt-version stamped from live files; rework backfill (latest-by-run_id) |
| `metrics.py` | `metrics.ts` | Faithful | Med | Confusion matrix; keep `_PRIMARY`/`_VANITY`/`_SEPARATE` names; `specEditDistance` needs a SequenceMatcher equivalent → use npm `difflib` |
| `integrate.py` | `integrate.ts` | Faithful | Low | `gh pr merge --squash`; **human `approved` alone authorizes** (never `judge_eval`); SHA-drift guard; merge fact |
| `pr_watch.py` | `capture.ts` | Adapted | Med | Keep `shouldCapture`/supersede/`captureEvidence`; **drop the `gh pr list` poll** — driven by `prOpened` |
| `cyrus_adapter.py` | (folded into loop) | Adapted | Low | Loop has `RepositoryConfig` directly. Keep only `repo_tiers.json` side-file + `tierFor` |
| `linear.py` | `linearConventions.ts` | Adapted | Low | Keep `classifyComment`, label constants, rework `relatedTo` args. GraphQL fetch → injected `IIssueTrackerService` |
| `ghselect.py` | — | Dropped* | — | Cyrus already resolves gh tokens (`resolveGitHubToken`, 3-tier). Port only if multi-account fleet needed |
| `dspy_stub/` | — | Dropped | — | Runtime-inert; deferred (decision 5) |

New npm deps for `packages/cyrus-loop`: `zod` (have), `@anthropic-ai/sdk` (have), `js-yaml`,
`difflib`, `proper-lockfile`. Dev: `vitest`.

---

## Lane structure (for multi-agent parallelism)

Three lanes. **Lane A touches only new files → zero contention → start immediately and run
the whole time. Lanes B and C both edit `EdgeWorker.ts` / `RunnerConfigBuilder.ts` /
`config-schemas.ts`, so B must finish its EdgeWorker edits before C starts** (avoids merge
hell). Critical path = B(EdgeWorker trims) → C(wiring). Lane A is the bulk of the work and
overlaps everything.

```
Lane A (Loop core, new package)   ─────────────────────────────────▶  [ready to wire]
   L0 scaffold → L1 foundation → L2 runLog → L3 determ. → L4 ledger → L5 judge/gate/learn → L6 metrics/integrate/capture

Lane B (Trim, existing files)     ──────────────▶  [EdgeWorker slimmed]
   T1 runners → T2 simple-agent → T3 gitlab → T4 slack → T5 config-updater(opt) → T6 lock/schema regen

Lane C (Wiring, existing files)                      ────────────▶  [end-to-end]
   (waits on B's EdgeWorker edits + A's CyrusLoop)   W1 events → W2 prOpened emit → W3 sessionComplete emit → W4 CyrusLoop consumer → W5 gate-via-Linear → W6 F1 e2e
```

Recommended agent assignment: **1 agent on Lane A** (or split A into A-core + A-glue across 2
agents after L2), **1 agent on Lane B**, **Lane C by whichever frees up first** once B's
EdgeWorker edits and A's `CyrusLoop` skeleton exist.

---

## Lane A — Loop core (new package, no contention)

Each Ln task: port the named Python module(s) + port their pytest cases to vitest. The
Python tests encode the invariants — porting them is how we prove faithfulness.

### L0 — Scaffold `packages/cyrus-loop`  *(deps: none)*
- `package.json` (name `cyrus-loop`, deps above), `tsconfig.json` (extend `tsconfig.base.json`),
  `vitest` config, `src/index.ts`, add to `pnpm-workspace.yaml`.
- Copy `prompts/scope-v1.md`, `prompts/judge-v1.md`, `templates/failures.md`,
  `config/route.yaml`, `config/budgets.yaml` into the package (or a `~/.cyrus/loop/` runtime dir).
- **Accept:** `pnpm --filter cyrus-loop build && test` runs green (empty).

### L1 — Foundation: `paths.ts`, `schemas.ts`, `config.ts`, `promptVersion.ts`  *(deps: L0)*
- `RUN_ID_RE = ^(\d{4}-\d{2}-\d{2})-([A-Za-z][A-Za-z0-9]*-\d+)(?:-pr(\d+))?$`; `parseRunId` throws on malformed.
- Zod schemas for runs / ledger / judge — **copy the regexes verbatim** from `schemas/*.json`
  (ISO-8601 pattern, `^E[0-9]+$`, `^[a-f0-9]{64}$`, run_id/issue_id patterns). `additionalProperties:false` → `.strict()`.
- `canonicalStringify(obj)` = JSON with recursively sorted keys + `\n` (matches Python `sort_keys=True`).
- `promptVersion`: frontmatter `version:` wins over `<!-- version: X -->`; missing → throw `MissingPromptVersion`.
- **Accept:** validate `examples/runs.jsonl.example` (copied) passes; malformed run_id throws; missing prompt version throws.

### L2 — `runLog.ts` (the durability core)  *(deps: L1)* — **HIGH RISK, do carefully**
Design (single-writer discipline; all writers are the one Cyrus process + occasional CLI):
- **Mutex:** in-process async mutex serializes appends within the process; `proper-lockfile`
  advisory lock as the cross-process belt-and-suspenders for CLI invocations.
- **Append:** validate-before-lock → `canonicalStringify` (assert single line) → open
  `r+`/append fd → under lock: **newline-guard** (if size>0 and last byte ≠ `\n`, write `\n`
  first) → single `write` → `fs.fsyncSync`. Document that Node lacks `F_FULLFSYNC` (macOS
  gets drive-cache fsync only) — acceptable, note it.
- **Read:** `readRuns({skipInvalid})` — tolerate a **torn last line** (warn+skip); **mid-file
  corruption throws** `ValueError`-equivalent. Schema-invalid lines throw unless `skipInvalid`.
- **`updateRun`:** stage full rewrite to fsync'd sibling `.rewrite.tmp`, then truncate+rewrite
  **in place on the same inode** under lock, fsync, unlink tmp on success only (never
  rename-over — a blocked appender's fd would orphan).
- **`repairRuns`:** quarantine bad lines to `<file>.corrupt`, rewrite survivors in place.
- **Accept (port these tests):** `torn_last_line_tolerated`, `midfile_corruption_raises`,
  `torn_fragment_then_append_not_silently_lost`, `repair_quarantines_corrupt_midfile_line`,
  concurrent-append no-interleave (spawn N async appends, assert N valid lines).

### L3 — Deterministic nodes: `spec.ts`, `route.ts`, `context.ts`, `budgets.ts`, `linearConventions.ts`  *(deps: L1)*  — parallelizable sub-tasks
- `route.ts`: decision table first-match; chore rule (repo∉work_repos, ¬multi_repo,
  `chore`∈labels, ≤50 words, concrete-target); `estimate==null`→feature; **diff gate always manual**.
  Port the concrete-target regex battery + `_NOT_TARGETS` denylist + backtick-bypass exactly.
- `context.ts`: `AGENTS.md` first; ensure+include repo `failures/<repo>.md`; `_global.md`
  **only for non-work repos**; content-hash pin.
- `budgets.ts`: advisory; missing value/cap ≠ exceedance.
- `linearConventions.ts`: `classifyComment` (edit checked first), label constants
  (`chore`,`PRD`,`Orchestrator`,`rework-of`), `reworkSaveIssueArgs` (flat label + `relatedTo`
  relation, **not** a colon label).
- **Accept:** port `route.py`/`context.py`/`budgets.py`/`spec.py` tests; the chore-rule truth
  table and concrete-target/denylist cases must pass verbatim.

### L4 — `ledger.ts` (EvidenceLedger)  *(deps: L1, L3-spec)* — **HIGH RISK**
- Class replays prior entries (no truncate on construct), `attempt = max(prior)+1`,
  `_nextId = E{n+1}` stable/monotonic; append under lock + schema-validate.
- `runCommand`: `spawn(cmd,{shell:true, detached:true})`; timeout → `process.kill(-pid,'SIGKILL')`
  (process-group); `exit=null,result='fail'`, preserve last partial line; exit 127 flagged.
- `diffscan` (E4): **warn** if any changed file ∉ filesExpected; empty filesExpected → **pass**.
- `mechanicalResult`: latest-attempt command kinds only; skip if none; warn/diffscan never gate.
- git via `--relative`; `diffStatsFromFile` counts +/- only inside `@@` hunks; `sha256()`.
- `resolveBaseRef`: try `base` then `origin/<base>` (worktree has only remote-tracking).
- **Accept:** port ledger tests, incl. no-truncate-on-construct, warn-never-fails-exit-code,
  empty-filesExpected→pass, timeout-kills-group.

### L5 — `judge.ts`, `gate.ts`, `learn.ts`  *(deps: L2, L4)* — sequential (learn depends on gate+judge)
- `judge.ts`: `validateJudgeOutput(raw, citableIds)` — force `cannot-verify` on
  invalid_json / not_an_object / schema_violation / ungrounded_citation (evidence not in the
  run's real ledger ids) / pass_without_claims / fail_without_concerns. `deriveJudgeEval`
  matrix (with the two `cv_*` cells); CLI rejects unknown verdicts via enum. Backend =
  `new Anthropic().messages.create({tools:[judgeSchema], tool_choice})`; keep validator regardless.
- `gate.ts`: `reviewPackage` structurally excludes judge; `recordHumanVerdict` via `wx`
  (O_EXCL, `force`→`w`); `reveal` **throws if human file absent**; `storeJudgeVerdict`
  re-validates against ledger; `supersedeVerdict` archives (never deletes); `head_sha` binding.
- `learn.ts`: three-way finding routing (new rule / `rule_ineffective` / `matched_rule_not_loaded`);
  `appendRule` mints id **and** appends under one lock; `crosscheckGate` calls `reveal` and
  refuses append on any mismatch **or missing value**; stamp prompt versions from live files;
  `backfillRework` filters merged + latest-by-run_id; `record` sequence exactly as spec.
- **Accept:** port judge/gate/learn tests — especially `reveal_refused_before_human`,
  `review_package_never_contains_judge`, `store_judge_verdict_revalidates_ungrounded`,
  `record_twice_refused_without_force`, the finding `TEXT::TAG` rpartition parse, and the
  judge-eval matrix.

### L6 — `metrics.ts`, `integrate.ts`, `capture.ts`  *(deps: L5)*
- `metrics.ts`: keep exact metric names/denominators (`missed_fail_rate_PRIMARY`,
  `raw_agreement_VANITY`, `waiting_minutes_p50_SEPARATE`); `specEditDistance = 1 −
  difflib.SequenceMatcher(word-level).ratio()` via npm `difflib`; `_pct` linear-interpolated.
- `integrate.ts`: human `approved` alone authorizes (never `judge_eval`); require `.pr.json`;
  SHA-drift guard via `gh pr view headRefOid`; `gh pr merge`; write merge fact.
- `capture.ts`: `shouldCapture` (locked / superseded / already-captured via `.pr.json`
  written-last); `captureEvidence` (real worktree else ephemeral `git worktree add --detach`,
  else `gh pr diff` fallback=mechanical-skip); supersede archival. **Trigger = `prOpened`
  event payload**, not a poll.
- **Accept:** port metrics/integrate tests; `capture` unit-tested with a fake event payload.

---

## Lane B — Trim to Linear + GitHub + Claude (dependency-ordered)

Do these in order; each ends with `pnpm build && pnpm typecheck` green. This lane owns
`EdgeWorker.ts`, `RunnerConfigBuilder.ts`, `RunnerSelectionService.ts`, `config-schemas.ts`,
`allowed-tools-defaults.ts` — Lane C must not touch those until B is done.

### T1 — Remove gemini / codex / cursor runners  *(deps: none)*
- Unwire `EdgeWorker.ts`: imports L22/L81/L82; `createRunnerForType` cases L5405–5410;
  session-detection branches L5901–5915; narrow the runner-type union at L5393.
- `RunnerConfigBuilder.ts`: session-id→runnerType overrides L339–353; L456–457 (cursor apiKey);
  L471 (codex sandbox); `runnerSupportsManagedSkills` L502–503 → claude-only.
- `RunnerSelectionService.ts`: collapse L36–284 to claude-only (this file exists mostly to
  choose between 4 runners).
- `config-schemas.ts:6` narrow `RunnerTypeSchema` to `["claude"]`; drop
  `geminiDefaultModel`/`codexDefaultModel`/`cursor*` (L350–360), `defaultRunner` optional stays.
- Drop the 3 deps from `edge-worker/package.json`; delete the 3 packages.
- Rewrite/trim `EdgeWorker.runner-selection.test.ts` (33KB, the highest-friction test).
- **Accept:** build + typecheck green; claude sessions still start in F1.

### T2 — Remove `simple-agent-runner`  *(deps: T1)*
- Orphan after T1. Delete package; optionally drop `core/src/simple-agent-runner-types.ts` +
  its `index.ts:274–276` re-export.
- **Accept:** build green; no dangling imports.

### T3 — Remove `gitlab-event-transport`  *(deps: none; parallel with T1)*
- `EdgeWorker.ts`: remove import block L108–126; delete GitLab cluster
  (`registerGitLabEventTransport`, `handleGitLabWebhook` 1987–2259, `findRepositoryByGitLabUrl`,
  `createGitLabWorkspace`, `buildGitLabSystemPrompt`, `buildGitLabChangeRequestSystemPrompt`,
  `postGitLabReply` → through ~2497), fields L218/L223, constructor L366–382, start() L839.
- Drop `sessionPlatform "gitlab"`, session-source branch L5919, `GITLAB_BOT_USERNAME` prompt
  bits, `gitlabUrl` config (`config-schemas.ts:281`), cli `SelfAddRepoCommand` gitlab handling.
- Delete package + dep. **Keep the entire GitHub mirror.**
- **Accept:** build green; GitHub PR flow intact.

### T4 — Remove `slack-event-transport` + chat cluster  *(deps: none; widest blast radius)*
- `EdgeWorker.ts`: import L139–142; Slack/chat methods (`isSlackThreadFollowingEnabled`,
  `registerSlackEventTransport` 1064–~1182, `dispatchChatTestEvent`, `listChatThreads`,
  `getChatThreadLastReply`, chat bits in `computeStatus`/`stop`/`getAllChatSessions`), fields
  L219/L220, config L315, start() L840.
- Delete `SlackChatAdapter.ts`, `ChatSessionHandler.ts`, `ChatRepositoryProvider.ts` +
  `index.ts:19–20` re-export.
- `allowed-tools-defaults.ts`: drop `mcp__slack` (L85–90), `SLACK_ALLOWED_TOOLS` (L94–137),
  `"slack"` from `AllowedToolsPlatform` (L215/L226). `config-schemas.ts`: drop `slackAllowedTools`,
  `slackMcpConfigs`, `slackThreadFollowing`.
- Unwire **cli** `WorkerService.ts:10,148–159` and **f1** `server.ts:32,322–338`.
- Delete package + deps (edge-worker, cli, f1). Delete `chat-sessions.test.ts` +
  `RunnerConfigBuilder.chat-config.test.ts`; scrub chat refs from other tests.
- **Accept:** build + typecheck green; F1 issue flow intact.

### T5 — Remove `config-updater` (OPTIONAL)  *(deps: none)*
- Only needed for remote/hosted config push. Unwire `EdgeWorker.ts:23,225,843–850,2629` and
  cli `WorkerService.ts:87–103`; delete package + deps.
- **Skip if** you want to keep hosted-config compatibility. **Keep `cloudflare-tunnel-client`**
  — `getCyrusAppUrl()` is imported unconditionally in EdgeWorker + 3 cli commands; removing it
  needs a refactor with poor ROI for a local fork.

### T6 — Lockfile + schema regen  *(deps: T1–T5)*
- `pnpm install` to regenerate `pnpm-lock.yaml`; run `core`'s `generate:json-schema` so the
  committed `core/schemas/` reflects the narrowed `RunnerTypeSchema` (else it drifts).
- **Accept:** `pnpm build && pnpm typecheck && pnpm test:packages:run` green; `pnpm audit` clean.

---

## Lane C — Wire the loop into Cyrus  *(deps: Lane B EdgeWorker edits done; Lane A ≥ L0)*

### W1 — Add loop events to the bus  *(deps: T1–T4)*
- `packages/edge-worker/src/types.ts:7-44` — add to `EdgeWorkerEvents`:
  `prOpened: (p: {issueId, issueIdentifier, repoId, worktree, prNumber, provider}) => void`,
  `sessionComplete: (p: {issueId, repoId, worktree, status, prNumber?}) => void`,
  `verdictReached: (p: {runId, verdict}) => void`.
- **Accept:** typecheck green; events declared.

### W2 — Emit `prOpened` from the PR-marker path  *(deps: W1)*
- `hooks/PrMarkerHook.ts`: change `PrMarkerProvider.ensureMarker` to return `{number}|null`
  (it already reads `payload.number`/`iid` at L81/L124–136). Add an `onPrOpened?` callback to
  `buildPrMarkerHook` (currently logger-only, L176–212); fire it after ensureMarker succeeds
  (L198–199) with `{prNumber, cwd}`.
- `RunnerConfigBuilder.ts:312`: pass session context (`input.session.issueId`,
  `issue?.identifier`, `input.repository.id`, `input.session.workspace.path`) + an emit ref so
  the callback carries full payload. Emit on the EdgeWorker bus.
- **Accept:** F1 drive with a stubbed `gh pr create` triggers exactly one `prOpened` with
  correct payload.

### W3 — Emit `sessionComplete`  *(deps: W1)*
- `AgentSessionManager.completeSession` (`AgentSessionManager.ts:348-411`) has `issueContext`,
  `repositories`, `workspace.path`, and resolved terminal status (L365–369). Add a
  `sessionComplete` to `AgentSessionManagerEvents` ({} today, L44), emit at ~L410, and
  re-emit on the EdgeWorker bus (instance at `EdgeWorker.ts:464`). `prNumber` comes from state
  stashed by W2 (keyed by issueId/worktree).
- **Accept:** F1 drive emits one `sessionComplete` per finished session with the right status.

### W4 — `CyrusLoop` consumer + `loop.json`  *(deps: W2, W3, Lane A L6)*
- New `CyrusLoop` class (in `cyrus-loop` or a thin `edge-worker` adapter) constructed right
  after `new EdgeWorker(config)` at `WorkerService.ts:269`, mirroring
  `setupEventHandlers()` (`WorkerService.ts:287-314`). Subscribes:
  `onPrOpened → capture.captureEvidence → judge.run → gate.storeJudgeVerdict`;
  `onSessionComplete → post blind gate`.
- Reads `~/.cyrus/loop.json` independently (decision 3). Injects the workspace's
  `IIssueTrackerService` (via `edgeWorker` accessor) for Linear writes.
- **Accept:** on a simulated PR-open, a ledger + hidden judge verdict land on disk; no
  `runs.jsonl` write yet (that's post-gate).

### W5 — Blind gate over Linear + verdict collection  *(deps: W4)*
- Post the gate as a **`createAgentActivity` elicitation** with `AgentActivitySignal.Select`
  (pattern in `AskUserQuestionHandler.ts:201-209`); the review body carries **diff + ledger
  only** (never the judge). Collect the human verdict from the **prompted webhook**
  (dispatch chain `EdgeWorker.ts:5081-5092`, verdict text at `:4806`).
  - The loop fires *after* the session ends, so it drives its **own** elicitation/observation
    rather than the in-session `AskUserQuestion` path. Simplest robust option: the loop
    registers its own Fastify route on `getSharedApplicationServer().getFastifyInstance()`
    **before** `edgeWorker.start()` (pattern at `f1/server.ts:309-311`) to receive the verdict,
    OR observes the prompted webhook. Decide in W5.
  - **Label creation gap:** `IIssueTrackerService` has no `createIssueLabel`. Gate labels
    (`chore`, `rework-of`) must pre-exist (resolve by name via `fetchLabel`) or the loop holds
    its own `LinearClient` to call `createIssueLabel` / uses the `mcp__linear-server__create_issue_label` tool.
- On `approved` → `integrate.integrateRun` (`gh pr merge`) → `learn.record` → `runLog.append`.
- **Accept:** end-to-end on real Linear (or F1 CLI tracker): gate posts blind, verdict
  recorded before reveal, approved merges, `runs.jsonl` gets one valid line.

### W6 — F1 end-to-end validation  *(deps: W5)*  — **required before merge (CLAUDE.md mandate)**
- Use the F1 harness (`apps/f1`, `platform:"cli"`, `CLIIssueTrackerService`): `init-test-repo`
  → start server → `create-issue` → `start-session` → let it open a PR (or stub the emit) →
  answer the gate via `prompt-session`/`create-comment` → assert merge + `runs.jsonl` line +
  a failure rule appended on a `recurring` finding.
- **Accept:** documented F1 test drive in `apps/f1/test-drives/` proving the full loop.

---

## Cross-cutting invariant checklist (acceptance gate for the whole port)

These MUST survive the port (each maps to a ported test):

- [ ] `runs.jsonl`: validate-before-lock; single-writer; newline-guard; torn-last-line
      tolerated; **mid-file corruption fatal**; `updateRun` in-place same-inode; `repair` quarantines.
- [ ] Blind gate: human verdict via O_EXCL (no silent overwrite); **reveal throws before human
      file exists**; review package structurally excludes judge; `storeJudgeVerdict` re-validates;
      superseded verdicts archived; verdict bound to `head_sha`.
- [ ] Judge: only real ledger ids citable; any dangling/missing citation → whole response
      `cannot-verify`; pass needs a claim, fail needs a concern; `cannot-verify` first-class.
- [ ] `judge_eval` derived from the (judge × human) matrix incl. `cv_on_pass`/`cv_on_fail`;
      cv cells excluded from fail-recall denominator.
- [ ] Learn: rule ids minted+appended under one lock; three-way finding routing; `crosscheckGate`
      refuses on mismatch or missing value; prompt versions from live files; rework latest-by-run_id.
- [ ] Ledger: E4 warns-never-fails; empty filesExpected → pass; retry-append never truncates;
      latest-attempt-scoped mechanical; process-group kill on timeout.
- [ ] Route: deterministic only; multi-repo + work-repo fences; estimate-absent → feature; diff
      gate always manual; concrete-target denylist honored.
- [ ] Context: `_global.md` never loaded for work repos; content-hash pinning.
- [ ] Integrate: only human `approved` authorizes (never `judge_eval`); `.pr.json` required;
      SHA-drift refusal; merge fact written.
- [ ] Prompt files carry a parseable version tag (else throw).

---

## Verification

- **Per module:** port the corresponding pytest to vitest; `pnpm --filter cyrus-loop test:run`.
- **Trim:** after each T-task `pnpm build && pnpm typecheck`; after T6 `pnpm test:packages:run`
  + `pnpm audit` clean.
- **End-to-end:** the W6 F1 test drive (mandatory per CLAUDE.md's testing protocol).
- **Byte-parity spot check:** feed `examples/runs.jsonl.example` through `readRuns` and re-serialize
  a record with `canonicalStringify`; compare to the Python `sort_keys=True` output.

---

## Risks & open decisions

1. **`runLog.ts` durability (L2)** — highest-risk port. Node lacks `F_FULLFSYNC`/native `flock`.
   Decision to confirm during L2: `proper-lockfile` + in-process mutex + `fsyncSync` (recommended,
   document weaker macOS durability) vs. a native `flock` addon. Since the loop is one process,
   the in-process mutex carries most of the safety.
2. **Gate verdict transport (W5)** — reuse the in-session elicitation path vs. a loop-owned
   Fastify endpoint. Lean toward the loop-owned endpoint (the gate fires post-session).
3. **Linear label creation** — no `createIssueLabel` on `IIssueTrackerService`; pre-create labels
   or give the loop its own `LinearClient`.
4. **DSPy / optimizer** — deferred; when ≥30–50 labeled runs exist, add TS few-shot-lite. The
   `spec_edit_distance` `difflib` dependency must match Python's SequenceMatcher values.
5. **`cloudflare-tunnel-client` stays** — `getCyrusAppUrl` coupling makes removal low-ROI.

## Suggested kickoff

Start Lane A (L0→L1→L2) and Lane B (T1‖T3‖T4) simultaneously with separate agents. L2 and T-EdgeWorker
edits are the two things to get right before anything downstream. Lane C begins once B's
EdgeWorker edits land and A reaches L6.
