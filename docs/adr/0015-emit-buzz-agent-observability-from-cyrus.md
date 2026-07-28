# Emit Buzz agent observability from Cyrus

Cyrus builds and signs two event kinds **in TypeScript** to make in-progress work visible
in Buzz: the NIP-AO **observer plane** (kind 24200), carrying ACP JSON-RPC payloads whose
tool names are mapped onto Buzz's catalog, and the **typing indicator** (kind 20002),
contentless liveness carrying no payload. This **reverses**
[0013](0013-front-cyrus-with-buzz-project-linear.md), which shelled out to buzz-cli because
"upstream owns Nostr event schemas and signing", and rejected a native client before any
end-to-end proof. That proof now exists, and these two kinds are exactly the two buzz-cli
cannot send; all other writes stay on buzz-cli.

A surface is needed because `BuzzActivitySink.renderBody` posts only `response`,
`elicitation` and `error`, so a working session and a hung one look identical in between.
Linear can suppress narration; it has a second surface, and Buzz has none. Rejected
instead: discrete narration messages (upstream's own pattern, but permanent unremovable
kind-9 events in a conversation) and a `buzz messages edit` placeholder (Buzz-only, still
permanent, prose only). The observer plane alone is unpersisted and structured.

TS was **not** the recommended route — a `buzz observer emit` subcommand on a fork was,
since `build_agent_observer_frame` already exists and schema ownership would stay upstream.
It loses because `~/buzz` is a plain clone with no fork and no pin here — a fork means
owning a Rust build and a deploy-path divergence, upstreaming an unbounded schedule for one
deployment's need. Publication is **gated, not scheduled**: this relay disables the NIP-OA
auth route, so no `agent_owner` row can exist for Cyrus's key and frames fail the owner
check. No relay client is written until a hand-signed 24200 event from Cyrus's key is
proven accepted by *this* relay; on rejection the decision reopens — enable the route, or
fall back to the fork. This ADR does not assert TS publication works.

Past that gate, ephemeral kinds are absent from the HTTP `/events` allowlist, so this is a
NIP-42-authenticated **WebSocket**, not a subprocess. No crypto is hand-rolled; the
exposure is **schema** — NIP-AO is a draft optional NIP that nothing on the wire validates,
hence golden vectors against the Rust builder, not "the panel rendered something" tests.
The payload is ACP JSON-RPC because the panel renders an ACP transcript matching tools **by
name** against a fixed catalog, so the projection also **maps Cyrus names onto it**:
unmapped, every tool falls through to `generic` and three search-shaped ones are
mislabelled as Buzz relay history search: without the table this is worse than the rejected
message rewrite, at higher cost; renaming on the wire buys four real card classes.

Two standing decisions constrain it.
[0004](0004-project-acp-updates-into-agent-messages.md)'s shared `ActivityMapper` survives
only if the projection reads `AgentMessage` and nothing else, so teeing a runner's raw ACP
NDJSON for verbatim fidelity is **rejected** even for ACP-backed runners: every runner
synthesises `seq`, ids, tool status and usage instead.
[0012](0012-deepen-only-forced-seams.md) forbids abstracting that, so it stays nominal —
one relay client, one projection, one call site, no `NostrTransport` until a second
consumer forces it. The typing indicator ships too: the observer panel is owner-only and
behind a click, while 20002 is thread-scoped and visible on mobile — the only in-thread
liveness there is.

## Consequences

- Cyrus tracks a **draft** upstream NIP: golden vectors, untested by buzz-cli's contract
  test, are all that stand between a schema bump and a silently blank panel, a renamed
  catalog entry degrades mapped cards to `generic`, and 0013's lockstep relay/CLI pin
  becomes what holds the contract still.
- `channelId` must be the Buzz channel UUID, not the thread root event id that session
  identity holds; only `BuzzActivitySink` knows the UUID. The desktop scopes by exact
  channel equality, so a mis-scoped frame is accepted, decrypted and shown nowhere.
- The observer and thread panels are **mutually exclusive**, sharing one desktop slot. The
  relay persists nothing, so a frame's only durable home is the desktop's archive of what
  it was subscribed for; frames emitted with nothing subscribed are lost, leaving
  observability only as continuous as that subscription.
- Emission must be paced and size-fitted to the relay's limits (100 frames/sec, ±5-minute
  `created_at`, 65,535-byte plaintext); oversized frames are elided before encrypt or they
  vanish.
- `BUZZ_PRIVATE_KEY` moves from a child process into the EdgeWorker heap and Cyrus holds
  its first direct relay connection; kind 43003 rows stay a cheaper coarse surface if
  upstream ships a producer.
