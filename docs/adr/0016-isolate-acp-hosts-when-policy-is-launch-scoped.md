# Isolate ACP hosts when policy is launch-scoped

[0002](0002-share-one-acp-host-per-agent-profile.md) says Cyrus runs one long-lived ACP
host per active Agent profile and multiplexes that profile's Runner sessions over its
initialized connection. That rule assumed every authorization input is session-scoped on
the ACP wire. OMP (Oh My Pi) 17.2.4 breaks the assumption: its ACP handler ignores
`additionalDirectories`, and its tools, system prompt, extra directories, and sandbox
policy are owned by **process launch flags**, not by per-session ACP fields. Sharing one
OMP host would therefore union every session's read/write roots and tool set across all
Issues multiplexed on it — a cross-Issue access leak no per-session check could close.

This ADR narrows 0002 with an invariant and records OMP as an exception.

## Invariant

An ACP host may be shared only when **all** of the following are session-scoped on the
wire and independently enforceable per session: system prompt, built-in tools, MCP
catalog, read/write roots, and sandbox policy. If any one of these is launch-scoped, the
host must be process-isolated per session so the launch scope and the session scope are
the same set.

## Alternatives considered

- **Shared profile host (status quo, 0002).** One OMP process per profile, sessions
  multiplexed. Rejected: launch flags own tools/system prompt/roots, so multiplexing
  unions access across Issues. The generic ACP fields that would carry per-session scope
  (`additionalDirectories` for roots) are ignored by OMP's ACP handler.
- **RPC transport instead of ACP.** OMP's RPC mode has stronger mid-turn steering, but its
  MCP configuration is ambient (inherited from the OMP process environment), which
  conflicts with Cyrus's exact Session MCP catalog (ADR 0006) — Cyrus-owned `linear` and
  `cyrus-tools` servers could be silently replaced or augmented. ACP provides native
  `session/new` and `session/resume` with a client-supplied MCP catalog, standard
  permission requests, and neutral session updates.
- **Isolated ACP process per session (chosen).** One `omp acp` process per active Cyrus
  session, launched with that session's system prompt, tools, extra directories, sandbox
  policy, and exact MCP catalog baked into launch arguments. A session's authorization
  inputs and its process scope are identical, so no access can leak across Issues.

## Exception

OMP 17.2.4 is an isolated-host exception to 0002. Because `additionalDirectories` is
ignored by OMP's ACP handler, read/write roots must be passed as repeated `--add-dir`
launch flags (or enforced by the OS sandbox wrapper); because launch flags own tools and
system prompt, per-session tool and prompt scope requires a per-session process.

## Consequences

- One OMP ACP process is launched per active Cyrus session, with bounded startup and
  shutdown timeouts; process lifetime tracks the session, not the profile.
- A resumed session re-launches the OMP process from its persisted profile identity and
  runner session ID; resume is the ACP `session/resume` handshake, not process reuse.
- SRT (sandbox-runtime) wraps the complete OMP/MCP process tree whenever Cyrus
  sandboxing is enabled, so the launch-scoped policy is enforced for the whole tree.
- Profiles whose authorization inputs are fully session-scoped on the wire may still use
  the shared-host model of 0002; the invariant is what separates the two regimes.
