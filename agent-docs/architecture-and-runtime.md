# Architecture and runtime

Deep reference for how Cyrus is structured and how a session runs. Tier-1
summary lives in root `AGENTS.md`; domain vocabulary in `CONTEXT.md`.

## How a session runs

When a Linear issue is assigned to Cyrus:

1. **Issue detection & routing** — EdgeWorker receives a webhook and routes the
   issue to a repository via patterns or workspace catch-all rules.
2. **Workspace isolation** — Dedicated git worktree per issue (e.g.
   `worktrees/DEF-1/`) with a sanitized branch name from the issue identifier.
3. **AI classification** — Issue type (`code`, `question`, `research`, …) and
   procedure (e.g. `full-development`) are selected.
4. **Subroutine execution** (development tasks) — typically:
   - `coding-activity` — implement
   - `verifications` — tests, typecheck, lint
   - `git-gh` — commit and open PR
   - `concise-summary` — final Linear summary
5. **Mid-implementation prompting** — Linear comments stream into the active
   session as guidance.
6. **Activity tracking** — Thoughts, actions, and responses post back to Linear.

### Example log shape

```
[GitService] Creating git worktree at .../worktrees/DEF-1 from origin/main
[EdgeWorker] AI routing decision: Classification: code, Procedure: full-development
[ClaudeRunner] Session ID assigned by Claude: c5c1fc00-...
[AgentSessionManager] Created thought activity activity-6
...
[AgentSessionManager] Subroutine completed, advancing to next: verifications
```

Real end-to-end traces: `apps/f1/test-drives/`. Architecture of F1:
`spec/f1/ARCHITECTURE.md`.

## Monorepo layout

```
cyrus/
├── apps/
│   ├── cli/                       # Main CLI (`cyrus-ai` npm package)
│   └── f1/                        # End-to-end test framework (CLI platform mode)
└── packages/
    ├── core/                      # Shared types, config schemas, issue-tracker interfaces
    ├── claude-runner/             # Claude Code SDK wrapper
    ├── cursor-runner/             # Cursor Agent SDK wrapper
    ├── codex-runner/              # Codex ACP adapter
    ├── omp-runner/                # Oh My Pi ACP adapter (canary profile)
    ├── edge-worker/               # Orchestrator (webhooks, sessions, routing, MCP)
    ├── linear-event-transport/    # Linear webhooks + LinearIssueTrackerService
    ├── github-event-transport/    # GitHub webhook handling
    ├── cloudflare-tunnel-client/  # Optional tunnel for self-hosted webhook exposure
    ├── config-updater/            # Remote config push from CYHOST
    └── mcp-tools/                 # cyrus-tools MCP server
```

**Runtime flow:** Linear/GitHub webhooks → event transport
(`LinearEventTransport` / `GitHubEventTransport`) on `SharedApplicationServer`
→ `EdgeWorker` routes the issue → `GitService` creates a worktree →
`RunnerSelectionService` resolves an `agentProfileId` through the built-in
profile registry (`packages/edge-worker/src/agents/`) → the selected profile's
`createRunner` builds the runner (Claude, Cursor, Codex, or the OMP canary) →
runner streams neutral `AgentMessage`s → `AgentSessionManager` posts activities
via `LinearActivitySink`.

Sessions persist the generic pair `agentProfileId` + `runnerSessionId`
(persistence v6); provider-specific session IDs exist only as migration inputs.
OMP runs one `omp acp --print` process per active session with launch-scoped
authorization inputs (ADR 0016): exact ACP MCP catalog, rendered tool policy,
and an SRT OS-sandbox wrapper when sandboxing is enabled.

F1 uses the same `EdgeWorker` with `platform: "cli"` and an in-memory issue
tracker.

## Key code paths

| Concern | Location |
| --- | --- |
| Linear webhooks + API | `packages/linear-event-transport/src/LinearEventTransport.ts`, `LinearIssueTrackerService.ts` |
| Claude execution | `packages/claude-runner/src/ClaudeRunner.ts` |
| Cursor execution | `packages/cursor-runner/src/CursorRunner.ts` |
| Codex execution | `packages/codex-runner/src/CodexRunner.ts` |
| OMP execution (canary) | `packages/omp-runner/src/OmpRunner.ts` |
| Agent profile registry | `packages/edge-worker/src/agents/AgentProfileRegistry.ts` |
| Exact ACP MCP catalog | `packages/edge-worker/src/agents/ExactMcpCatalog.ts` |
| Session + activity mapping | `packages/edge-worker/src/AgentSessionManager.ts` |
| Edge worker orchestration | `packages/edge-worker/src/EdgeWorker.ts` |
| GitHub token resolution | `EdgeWorker.resolveGitHubToken()` — CYHOST-forwarded install token → self-minted GitHub App token (`GitHubAppTokenProvider`) → `GITHUB_TOKEN` PAT |
| GitHub App token minting | `packages/github-event-transport/src/GitHubAppTokenProvider.ts` |

## Linear webhooks

SDK / schema references:

- [EntityWebhookPayload](https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/EntityWebhookPayload)
- [DataWebhookPayload](https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/unions/DataWebhookPayload)
- [IssueWebhookPayload](https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/IssueWebhookPayload)

Handled types:

- `AgentSessionEvent` (created/prompted) — assign / user prompt
- `AppUserNotification` (`issueUnassignedFromYou`) — unassign
- `Issue` (title/description updates)

`updatedFrom` on `EntityWebhookPayload` holds previous property values for
diffing. Deeper webhook branch rules (created vs prompted, mention vs
delegation, pending repo selection): `packages/CLAUDE.md`.

## Linear state management

On assignment, the agent moves the issue to a state with `type === 'started'`
(In Progress). Standard Linear state types: `triage`, `backlog`, `unstarted`,
`started`, `completed`, `canceled`.

## Git worktrees and setup hooks

Per-issue worktrees isolate concurrent tasks. If the target repo has
`cyrus-setup.sh` at its root, it runs in new worktrees for project init. If
`cyrus-teardown.sh` exists, it runs in the worktree immediately before removal
when the issue hits a terminal state (completed / canceled / deleted). See also
`docs/SETUP_SCRIPTS.md`.

## Shared skills across harnesses

Canonical skill bodies live in `skills/<name>/SKILL.md`. Symlink into harness
dirs with `./scripts/symlink-skills.sh` (targets `.claude/skills`,
`.codex/skills`, `.opencode/skills`).

Rules:

1. Keep harness subagent files thin wrappers.
2. Put workflow logic in canonical shared skills.
3. Update the shared skill first; do not duplicate protocol text across harnesses.
