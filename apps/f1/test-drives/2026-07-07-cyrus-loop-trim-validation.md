# Test Drive: Compounding-loop wiring + lean-fork trim validation

**Date**: 2026-07-07
**Goal**: Validate (a) the trimmed fork (Linear + GitHub + Claude only) still boots and
processes issues, and (b) the compounding Verify → blind-gate → Learn loop is wired end-to-end.
**Scope**: Lane B (trim: removed gemini/codex/cursor runners, simple-agent-runner, gitlab/slack
transports) + Lane C (loop wiring: `prOpened`/`sessionComplete`/`verdictReached` bus events →
`CyrusLoopAdapter` → `cyrus-loop`).
**Test Repo**: F1 rate-limiter scaffold (`init-test-repo`).

---

## Part 1 — Trimmed product boots & serves (live F1)

Booted the F1 server (`bun run server.ts`, `platform: "cli"`) against a freshly scaffolded
rate-limiter repo and exercised the CLI over RPC.

### EdgeWorker startup (trimmed) — from the server log
- [x] Server started on `http://localhost:3458`; `SharedApplicationServer listening`
- [x] `✅ CLI RPC server registered` (`/cli/rpc`)
- [x] `✅ CLI event transport registered` (AgentSessionCreated listener)
- [x] `GitHub event transport registered (proxy mode)` — **GitHub mirror intact**
- [x] `✅ Config updater registered` — **kept per the locked decision**
- [x] `Cyrus tools MCP endpoint registered`, status + version endpoints registered
- [x] **No** gemini/codex/cursor/gitlab/slack references anywhere in startup
- [x] **No** `⚠️ Failed to attach compounding loop` warning → the loop adapter attached cleanly

### CLI / RPC / issue tracker
- [x] `f1 ping` → `Server is healthy`
- [x] `f1 status` → `Status: ready`, `Server: CLIRPCServer`
- [x] `f1 create-issue` → created `issue-1` / `DEF-1` via the in-memory tracker

**Conclusion:** Lane B's removals + Lane C's wiring did not break server startup, the RPC
surface, the GitHub transport, config-updater, or the issue tracker.

> Environment note: this host has no `ANTHROPIC_API_KEY`, so a live Claude *session* (worktree →
> subroutines → commit → PR) was not run here. The Claude-session path is unchanged by this work
> (Lane B only removed the non-Claude runners; the Claude runner and its wiring are untouched). To
> run the full live drive where a key is available, follow the protocol in `apps/f1/CLAUDE.md`
> (`create-issue` → `start-session` → observe subroutines → `git log`).

---

## Part 2 — Compounding loop, end-to-end (deterministic)

The loop's forge/LLM edges (`gh`, Anthropic, the git worktree, Linear) are all injectable, so the
**full** loop is proven deterministically by
`packages/edge-worker/test/CyrusLoopAdapter.integration.test.ts` — driving the real
`CyrusLoopAdapter` + `CyrusLoop` through the EdgeWorker bus with a fake host + fake tracker. (F1's
in-memory repo has no GitHub remote, so real-`gh` capture/merge cannot run inside an F1 drive; this
test is the rigorous substitute.)

### Cases (all green)
- [x] **Approved path**: `prOpened` → capture diff + ledger + run the citation-locked judge and
      store its verdict **hidden**; nothing posted, `runs.jsonl` not yet written → `sessionComplete`
      → **blind gate** comment posted to the tracker (ledger surfaced, judge structure never leaks)
      → `/approve` prompt intercepted → `gh pr merge` (merge fact written) → run appended to
      `runs.jsonl` as `merged` with `diff_gate.verdict = approved`; `verdictReached` emitted +
      confirmation comment posted.
- [x] **Rejected path**: `/reject` + `- missed null check :: recurring` → **no** merge; run recorded
      as `abandoned`; the recurring finding compounds into a durable failure rule.
- [x] **Non-verdict prompt** (`"hey can you also add logging?"`) → interceptor returns `false`
      (a normal Claude session would run); nothing recorded.
- [x] **Verdict for an issue with no pending gate** → ignored (`false`).
- [x] **Non-GitHub PR** (`provider: "gitlab"`) → not captured; no gate posted.

Plus `packages/cyrus-loop` unit coverage (225 tests) for the ported pipeline and
`CyrusLoopAdapter`/`PrMarkerHook` unit tests in edge-worker.

---

## Results

| Check | Result |
|---|---|
| Trimmed F1 server boots (Linear + GitHub + Claude only) | ✅ |
| CLI ping / status / create-issue over RPC | ✅ |
| Loop adapter attaches without error | ✅ |
| Full loop (capture → blind gate → verdict → integrate → learn → `runs.jsonl`) | ✅ (integration test) |
| `pnpm build` + `pnpm typecheck` (12 projects) | ✅ |
| `pnpm test:packages:run` | ✅ |

## Reproduce

```bash
# Trimmed product boot + CLI (Part 1)
cd apps/f1
./f1 init-test-repo --path /tmp/rate-limiter-test
CYRUS_PORT=3458 CYRUS_REPO_PATH=/tmp/rate-limiter-test bun run server.ts &
CYRUS_PORT=3458 ./f1 ping && CYRUS_PORT=3458 ./f1 status
CYRUS_PORT=3458 ./f1 create-issue --title "…" --description "…"

# Deterministic full-loop proof (Part 2)
pnpm --filter cyrus-edge-worker test:run CyrusLoopAdapter
pnpm --filter cyrus-loop test:run
```
