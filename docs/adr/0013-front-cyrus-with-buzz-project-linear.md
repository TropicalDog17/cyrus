# Front Cyrus with Buzz; project Linear, don't converse in it

Buzz becomes the conversational surface for Cyrus — triggers, steering,
questions, and approvals all happen in Buzz threads. Linear is demoted to a
**projection**: an issue record Cyrus writes to (status, links, one final
summary), never a place humans talk to the agent. The drivers are that
Linear's comment/agent-session UX is the bottleneck for steering sessions,
Buzz is becoming the front door for every agent on this deployment, and
pre-issue triage conversations ("investigate this, maybe it becomes work")
have no home in an issue-first tracker.

The integration reuses every existing seam rather than adding the
`ConversationAdapter` layer originally sketched:

- **Ingress** is a fourth `IAgentEventTransport`: buzz-workflow triggers
  (`MessagePosted` filtered by channel, `ReactionAdded`) POST to the existing
  Fastify server. No native Nostr subscriber — the workflow bridge is the
  webhook shape the transport contract already expects.
- **Egress** is a `BuzzActivitySink` that shells out to buzz-cli, the same
  pattern used for every other CLI Cyrus drives. Upstream owns Nostr event
  schemas, signing, and NIP-OA attestation; we do not re-implement them in TS.
- **Session identity is not refactored.** Buzz sessions mint a synthesized
  key (`BUZZ-a1b2c3`) exactly as GitHub PR sessions mint `PR-123`. The Linear
  issue attaches lazily via a correlation record in the existing per-session
  state dir.
- **Authz** is a Nostr pubkey allowlist enforced in the transport through the
  existing `UserAccessControl` seam; events from unlisted keys are dropped.

Interaction protocol: Cyrus posts questions with enumerable options resolved
by reactions; a plain text reply is always accepted as a free-form answer.
Mid-session questions default-proceed with the recommended option after a
timeout (announced in-thread). The 📝 track / ▶️ implement execution gate is
the **single exception** — it parks until an allowlisted human reacts, so
conversation never self-promotes into code changes unattended.

Repo routing maps Buzz channels → repositories (the `projectKeys` analog);
ambiguous or catch-all channels resolve the repo inside the gate question, so
triage chat stays repo-agnostic until execution.

Linear projection semantics: the issue is created **unassigned** at gate time
(assignment/@mention are the only Linear session triggers, so an unassigned
projection cannot re-trigger Cyrus), carries the Buzz thread URL, then
receives status transitions, branch/PR links, and one summary comment on
merge. All Linear writes are non-blocking with retry — Buzz and the
repository are the execution-critical systems.

Rejected alternatives: a platform-neutral session-ID refactor (the
synthesized-identifier pattern already gives the property with zero churn);
a native Nostr client (re-implements upstream crypto/schemas before the
first end-to-end proof); eager Linear issue creation as the session key
(makes Linear blocking at session start); a standalone bridge daemon (one
consumer today — per [0012](0012-deepen-only-forced-seams.md), the seam
stays in-fork until a second agent forces it).

## Consequences

- Linear ingress keeps working during the transition, partitioned by origin;
  demoting it later is config, not code.
- The Buzz stack becomes execution-critical infrastructure: relay image and
  buzz-cli build are pinned in lockstep to a single upstream commit, and
  upgrades are deliberate (bump, rebuild, smoke-test the loop together).
- buzz-cli's CLI surface is our API contract; a thin contract test must fail
  the build loudly on upstream arg/JSON drift.
- Buzz-originated branches are named `BUZZ-xxx`, not `DEV-xxx` — worktree and
  branch names no longer always match a tracker identifier.
- Buzz has native issues (`buzz-cli issues`); if they mature, the Linear
  projection is deletable without touching the conversation layer. That
  end-state is deliberately out of scope here.
