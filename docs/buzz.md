# Buzz integration

Cyrus can be driven from a [Buzz](https://github.com/block/buzz) chat channel:
post a message, a session starts against the routed repository, and the agent
replies in the thread. Follow-up messages in the same thread continue the same
session.

Design rationale and rejected alternatives:
[ADR 0013](adr/0013-front-cyrus-with-buzz-project-linear.md).

## What works today

- A message in a routed channel starts a session.
- Replies in that thread steer the running session.
- The agent's responses, questions and errors post back into the thread.

Not yet wired: the 📝/▶️ execution gate and reaction-based approvals, the Linear
projection, and asking which repository to use when a channel is ambiguous.
Reactions are accepted by the endpoint and ignored, so a thumbs-up cannot start
a coding session.

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

Secrets go in `~/.cyrus/.env`, not in `config.json` (which CYHOST may push over
the wire):

```bash
BUZZ_PRIVATE_KEY=nsec1...        # the agent's Nostr identity; also its Buzz account
CYRUS_BUZZ_WEBHOOK_SECRET=...    # shared secret for the workflow → Cyrus POST
BUZZ_AUTH_TAG=...                # optional NIP-OA owner attestation
```

Cyrus registers `POST /buzz-webhook` only when the `buzz` block **and** both
required env vars are present; otherwise it logs why and stays disabled.

## 3. Install the workflow

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
| `Buzz is configured but BUZZ_PRIVATE_KEY and/or CYRUS_BUZZ_WEBHOOK_SECRET are unset` | Secrets missing from `~/.cyrus/.env`; the endpoint is not registered. |
| `Buzz CLI check failed` at startup | `cliPath` wrong (pointing at `buzz-cli` instead of `buzz`), or the binary is not built. |
| Workflow reports a delivery failure | Wrong `Authorization` header, or the URL is not reachable public HTTPS. |
| Messages accepted but nothing happens | Author's pubkey is not in `allowedPubkeys` (the endpoint answers 202 and drops), or the channel has no route. |
| Agent starts but never replies | `BUZZ_PRIVATE_KEY`'s account is not a member of the channel — check the logged relay rejection. |
