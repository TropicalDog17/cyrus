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
`w = 120_000` the threshold is ~87k. With `w` unset on `claude-opus-4-8` (1M native
window) it is ~967k, which a real session never reaches — so an unset window means
effectively no compaction on 1M-context models.

**`WarmSessionPool.warmup()` bypasses this entirely.** It builds its own `startup()`
options and never passes `settings`, so pre-warmed sessions ignore
`autoCompactWindow`. Only reachable when `CYRUS_ENABLE_WARM_SESSIONS` is set.
**Open bug — not yet fixed.**

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
