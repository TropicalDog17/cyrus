# Single production package with folder seams

Cyrus-trop is a hard fork: we do not expect to merge package-structure changes
from upstream. The private deploy path is one systemd unit / one `cyrus`
binary, so eleven `cyrus-*` workspace packages were packaging theater, not
publish boundaries. Collapse library + CLI into one root package named
`cyrus-trop` (binary remains `cyrus`); keep `apps/f1` as the only other
workspace member.

Domain seams stay as folders under `src/` (not npm packages): `core`,
`runners/{claude,cursor,codex,omp}`, `transports/{linear,github}`,
`edge-worker`, `mcp-tools`, `infra/{config-updater,cloudflare-tunnel}`,
`cli`. Internal imports use a `#/` path alias. Cross-seam dependency direction
is enforced by boundary lint in CI. F1 depends on `cyrus-trop` via a minimal
`exports` map (only what it needs). Migration is big-bang in one PR.

## Considered options

- **Keep the multi-package workspace** — rejected: private packages + deploy-on-merge
  made the workspace tax pure overhead.
- **One package including F1** — rejected: F1 is an e2e harness with its own binary
  and should stay off the production dependency graph.
- **Flatten EdgeWorker module seams while collapsing packages** — rejected: that is a
  second refactor; folder seams remain.
- **Strangler migration alongside old `cyrus-*` packages** — rejected: doubles the
  graph for weeks, opposite of the goal.

## Consequences

- Upstream pulls that touch `packages/*` will not apply cleanly; cherry-pick by hand.
- Agent docs and path references that say `packages/...` must move with the PR.
- A future reader must not "fix" this by re-splitting into npm packages without
  revisiting this ADR.
