# Cyrus Packages

This directory contains the core packages that make up the Cyrus monorepo. Each package has a specific scope of concerns and well-defined responsibilities.

## Package Overview

### @cyrus/core
**Scope**: Core domain models, configuration schemas, and shared interfaces

**Responsibilities**:
- Define `EdgeWorkerConfig`, repository config, and runner types
- Provide `IAgentRunner` and `IIssueTrackerService` interfaces
- Issue-tracker types and CLI platform adapters (`CLIIssueTrackerService`)
- Per-platform default allowed-tools lists

**Key exports**: `EdgeWorkerConfig`, `IAgentRunner`, `IIssueTrackerService`, `CyrusAgentSession`, config schemas

### @cyrus/claude-runner
**Scope**: Claude Code SDK wrapper

**Responsibilities**:
- Spawn and manage Claude Code sessions via `@anthropic-ai/claude-agent-sdk`
- Map SDK messages to shared runner message shapes
- Configure tools, MCP, sandbox, and session continuation

**Key exports**: `ClaudeRunner`, `SDKMessage` types, sandbox helpers

### @cyrus/cursor-runner
**Scope**: Cursor Agent SDK wrapper

**Responsibilities**:
- Run Cursor sessions via `@cursor/sdk`
- Translate Cyrus tool permissions to Cursor CLI config
- Map Cursor stream events to shared runner message shapes

**Key exports**: `CursorRunner`, permission and sandbox helpers

### @cyrus/edge-worker
**Scope**: Orchestrate webhooks, agent sessions, git worktrees, and issue-tracker responses

**Responsibilities**:
- Host `SharedApplicationServer` (Fastify) for inbound webhooks and config updates
- Route issues to repositories; manage `AgentSessionManager` and `GlobalSessionRegistry`
- Build prompts, resolve tools/MCP, optional egress sandbox
- Instantiate Claude or Cursor runners per session

**Key exports**: `EdgeWorker`, `GitService`, `RunnerConfigBuilder`, `AgentSessionManager`

### @cyrus/linear-event-transport
**Scope**: Linear webhook ingress and issue-tracker adapter

**Responsibilities**:
- Register `POST /linear-webhook` (and legacy `/webhook` alias)
- Verify Linear signatures or bearer tokens (direct vs CYHOST-forwarded)
- Implement `LinearIssueTrackerService` for Linear API operations

**Key exports**: `LinearEventTransport`, `LinearIssueTrackerService`

### @cyrus/github-event-transport
**Scope**: GitHub webhook ingress (typically forwarded from CYHOST)

**Responsibilities**:
- Register `POST /github-webhook`
- Verify GitHub HMAC or bearer tokens
- Translate PR comment/review/push events for `EdgeWorker`

**Key exports**: `GitHubEventTransport`, `GitHubAppTokenProvider`

### @cyrus/cloudflare-tunnel-client
**Scope**: Expose the local Fastify server via Cloudflare tunnel

**Key exports**: `CloudflareTunnelClient`, `getCyrusAppUrl`

### @cyrus/config-updater
**Scope**: Authenticated HTTP routes for CYHOST to push config to a self-hosted runtime

**Key exports**: `ConfigUpdater`

### @cyrus/mcp-tools
**Scope**: Runner-neutral MCP tool servers used by Cyrus sessions

**Key exports**: `createCyrusToolsServer`, failure-mode logging tools

## Package Dependencies

```
@cyrus/edge-worker
  ├── @cyrus/core
  ├── @cyrus/claude-runner
  ├── @cyrus/cursor-runner
  ├── @cyrus/linear-event-transport
  ├── @cyrus/github-event-transport
  ├── @cyrus/cloudflare-tunnel-client
  ├── @cyrus/config-updater
  └── @cyrus/mcp-tools

@cyrus/claude-runner ──► @cyrus/core
@cyrus/cursor-runner ──► @cyrus/core
@cyrus/linear-event-transport ──► @cyrus/core
@cyrus/github-event-transport ──► @cyrus/core
```

## Design Principles

1. **Single responsibility**: Each package has one clear purpose
2. **Minimal dependencies**: Packages depend only on what they need
3. **Type safety**: All packages export TypeScript types
4. **Event-driven transports**: Webhook ingress is platform-specific; `EdgeWorker` consumes normalized events
5. **Testable**: Each package can be tested in isolation
6. **Reusable**: Packages can be used independently (F1 uses `edge-worker` + CLI issue tracker)

## Usage in Apps

- **`apps/cli`**: Production entry point — starts `EdgeWorker` with Linear/GitHub transports
- **`apps/f1`**: Test harness — `EdgeWorker` with `platform: "cli"` and in-memory issue tracker
