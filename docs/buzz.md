# Buzz integration

Cyrus can be driven from a [Buzz](https://github.com/block/buzz) chat channel:
post a message, a session starts against the routed repository, and the agent
replies in the thread. Follow-up messages in the same thread continue the same
session.

Design rationale and rejected alternatives:
[ADR 0013](adr/0013-front-cyrus-with-buzz-project-linear.md).

## What works today

- A message in a routed channel starts a **read-only triage** session.
- The agent answers in the thread, then offers the ▶️/📝 execution gate.
- Reacting ▶️ promotes the thread to a full session that may write code.
- Replies in that thread steer the running session, and answer its questions.

Not yet wired: the Linear projection, and asking which repository to use when a
channel is ambiguous.

## The execution gate

Chat never turns into code changes on its own. A thread has two phases:

| Phase | Tools | Entered by |
| --- | --- | --- |
| `triage` | the `readOnly` preset plus `AskUserQuestion` — no `Edit`, `Write` or general `Bash` | any message in a routed channel |
| `execute` | the repository's full tool set | an allowlisted human reacting ▶️ |

After each triage turn Cyrus posts a gate message and seeds it with both
reactions:

- **▶️** — implement it. The triage conversation is resumed, so nothing has to be
  restated.
- **📝** — track it only; no code changes.

The gate **never times out**. An unanswered gate leaves the thread in triage,
which is the safe resting state. Prose does not open it: only the reaction (or a
reply of exactly `implement` / `track`) counts, so "yeah sounds good" in the
thread is conversation, not consent.

The restriction is enforced by the tool set, not by prompt wording — a triage
turn that decides to "just fix it" still cannot reach an editor.

### Questions during a session

Mid-session questions behave differently from the gate: they **do not park**.
Cyrus posts the question with numbered reactions, and you can answer either by
reacting or by replying in your own words. If nobody answers within
`askUserQuestionTimeoutMinutes` (default 10), Cyrus says so in the thread and
proceeds on its own recommendation rather than blocking the run.

## 1. Build the CLI

The crate is named `buzz-cli`; **the binary it produces is named `buzz`**.

```bash
cd ~/buzz
cargo build --release -p buzz-cli
# → target/release/buzz
```

## 2. Configure Cyrus

Non-secret settings go in `~/.cyrus/config.json`:

```json
{
  "buzz": {
    "cliPath": "~/buzz/target/release/buzz",
    "relayUrl": "https://buzz.example.com",
    "ingress": "poll",
    "pollIntervalSeconds": 5,
    "selfPubkey": "<Cyrus's own 64-hex pubkey>",
    "allowedPubkeys": ["<64-hex nostr pubkey>"],
    "channels": [
      { "channelId": "<channel UUID>", "repositoryId": "<repo id>" }
    ]
  }
}
```

`channelId` comes from `buzz channels list`; `repositoryId` is the `id` of an
entry in `repositories`. A channel with no route is ignored.

`allowedPubkeys` is the authorization boundary. Buzz channels can be open, so
channel membership is not a permission — **an empty or missing allowlist denies
everyone.**

`selfPubkey` is Cyrus's own pubkey, derived from `BUZZ_PRIVATE_KEY`. Polling
reads the same channels Cyrus posts into, so without it the first reply would
trigger a session that replies, and so on.

Secrets go in `~/.cyrus/.env`, not in `config.json` (which CYHOST may push over
the wire):

```bash
BUZZ_PRIVATE_KEY=nsec1...        # the agent's Nostr identity; also its Buzz account
CYRUS_BUZZ_WEBHOOK_SECRET=...    # only for `ingress: "webhook"`
BUZZ_AUTH_TAG=...                # optional NIP-OA owner attestation
```

Cyrus enables Buzz only when the `buzz` block and `BUZZ_PRIVATE_KEY` are
present; otherwise it logs why and stays disabled.

## 3. Choose an ingress

### `poll` (default)

Cyrus reads the relay through the CLI on a timer. It needs **no inbound
exposure**, so it is the only option that works when the relay can reach Cyrus
only over a tailnet or not at all. Nothing else to install — skip to step 4.

Reactions are polled only on messages Cyrus is currently waiting on (an open
gate or question), so the cost is proportional to open prompts rather than to
channel volume.

### `webhook`

Lower latency, but it requires Cyrus to be reachable at a **genuinely public**
address. buzz-workflow resolves the target and refuses private or reserved
ranges — including CGNAT `100.64.0.0/10`, which is **every Tailscale address**.
A `*.ts.net` URL therefore cannot work, even when public DNS resolves it to a
routable address, because the relay container resolves it through the host's
MagicDNS to `100.x`. Verify with:

```bash
docker exec <relay-container> getent hosts <your-cyrus-host>
```

If that prints a `100.64–100.127` address, use `poll`.

Ingress is a `buzz-workflow` that POSTs to Cyrus. Start from the canonical
definition, which is kept in lockstep with the parser:

```bash
cd packages/buzz-event-transport/workflows
# edit cyrus-trigger.yaml: set the URL and the Authorization secret
buzz workflows create --channel <CHANNEL_UUID> --yaml - < cyrus-trigger.yaml
```

Constraints buzz-workflow imposes on the target: it must be **public HTTPS**,
redirects are not followed, and the request times out at 10 s. Cyrus answers
immediately and does the work in the background, so the timeout is not a limit
on session length.

Do not add `{{trigger.text}}` to the body. Workflow templates perform raw string
substitution with no JSON escaping, so a message containing a quote or a newline
would produce an unparseable payload; Cyrus reads the message text back from the
relay by event id instead. See `agent-docs/dev-gotchas.md`.

## How a session is identified

A Buzz thread has no issue behind it, so Cyrus synthesizes one — the same
pattern GitHub PRs use for `PR-123`:

| | |
| --- | --- |
| Identity | the thread **root** event id (so replies resume, not restart) |
| Session key | `BUZZ-<first 6 hex of root>`, e.g. `BUZZ-a1b2c3` |
| Worktree | `<workspaceBaseDir>/BUZZ-a1b2c3/` |
| Branch | `BUZZ-a1b2c3-<slug of first line>` |

Branches from Buzz are therefore named `BUZZ-xxxxxx`, not `DEV-xxx` — a worktree
name no longer always corresponds to a tracker identifier.

## What gets posted back

Only conversational activity: responses, questions and errors. Thoughts and
individual tool calls are dropped. A Buzz thread is a chat log humans read,
where narrating every tool call buries the answer — unlike Linear, which renders
those in a collapsible agent-session timeline.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Buzz is configured but BUZZ_PRIVATE_KEY is unset` | Secret missing from `~/.cyrus/.env`; Buzz stays disabled. |
| `Buzz CLI check failed` at startup | `cliPath` wrong (pointing at `buzz-cli` instead of `buzz`), or the binary is not built. |
| Workflow reports a delivery failure, or nothing arrives at all | Wrong `Authorization` header, or the target resolves to a private/CGNAT address inside the relay container — switch to `ingress: "poll"`. |
| Messages accepted but nothing happens | Author's pubkey is not in `allowedPubkeys` (the endpoint answers 202 and drops), or the channel has no route. |
| Agent starts but never replies | `BUZZ_PRIVATE_KEY`'s account is not a member of the channel — check the logged relay rejection. |
| Agent answers but never edits anything | The thread is still in triage; react ▶️ on the gate message. |
| Cyrus replies to itself in a loop | `selfPubkey` is unset or wrong under `ingress: "poll"`. |
