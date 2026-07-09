# CONTEXT — cyrus domain & architecture glossary

This file names the seams in cyrus so architecture reviews and design work share
one vocabulary. Architecture terms (**module**, **interface**, **seam**,
**adapter**, **depth**, **leverage**, **locality**) are used per the
`/codebase-design` vocabulary. Domain terms below name the good seams.

## Domain terms

- **Issue** — a unit of work from an issue tracker (today: Linear; partially GitHub).
- **Session** — one agent run against an Issue, in an isolated git worktree.
- **Runner** — an adapter over an agent CLI (Claude Code, Cursor) that streams messages.
- **Activity** — a thought / action / response / error posted back to the Issue timeline.
- **AgentMessage** — the **neutral** streaming message contract runners emit (see below).
- **Effective access policy** — the single computed answer to "what may this session
  read/write", rendered into both the tool-permission layer and the OS sandbox layer.

## Seam inventory (target decomposition of EdgeWorker)

EdgeWorker today is a 6,759-line god object across 12 axes of change. It decomposes
into these deep modules (★ = new extraction, ○ = exists, being deepened/injected):

| Module | Interface (small surface) | Behind the seam |
|---|---|---|
| **ConfigManager** ○ | `reconcile(prev, disk) → { merged, changedKeys, repositoryChanges }` + `configChanged` event | schema-driven merge, change detection, path normalization |
| **AgentMessage** ★ (core) | neutral discriminated union + `IAgentRunner.provider` | frees runners from impersonating the Claude SDK type |
| **ActivityMapper** ★ | `map(msg: AgentMessage, ctx) → Activity[]` (pure) | the single per-tool render table; no session state |
| **AccessPolicy** ★ | `compute(input) → EffectiveAccessPolicy` + `toClaudeToolPatterns / toSandboxFilesystem / toCursorPermissions` | one policy, three adapters |
| **PromptAssembler** ★ | `assemble(input) → { userPrompt, systemPrompt?, metadata }` | the one owner of "the prompt"; the tested contract goes public |
| **SessionOrchestrator** ★ | `startSession(req)` / `resumeSession(id, prompt)` | runner creation + message wiring |
| **WarmSessionPool** ★ | `acquireWarm(criteria)` / `warmup(...)` / `release(...)` | warm reuse; warmup calls AccessPolicy (no hand re-derivation) |
| **ParkedSessionRegistry** ★ | `park(id, reason)` / `wake(id)` / `isParked(id)` | block/park/wake state machine |
| **WebhookRouter** ★ | `dispatch(webhook)` | created-vs-prompted, mention-vs-delegation, stop, pending-selection branching |
| **CyrusToolsHost** ★ | `mount()` / `getUrl()` / `createToolsOptions(session)` | in-process cyrus-tools MCP + request context |
| **EdgeWorker** ○ | thin coordinator; injected collaborators; `composeEdgeWorker(config)` composition root | wiring only, no business logic |

Existing injected collaborators kept as-is: RepositoryRouter, GitService,
AttachmentService, UserAccessControl, PersistenceManager, McpConfigService,
ToolPermissionResolver, EgressProxy, SharedApplicationServer, AgentSessionManager
(shrinks to session-state store + message ingestion once ActivityMapper lands).

## Frozen decisions

### #1 ConfigManager (schema-driven reconciliation)
- **Uniform nullish merge** over every `EdgeConfigSchema` field: `merged[k] = disk[k] ?? current[k]`.
  Deletes the 19-field merge whitelist. Legacy renames (`defaultModel → claudeDefaultModel`)
  stay as a tiny explicit migration map.
- **Generic diff → `changedKeys: Set`** replaces the hardcoded `globalKeys` array;
  `configChanged` fires when `changedKeys` or `repositoryChanges` is non-empty. This also
  makes `userAccessControl` changes actually detectable (they were dead before).
- **`reconcile()` owns path normalization**; path fields are tagged colocated on the field
  via a typed Zod-4 registry (`pathRegistry`), at top-level and per-repo schema. Deletes
  `normalizeConfigPaths` and the 3× `resolvedRepo` blocks; a new path field can't bypass it.

### #3 Neutral AgentMessage
- Define `AgentMessage` in `cyrus-core` as a neutral discriminated union (system/init,
  assistant[text|thinking|tool_use], user[tool_result], result[success|error]+usage,
  rate_limit) — **not** `= SDKMessage`. Includes a `thinking` block (fixes Cursor data loss).
  Neutral `usage` shape (no Anthropic cache-bucket fields → Cursor stops counterfeiting).
- Add `readonly provider: 'claude' | 'cursor'` to `IAgentRunner` — deletes the
  `constructor.name` sniff and the session-id-field reverse-derivation.
- `AgentRunnerConfig` neutral base; `ClaudeRunnerConfig`/`CursorRunnerConfig` extend it —
  removes the `& Record<string, unknown>` escape hatch.

### #4 ActivityMapper
- Pure `map(msg, ctx) → Activity[]`; the per-tool render table lives here only.
  Cursor stops projecting to Claude-shaped tool_use; the two runner formatters' per-tool
  blocks fold in. `MapContext` carries the tool-use lookups the old switch read from state.
- The **4 parallel activity-post paths collapse to one** `IActivitySink.post()`.
  ActivityPoster's genuine formatters (repo-setup-hook, sudo hint, label-role) stay but
  route through the sink.

### #2 AccessPolicy
- `compute(input) → EffectiveAccessPolicy` with injected `homeDir` + `dirLister`
  (deterministic; no hardcoded `readdirSync(homedir())`).
- Three render adapters; **cold (ClaudeRunner.start) and warm (WarmSessionPool) paths call
  the same compute+adapter** — closes the warmup drift hole. Cursor's un-enforceable
  `denyRead` is surfaced/logged, not silently dropped.

### #5 PromptAssembler
- `assemble()` moves off EdgeWorker's private method onto PromptAssembler; its public
  interface **is** the tested `PromptAssemblyResult` contract. Tests drop `(worker as any)`
  and mock the real `IIssueTrackerService`. Component builders fold in from EdgeWorker +
  PromptBuilder. PromptBuilder's non-prompt duties (base-branch resolution, GitHub username
  REST fetch) split into their own modules. Prompt text stays Linear-aware for now.

### #6 EdgeWorker coordinator
- `composeEdgeWorker(config)` composition root constructs collaborators; EdgeWorker's
  constructor **accepts** them (injection seam for fakes). No `new` in business logic.
- Fix the shared-mutable-config aliasing: services receive config via `setConfig(merged)`
  with the same normalized object; ToolPermissionResolver's in-place mutate-and-restore
  becomes a pure function taking the platform default as a parameter.

## Not now (speculative)

- **Issue-tracker seam is nominal.** `Issue = Pick<LinearSDK.Issue>`, one adapter (Linear).
  One adapter = a hypothetical seam — don't deepen the abstraction until a second real
  tracker (GitHub Issues) forces the shape. Do stop the Linear leak into EdgeWorker /
  PromptAssembler so a future second adapter is reachable, but hold the interface open.

## Implementation staging (one coordinated design, staged landing)

A: #1 ConfigManager + pathRegistry · B: neutral AgentMessage + runner adapters ·
C: ActivityMapper + collapse post paths · D: AccessPolicy + adapters (cold+warm) ·
E: PromptAssembler + split PromptBuilder + move tests off `as any` ·
F: session split + WebhookRouter + CyrusToolsHost · G: EdgeWorker coordinator + composition
root + config-aliasing fix. Each phase keeps the suite green.
