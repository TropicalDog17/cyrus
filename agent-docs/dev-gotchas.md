# Development gotchas

Hard-won rules that cause silent breakage when skipped. Load when touching
config schema, sandbox/permissions, MCP tools, SDK upgrades, or routing prompts.

## Sandbox egress proxy and CA certificates

When sandbox is enabled, the egress proxy generates a CA cert at
`~/.cyrus/certs/cyrus-egress-ca.pem` for TLS interception. Per-session env vars
are set in `RunnerConfigBuilder.buildSandboxConfig()`:

- `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `SSL_CERT_FILE`,
  `REQUESTS_CA_BUNDLE` / `PIP_CERT`, `CURL_CA_BUNDLE`, `CARGO_HTTP_CAINFO`,
  `AWS_CA_BUNDLE`, `DENO_CERT`

**`systemWideCert` config flag:** When `sandbox.systemWideCert: true` is set in
`config.json`, those per-session CA env vars are skipped — the OS cert store
handles trust. Trust the CA system-wide first:

- macOS: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.cyrus/certs/cyrus-egress-ca.pem`
- Linux: `sudo cp ~/.cyrus/certs/cyrus-egress-ca.pem /usr/local/share/ca-certificates/cyrus-egress-ca.crt && sudo update-ca-certificates`

**Tools that ignore env vars** (need system keychain trust regardless of
`systemWideCert`): Bun, .NET/nuget, curl on macOS (SecureTransport).

**Parent process env gotcha:** If `GIT_SSL_CAINFO`, `SSL_CERT_FILE`, or
`CURL_CA_BUNDLE` are set in the Cyrus parent process env, they can break git
push/fetch from Cyrus itself (parent does not route through the egress proxy).
Do not set these in `~/.cyrus/.env`.

Pre-existing host `NODE_EXTRA_CA_CERTS` are merged via
`EgressProxy.buildCACertBundle()`.

## Two permission systems: tool vs sandbox

Claude Code security has two independent layers; both must be correct.

### A. Tool permissions (`allowedTools` / `disallowedTools`)

- Enforced by Claude Code's permission layer — **not** OS-level.
- `Read(~/**)` does **not** work as a `disallowedTools` pattern — `~` is never
  expanded, so the pattern matches nothing.
- `disallowedTools` is an instant deny that takes precedence over
  `allowedTools`.
- Absolute paths in tool patterns need a **double leading slash**:
  `Read(//Users/alice/.ssh/**)`. Implemented as `/${fullPath}` where `fullPath`
  is already absolute.
- Solution: `buildHomeDirectoryDisallowedTools(cwd, allowedDirectories)` in
  `packages/claude-runner/src/home-directory-restrictions.ts` enumerates home
  siblings with double-slash absolute paths and excludes `allowedDirectories`.

### B. Sandbox filesystem permissions

- Enforced at the **OS level** (bubblewrap / macOS sandbox).
- Deny+whitelist works: `denyRead: ["~/"]` + `allowRead: ["."]` (`.` = session
  cwd). Configured in `buildSandboxConfig()` in
  `packages/edge-worker/src/RunnerConfigBuilder.ts`.

**Invariant:** With sandbox enabled, both systems should restrict home directory
reads. With sandbox disabled, only tool permissions apply (and they need the
explicit enumeration above).

## Updating `@anthropic-ai/claude-agent-sdk`

After bumping the SDK (bundles a specific Claude Code version), refresh tool
allowance lists:

```bash
./scripts/extract-claude-tools.sh
```

Compare output to `availableTools` in `packages/claude-runner/src/config.ts`.
Also review `readOnlyTools`, `writeTools`, and helpers. Skipping this can cause
sessions to silently miss new tools or reference removed ones.

**The SDK pin, not `config.json`, decides which model version runs.** Cyrus
defaults to the *alias* `opus` (`RunnerSelectionService.getDefaultModelForRunner`),
and the alias table lives inside the bundled CLI binary — an SDK that predates a
release cannot reach it, whatever config says. Verify a bump landed the model, not
just the version string:

```bash
"$(ls ~/.local/share/pnpm/store/v10/links/@anthropic-ai/claude-agent-sdk-linux-x64/*/*/node_modules/*/claude | tail -1)" \
  --model opus --output-format stream-json --verbose -p ok | head -1
```

The `init` line's `model` field is the resolved id. Pinning a concrete id in
config instead pins the model *forever* — the alias is what tracks releases.

## Context compaction (`claudeAutoCompactWindow`)

The Claude CLI validates the setting as
`number().int().min(1e5).max(1e6).optional().catch(void 0)` — **any value outside
`[100_000, 1_000_000]` is silently discarded** and the session falls back to the
model's native window. `resolveAutoCompactWindow()` in `SessionOrchestrator` drops
an out-of-range window and warns, rather than tightening the Zod schema (which
would make an existing out-of-range `config.json` fail to parse).

The compaction threshold is
`min(nativeWindow, w) − min(maxOutputTokens, 20_000) − 13_000`, applied **before**
any model-specific branch — the model is irrelevant once the window is set. At
`w = 120_000` the threshold is ~87k. With `w` unset on `claude-opus-5` (1M native
window) it is ~967k, which a real session never reaches — so an unset window means
effectively no compaction on 1M-context models.

**`WarmSessionPool.warmup()` bypasses this entirely.** It builds its own `startup()`
options and never passes `settings`, so pre-warmed sessions ignore
`autoCompactWindow`. Only reachable when `CYRUS_ENABLE_WARM_SESSIONS` is set.
**Open bug — not yet fixed.**

## Cold-resume summarize-and-restart (`claudeColdResumeSummarizeThresholdTokens`)

Opt-in (unset = disabled). When a cold resume's estimated context exceeds the
configured threshold, `EdgeWorker.maybeSummarizeColdResume` replaces the oversized
`--resume` with a Haiku-summarized fresh session: it summarizes the prior transcript
(one-shot Haiku via `summarizeTranscript`) and seeds a new session with a
`<previous_session_summary>` prompt block instead of replaying the whole transcript
into prompt cache. The threshold has a hard floor (`MIN_COLD_RESUME_THRESHOLD_TOKENS
= 20_000`); a smaller configured value warns and disables the feature.

**Never break a resume that would otherwise succeed.** Every failure path — no
transcript found (`findTranscriptPath` returns null), estimate at/below threshold,
or `summarizeTranscript` throwing/timing out — returns `undefined` and falls through
to a normal resume.

**On success you must NOT clear `session.claudeSessionId`.** Two mechanisms depend on
it still being set at fresh-start time: runner pinning in `RunnerConfigBuilder`
(`input.session.claudeSessionId && runnerType !== "claude"` keeps the runner pinned
to `claude` even though we're building a "new" session), and the init-message rebind
in `AgentSessionManager.updateAgentSessionWithRunnerSessionId` (which overwrites
`claudeSessionId` with the *new* Claude session's ID once the fresh session
initializes). The trigger only sets the local `effectiveResumeSessionId = undefined`
(so the SDK doesn't `--resume` the giant transcript) and `buildAsNewSession = true`
(so the prompt gets the summary block) — it never touches `session.claudeSessionId`.

The transcript is located by scanning `~/.claude/projects/*/<sessionId>.jsonl`
(`findTranscriptPath`) rather than reconstructing the path from the cwd, because the
`projects/<slug>` directory name is derived from an undocumented cwd-sanitization
rule that has changed between Claude Code versions — a two-level scan is
version-proof.

## Transcript JSONL is camelCase, SDK messages are snake_case

The Langfuse exporter parses the transcript, not SDK messages. The transcript spells
compaction metadata `compactMetadata.{trigger, preTokens, postTokens, durationMs,
cumulativeDroppedTokens}` — **not** the SDK message's `compact_metadata.pre_tokens`.
Do not reuse SDK field names in transcript-parsing code.

## `SDKResultMessage.usage` / `total_cost_usd` are cumulative-per-process

The `result` message's `usage` (`NonNullableUsage`) and `total_cost_usd` are
running totals for the **entire query process**, not the last turn — the message
also carries a monotonically growing `num_turns`. A warm/streaming ClaudeRunner
(`keepSessionWarm`) emits one `result` per user turn *in the same process*, and
each repeats the process-cumulative figure (turn 2's `total_cost_usd` includes
turn 1). A cold resume spawns a fresh process, so its `result` reports only that
process's own usage starting from zero.

Consequence for per-session accounting: **accumulate deltas, do not sum raw
`result.usage`.** `AgentSessionManager` keeps a per-session baseline of the last
`result` cumulative and adds `current − baseline` to `metadata.cumulativeUsage`.
The baseline is reset in `updateAgentSessionWithRunnerSessionId` (fires on every
`system/init`, i.e. every new process) so a cold resume's first result deltas
from zero and a warm session's later results delta from the prior turn. Plain
summation would double-count every warm follow-up turn. `metadata.usage` /
`metadata.totalCostUsd` stay as the raw last-`result` value (unchanged behavior).

Determined from the `@anthropic-ai/claude-agent-sdk@0.3.185` `sdk.d.ts` result
shape (`num_turns` + `total_cost_usd` + cumulative `NonNullableUsage`); the
delta-with-per-process-reset scheme is correct for both the warm and cold paths.

## `ClaudeRunner.stop()` is a no-op before the runner starts

Calling `stop()` on a runner that has not started yet does nothing. Two concurrent
resumes therefore each build a runner and leave **two live subprocesses**, one
orphaned. `SessionOrchestrator.resumeSession` prevents this by serializing per
`sessionId` through a `resumeChains` promise map. Do not remove that serialization,
and do not skip the defensive `existingRunner.stop()` — it is the fallback for a
steer-only backend rejecting `addStreamMessage`.

## Routing behavior and self-describing prompts

When changing repository routing (description-tag syntax, label routing, base
branch overrides, multi-repo), also update the system prompts that describe
routing to Cyrus itself:

- `packages/edge-worker/src/PromptBuilder.ts` — `<repository_routing_context>`
- `packages/edge-worker/src/ActivityPoster.ts` — routing activity display names

(If a chat adapter or other surface documents routing syntax, update it in the
same PR.)

## Model precedence lives ONLY in `RunnerSelectionService`

`RunnerSelectionService.determineRunnerSelection(labels, description, opts?)` is
the single source of truth for which model (and fallback) a session runs on. It
folds every source into one ordered chain:

```
explicitModel = descriptionTag || modelLabel || opts.labelPromptModel || opts.repositoryModel
```

then resolves the runner from that, applies the runner-family conflict guard, and
returns `{ runnerType, modelOverride, fallbackModelOverride }`.

Do **not** re-add a `model || repository.model || default` chain anywhere
downstream. `RunnerConfigBuilder` used to carry exactly that fallback, but because
the service always returns a resolved `modelOverride`, the `|| repository.model`
arm was dead — `repository.model` never took effect (DEV-174 revived it by folding
it into `explicitModel` here and deleting the builder chain). The builder now just
passes `modelOverride`/`fallbackModelOverride` straight through. A second precedence
site will silently diverge from this one; keep it here.

The runner-family guard applies to both `labelPromptModel`/`repositoryModel` and
`repositoryFallbackModel`: an override whose inferred family (`composer-*`→cursor,
`gpt-*`/`o3`/`codex`→codex, `opus`/`sonnet`/`haiku`→claude) conflicts with the
already-resolved runner is dropped, not honored — we never switch runner families
mid-issue.

## Effort (`effort` / `claudeDefaultEffort`)

Reasoning effort is a **Claude-only** scalar (`low|medium|high|xhigh|max`) plumbed
separately from model. Resolution (narrowest scope wins) lives in
`SessionOrchestrator` (both `startSession` and `resumeSessionInner`):

```
effort = labelPrompt.effort ?? repository.effort ?? config.claudeDefaultEffort
```

It is set on `ClaudeRunnerConfig.effort` **only when `runnerType === "claude"`**
(guarded in `RunnerConfigBuilder`, same shape as `autoCompactWindow`), then spread
into the SDK query options in `ClaudeRunner`. There is no separate `thinking` knob —
`effort` already steers adaptive thinking. Unset means no `effort` is passed and the
SDK keeps its own default (`high`). Unsupported levels are silently downgraded by the
SDK, so an out-of-family value is harmless, not an error.

## Adding a new top-level `EdgeWorkerConfig` field

**Current (schema-driven `ConfigManager.reconcile`):** Adding a property to
`EdgeConfigSchema` in `packages/core/src/config-schemas.ts` is enough for
merge + change detection — `reconcile()` walks every schema key and emits
`changedKeys` from a generic diff. No separate merge whitelist / `globalKeys`
array.

Still required:

1. Add the Zod field (and regenerate JSON schemas if this repo exports them).
2. If the field is a **path** (string or path list), register it on
   `pathRegistry` in the same schema so `normalizeConfigPaths` expands `~/`.
3. Wire consumers that should react to the field (builders, runners, etc.).

**The field must also survive the CLI's config→worker hop.**
`WorkerService.startEdgeWorker` (`apps/cli`) builds the `EdgeWorkerConfig` that
`composeEdgeWorker` receives. It spreads `...edgeConfig` and overrides only the
runtime-owned keys — keep it that way. `apps/cli/src/services/WorkerService.test.ts`
enforces it: the fixture must enumerate every `EdgeConfigSchema.shape` key, so a
new field fails the suite until you decide whether the CLI forwards it.

**Historical note:** Pre-reconcile, a hardcoded `loadConfigSafely` whitelist and
`globalKeys` array silently dropped new fields on reload (CYHOST-967). Do not
reintroduce per-field merge lists. It recurred anyway: `WorkerService`'s
hand-written literal left `claudeAutoCompactWindow`, `claudeSessionKeepAliveMinutes`
and `claudeMaxWarmIdleSessions` inert in the shipped CLI, while `apps/f1` set them
directly on its own `EdgeWorkerConfig` and so kept "verifying" a path production
never takes (DEV-139).

## Changing `cyrus-tools` MCP exposed tools

When adding/removing a tool from the inline `cyrus-tools` MCP server
(`cyrus-mcp-tools`, wired in `McpConfigService.buildMcpConfig`):

- Update platform defaults in `packages/core/src/allowed-tools-defaults.ts` if
  the tool should be on by default.
- If the hosted product keeps a UI catalog (`KNOWN_MCP_TOOLS` / 
  `"mcp__cyrus-tools"`), update that catalog in the same change set so
  operators can see and toggle the tool. (Hosted app may live outside this
  monorepo.)

**Symptom:** Tool works at runtime but never appears in hosted settings.

## Deferring an MCP tool is a cost tradeoff, not just a context-size one (DEV-210)

The MCP tools block sits at the **head** of the cached prompt prefix. When a
deferred tool is pulled in mid-session via `ToolSearch`, the SDK injects its
schema at the head of the request's tools array — which invalidates the **entire
cached prefix** and forces a full rewrite at the 1h cache-creation rate (2x base
input). So:

- **Adding a tool schema mid-session invalidates the whole prompt cache.** A
  single deferred-then-needed tool can cost more than eager-loading it up front —
  in the DEV-210 trace, ~11x more.
- Therefore the defer-vs-eager decision is a **cost** tradeoff, not just a
  turn-1-context-size one. Defer a tool only if it is genuinely rarely needed;
  eager-load (`alwaysLoad`, see `McpConfigService.buildMcpConfig`) anything used
  on ordinary sessions. `linear` and `cyrus-tools` are both eager-loaded for this
  reason.
- `alwaysLoad` exempts a server from the SDK's auto tool-search mode **without**
  re-deferring the others, so eager-loading one more server does not re-trigger
  that mode. Trim an eager server's surface with `disallowedTools` (see
  `LINEAR_MCP_PRUNED_TOOLS`), never by deferring individual tools.
- Tell the model which surfaces are preloaded so it does not waste a turn running
  `ToolSearch` for already-loaded tools — see `MCP_PRELOAD_PROMPT_ADDENDUM` in
  `packages/edge-worker/src/prompts/mcpPreloadPromptAddendum.ts`.

## Adding a path-bearing field to `EdgeWorkerConfig`

cyrus-hosted emits self-host paths with literal `~/` prefixes. Node's
`fs.readFileSync` does **not** expand `~`.

**Current:** Path fields are normalized by `normalizeConfigPaths()` in
`cyrus-core`, driven by a Zod-4 `pathRegistry`. Tag the field at definition
time:

```ts
z.string().register(pathRegistry, { path: true })
// or path-list meta when applicable
```

`ConfigManager.reconcile` and the EdgeWorker constructor both run that walker.
A path field that is **not** registered will keep the literal `~/...` and crash
self-host with `ENOENT`.

## buzz-workflow cannot call a webhook on a Tailscale address

`call_webhook` runs `check_ssrf` (`crates/buzz-workflow/src/executor.rs`), which
resolves the target host and rejects it when `buzz_core::network::is_private_ip`
matches. That list includes **CGNAT `100.64.0.0/10`** — the range every
Tailscale address falls in. Redirects are disabled, so nothing about the request
can route around it.

Consequence: a relay that reaches Cyrus only over a tailnet can never drive
`BuzzEventTransport`, no matter how `CYRUS_BASE_URL` is set. The failure is
silent from Cyrus's side — the webhook simply never arrives, which looks exactly
like a misconfigured workflow.

**Rule:** `buzz.ingress` defaults to `poll` for this reason. Only set it to
`webhook` when Cyrus is reachable at a genuinely public address, and verify by
resolving the host **inside the relay container** (`docker exec <relay> getent
hosts <host>`) — Docker inherits the host's resolver, so MagicDNS names resolve
to `100.x` there even when public DNS returns a routable address.

## buzz-workflow templates do not escape JSON

`resolve_template` in `crates/buzz-workflow/src/executor.rs` substitutes
`{{trigger.*}}` by **raw string concatenation**. A `call_webhook` step whose
`body:` is a JSON template therefore emits invalid JSON the moment an
interpolated value contains a `"`, a `\` or a newline — which, for
`{{trigger.text}}` (a chat message), is constantly.

**Rule:** the Buzz webhook body carries only id-shaped scalars — 64-hex event
ids and pubkeys, a channel UUID, a unix timestamp. Message text is never
templated; `BuzzSessionCoordinator` reads it back from the relay by event id
via `buzz messages thread`. The canonical workflow definition lives at
`packages/buzz-event-transport/workflows/cyrus-trigger.yaml` and is the other
half of `BuzzWorkflowWebhookBody` — change them together.

Two related traps in the same executor:

- Unknown `{{keys}}` are emitted **literally**, not as an error. A typo in the
  workflow YAML arrives as the string `{{trigger.mesage_id}}`, so the transport
  shape-checks every field rather than trusting presence.
- `call_webhook` sets **no** `Content-Type` unless you list it under `headers:`,
  and sends no body at all when `body:` is omitted.

## Buzz: the binary is `buzz`, not `buzz-cli`

The crate is `buzz-cli`; the binary it produces is `buzz`
(`crates/buzz-cli/Cargo.toml` → `[[bin]] name = "buzz"`). Build with
`cargo build --release -p buzz-cli` and point `buzz.cliPath` at
`target/release/buzz`. Pointing it at `buzz-cli` fails with ENOENT at the first
reply attempt, long after startup.

Credentials are environment-only (`BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY`,
`BUZZ_AUTH_TAG`) — the keypair *is* the identity, there is no token or config
file. Message bodies go on **stdin** (`--content -`), never argv.

## Buzz Linear projections are created unassigned, and must stay that way

`BuzzLinearProjection.track()` calls `createIssue` with no `assigneeId`. That
is not an omission waiting to be tidied up: assignment and @mention are the
only two things that make Linear open an agent session, and Linear ingress
stays enabled alongside Buzz, so an assigned projection would immediately
trigger a *second* Cyrus session. Not on the same branch — a Linear-origin
session derives `DEV-nnn-<slug>` in `<base>/DEV-nnn/` while the Buzz one holds
`BUZZ-xxxxxx-<slug>` — which is worse: two worktrees doing the same work, both
able to open a PR. No config flag demotes Linear ingress, so the missing
`assigneeId` is the only thing standing between the projection and a
self-trigger loop.

**Rule:** never add `assigneeId` to anything the Buzz projection writes, and
never put an @mention of Cyrus in a projected description or comment body. If
a projection must be assigned, assign a human, and check first that the Linear
webhook path cannot read that write as a delegation.

Enforced by `BuzzLinearProjection.test.ts`, *"creates the issue unassigned"*,
which asserts the whole key set of the `createIssue` input rather than
`assigneeId === undefined` — the latter passes for an explicitly-undefined key,
which is one careless `?? assignee` away from a real id.

## The Buzz tool set, not the prompt, is the execution gate

The Buzz start path in `SessionOrchestrator` chooses `allowedTools` from the
thread's `BuzzSessionPhase`: the read-only preset
(`READONLY_DEFAULT_ALLOWED_TOOLS` plus `AskUserQuestion`, which the preset
omits and triage cannot work without) or the repository's full set. That
selection is the gate — a triage run that decides to "just fix it" still
cannot reach `Edit`, `Write` or general `Bash` — so the prompt is a courtesy
and the tool set is the enforcement.

The trap is which way the condition is written. `BuzzSessionPhase` is a
two-member union (`triage | execute`), so testing for `triage` and falling
through to the full set was equivalent *only while that stayed true*: a third
phase — a plan phase, a review phase — would land in the fall-through branch
and be handed write access silently, with no test failing, which is precisely
the defeat the gate exists to prevent. The condition is therefore positive on
`execute` and the read-only preset is the fall-through, so anything that is not
`execute` is read-only by construction.

**Rule:** keep the test positive on `execute`. Never rewrite it as a negative
test against the phases that happen to exist, and when widening
`BuzzSessionPhase` (`SessionOrchestrator.ts`) or `BuzzThreadContext.phase`
(`BuzzSessionCoordinator.ts`), leave
`SessionOrchestrator.buzz-tools.test.ts` — which drives a phase value the union
does not admit and expects the read-only set — passing rather than adapting it.
Its sentinel is `__not_a_phase__` for that reason: a realistic name (`planning`,
`review`) becomes an admitted member the day someone adds it, and the case then
degenerates into a duplicate of the triage one while still passing green.

## One branch cannot be in two worktrees — Cyrus shares one instead of failing

`GitService.provisionSingleRepoWorktree` checks, when the branch already
exists, whether it is checked out somewhere else (`findWorktreeByBranch`) and
if so **returns that other worktree** — "Branch … is already checked out in
worktree at …, reusing existing worktree" — with no `setupPath`, so setup
scripts do not re-run either. Git would reject a second `worktree add` for one
branch; Cyrus never sees that error because it hands back the first tree.

For Buzz this is load-bearing. A Buzz session holds its work unit's branch in
its own worktree, so a `PR-<n>` session for the same branch does not get a
tree of its own: it gets the Buzz session's, and two sessions then edit the
same files with no lock. Nothing errors; it looks like an agent undoing its
own work.

**Rule:** do not mint a second session for a branch some session already
holds — route PR review back into the originating session — and never infer a
fresh workspace from having asked for one.

## Buzz thread state is restored late, and a parked gate saves itself

Two invariants that both fail silently, in opposite directions.

`start()` calls `loadPersistedState()` long before `initializeComponents()`
builds the Buzz coordinator, so `restoreMappings` cannot hand it anything: it
parks `state.buzz` in `persistedBuzzState` and `registerBuzzEventTransport`
drains it through `hydrateBuzzThreads()`. Hydrating inside `restoreMappings`
compiles, runs, logs nothing and restores nothing. The same field is why
`serializeMappings` writes the parked state back when Buzz is unconfigured —
one restart with `buzz` removed from config must not erase every thread's
phase, program issue and worktree.

The other direction is the gate. A Buzz turn saves at both ends
(`SessionOrchestrator.startBuzzSession`), but the gate is posted and armed
*after* that turn returns, and the thread's next turn only happens once the
gate resolves — so nothing would ever write an open gate to disk.
`offerGate` therefore calls `deps.saveState()` itself, and without it a boot
finds no `openPrompt` to re-arm while the message sits in the scrollback
collecting reactions that go nowhere.

Un-parking has the same shape and is easier to miss: `applyGateDecision`
records the projected program on the context, and on the `track` branch it then
returns without ever running a turn. Without its own save, the only record on
disk is still the pre-decision one — gate open, no program — so a restart
re-arms an answered gate, the reaction the human already pressed re-delivers
(the poller's `seenReactions` is empty after a boot) and `track()`, whose dedupe
map is in memory, projects a *second* program issue. It saves right after the
decision, before either branch's relay and Linear round trips.

Hydration has its own ordering rule. `hydrateBuzzThreads()` does not await
`coordinator.hydrate()` — a relay that is down would otherwise hold up the
whole worker's startup — and the polling ingress starts a few lines later in
the same function. What makes that safe is that `hydrate` puts *every* thread
into its map before its first `await` (resuming a lost question posts to the
relay, up to the CLI's 30s timeout). Move a thread's restore after that await
and a message arriving mid-hydration misses the map: it is read as a new
thread, cuts a second worktree, and the next save serializes the half-filled
map over the threads still waiting to be restored.

A thread whose repository is not in the config is *parked*, not dropped:
`serialize()` writes parked records back verbatim. `isActive: false` and a
CYHOST push that transiently omits a repository are both reversible, and this
record is the only place the thread's phase, program issue and worktree exist.

**Rule:** state owned by a component built in `initializeComponents` is
restored where that component is constructed, not in `restoreMappings`. And
whenever a Buzz thread parks on — or un-parks from — something a human answers
later, save at that moment: the turn's own saves have already happened, or have
not happened yet. Never make a persisted Buzz thread disappear because
something it references is momentarily absent.

## `postToSink` silently drops activities without `externalSessionId`

`AgentSessionManager.postToSink` returns early when
`session.externalSessionId` is unset, so a session can have a perfectly good
`IActivitySink` registered and still post nothing. Linear sessions reuse their
own session id; every other platform must pass `externalSessionId` explicitly
to `createCyrusAgentSession` (Buzz passes the thread root event id).

This is why the GitHub PR path's `setActivitySink` call has never actually
posted anything — GitHub gets its output from the one-shot `postGitHubReply`
instead. Do not "fix" that by widening the platform check without also deciding
what a GitHub activity stream should address.

## Navigating GitHub source when auth blocks

Use `uuithub.com` instead of `github.com` for unauthenticated source browsing:

```
https://uuithub.com/org/repo/blob/main/src/file.ts
```

## Working with package SDKs

```bash
pnpm install
```

Then inspect the package under `node_modules` for types and implementation.

## Testing Linear MCP (claude-runner)

```bash
cd packages/claude-runner
echo "LINEAR_API_TOKEN=..." > .env
pnpm build
node test-scripts/simple-claude-runner-test.js
```

EdgeWorker configures the official Linear HTTP MCP server per repository using
its Linear token in real sessions.
