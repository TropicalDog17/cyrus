---
name: core-conventions
description: Project conventions for tests, recording durable findings, dependency security, and skills layout. Use when writing or reviewing code changes, adding tests (especially prompt assembly), updating dependencies, or editing agent skills/docs.
---

# Core conventions

Thin playbook. Depth lives in `agent-docs/` — do not restate those docs here.

## Commands

```bash
pnpm install
pnpm test:packages:run
pnpm typecheck
pnpm lint
pnpm build    # when needed
```

Full command matrix: `agent-docs/testing-and-commands.md`.

## Tests

- Vitest everywhere. Prefer `test:run` (once) over watch for ship gates.
- **Prompt assembly** (`packages/edge-worker/test/prompt-assembly*.test.ts`):
  assert the **entire** prompt with `.expectUserPrompt()` / `.expectSystemPrompt()`
  / `.expectComponents()` / `.expectPromptType()` / `.verify()`. Never partial
  `.toContain()` checks. Examples in `agent-docs/testing-and-commands.md`.
- Major product behavior: validate with F1 (`f1-test-drive` skill).

## Recording what you learned

This repo keeps **no changelog** — git history is the log, and it is searchable by
file, attributable, and never drifts. Do not reintroduce one. Sort what you learned
by how long it stays true:

| What you have | Where it goes |
| --- | --- |
| An invariant that causes silent breakage if ignored | `agent-docs/dev-gotchas.md` |
| A decision, and why it beat the alternative | `docs/adr/` — one decision per file |
| Domain vocabulary or a module seam | `CONTEXT.md` (only once it exists in code) |
| File lists, symbol inventories, test manifests | Nowhere — `git log -p` has it |

A gotcha is worth more when a test enforces it. The strongest example in this repo:
`WorkerService.test.ts` fails if its fixture does not enumerate every
`EdgeConfigSchema.shape` key, so a dropped config field cannot ship. Prefer that over
a note whenever the invariant is testable.

Full ship flow: `verify-and-ship`.

## Dependency security

1. Bump the **owning** direct dep in that package's `package.json`.
2. Root `pnpm.overrides` only when a direct bump cannot reach the patched
   transitive; document why.
3. Remove obsolete overrides when a bump makes them redundant.
4. `pnpm install && pnpm audit` must be clean; commit the lockfile.

## Skills layout

- Canonical: `skills/<name>/SKILL.md`
- Wire harnesses: `./scripts/symlink-skills.sh`
- Do not copy protocol text into `.claude/agents/` or other harness wrappers

## When editing config / sandbox / MCP / SDK

Load `agent-docs/dev-gotchas.md` before coding — config whitelist, path `~`
normalization, dual permission systems, MCP catalog, SDK tool list refresh.
