# F1 Test Drive — `compact_boundary` visibility + `claudeAutoCompactWindow` semantics

**Date:** 2026-07-10
**Branch:** `feat/compact-boundary-visibility`
**SDK:** `@anthropic-ai/claude-agent-sdk@0.3.185`
**Motivation:** Langfuse trace `cyrus-7bc9d05d-…` (DEV-130) showed a resumed session running five turns at 249–257k context with `claudeAutoCompactWindow: 120000` live and no visible compaction. Cyrus dropped the SDK's `compact_boundary` message, so there was no way to tell whether the knob was working.

## Setup

Scaffolded repo (`./f1 init-test-repo`) plus four generated `src/generated/policy_table_*.ts` files (~1700 long lines each, ~140k tokens per file) so a session can grow its context on demand. F1 server run with the new `CYRUS_AUTOCOMPACT_WINDOW` env gate; model left at the F1 default (`sonnet`).

Note: F1's default repo config has no matching routing labels, so `start-session` posts a repository-selection elicitation. Answer it with `./f1 prompt-session --message "F1 Test Repository"` before the agent runs.

## Results

### 1. The knob works — but only inside the SDK's accepted range

Three arms, same workload (chunked `Read` calls, 150 lines each), measuring the transcript's `compact_boundary` records:

| `autoCompactWindow` | Peak context | Compactions | `preTokens` → `postTokens` |
|---|---|---|---|
| `40000` | 153,945 | **0** | — |
| `100000` | 57,819 | 1 | 70,521 → 15,134 |
| `1000000` | 164,000 | **0** | — |
| `40000` (one huge read) | 164,972 | 1 | 182,062 → 20,681 |

The `40000` arm reached **3.8×** its window without compacting. The fourth arm compacted only at 182k — ≈91% of Sonnet's native 200k window, i.e. default behavior, not the knob.

**Root cause**, from the CLI binary's own schema:

```js
autoCompactWindow: H.number().int().min(1e5).max(1e6).optional().catch(void 0)
```

`min(100000)`, `max(1000000)`, and `.catch(void 0)` — an out-of-range value **fails validation and is silently discarded**. Cyrus's schema was `z.number().int().positive()`, so it happily accepted values the SDK would throw away. Fixed by `resolveAutoCompactWindow()` in `SessionOrchestrator`, which drops an out-of-range window and logs a warning instead of letting an operator believe a dead knob is capping their costs.

`settingsAutoCompactWindow` was confirmed present in Cyrus's sanitized query-options log for every arm, so the value reached the SDK; the SDK is what discarded it.

### 2. The SDK **does** compact when resuming an over-window conversation

This was the open question. Resuming a session whose transcript already exceeded the window:

| Model | Window | Resumed context | Result |
|---|---|---|---|
| `sonnet` | 100,000 | 156,460 | compacted → 4,684 |
| `claude-opus-4-8` | 120,000 | 164,272 | compacted → 2,710 |

Both emitted `status: compacting` → `compact_boundary` → `status: null`, and the resumed turn wrote ~18–20k cache-creation tokens instead of the full 156–164k. So an in-range window collapses the resume-rewrite cost, and it does so on Opus with a 1M-token context window, not just on Sonnet.

### 3. Message shape: two spellings, both now handled

- **In-stream SDK message:** snake_case — `compact_metadata.{trigger, pre_tokens, post_tokens, duration_ms}`. This is what `claude-message-projection.ts` maps.
- **Transcript JSONL:** camelCase — `compactMetadata.{trigger, preTokens, postTokens, durationMs, cumulativeDroppedTokens}`. This is what `langfuse-exporter.ts` reads (verified against 12 real records).

The plan assumed snake_case in both places; the transcript check caught it before it shipped.

### 4. Ordering (for the status-thought dedup)

Observed on every compaction: `status: "compacting"` → `compact_boundary` → `status: null`. The boundary lands before the status clears, so `AgentSessionManager`'s `compactBoundaryPostedBySession` flag reliably suppresses the vaguer "Conversation history compacted" thought in favor of the one carrying token counts.

## Still open

DEV-130's tail is **not** explained by the range bug: its window (`120000`) is in range, and the deployed build (`0.2.66+386e1cd`, built `2026-07-09T15:40:30Z`) contains the forwarding code — turns 143–147 ran ~52 minutes after that deploy. On this drive the same value compacts an Opus resume at 164k. Whatever suppressed it there is still unaccounted for; the `compact_boundary` activity added in this PR is the instrument needed to settle it on the next long live session.

One latent bypass worth noting: `WarmSessionPool.warmup()` builds its own `startup()` options and never passes `settings`, so a pre-warmed session would ignore `autoCompactWindow` entirely. Not the cause here (`CYRUS_ENABLE_WARM_SESSIONS` is unset on this deployment), but it will bite whenever warm sessions are turned on.
