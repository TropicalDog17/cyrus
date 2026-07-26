---
name: cyrus-setup-slack
description: Configure Slack integration for Cyrus — create a Slack app from manifest, then guide the user to save credentials.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.cyrus/.env` or any file inside `~/.cyrus/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with env files — secrets must never be read into the conversation context. Never scrape, extract, or read secret values from web pages — guide the user to copy them manually.**

# Setup Slack

Creates a Slack application from a pre-built manifest so Cyrus can respond to messages in Slack channels.

## Step 1: Check Existing Configuration

```bash
grep -E '^SLACK_BOT_TOKEN=' ~/.cyrus/.env 2>/dev/null
```

If `SLACK_BOT_TOKEN` is already set, inform the user:

> Slack is already configured. Skipping this step.
> To reconfigure, remove `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` from `~/.cyrus/.env` and re-run.

Skip to completion.

## Step 2: Read Variables

Read the base URL (set by `setup-endpoint`):

```bash
grep '^CYRUS_BASE_URL=' ~/.cyrus/.env | cut -d= -f2-
```

You also need `AGENT_NAME` and `AGENT_DESCRIPTION` — these were collected in Step 0 of the orchestrator and should be available from the conversation context.

## Step 3: Build Manifest JSON

The manifest lives in `references/app-manifest.json`. Read it and substitute
`<AGENT_NAME>`, `<AGENT_DESCRIPTION>`, and `<CYRUS_BASE_URL>` with real values.
Change nothing else — in particular the event subscription path must stay
`/slack-webhook`, which is the route `SlackEventTransport` registers.

**Scopes are a cross-repo contract.** The scope lists in that file must stay in
sync with [cyrus-hosted `constants.ts`](https://github.com/cyrusagents/cyrus-hosted/blob/main/apps/app/src/lib/slack/constants.ts).
If you change scopes here, propose matching changes there and update any live
Slack App configuration that relies on this manifest.

## Step 4: Create Slack App

Pick the automation path, then follow it in `references/browser-automation.md`:

1. `claude-in-chrome` MCP tools available → **Path A-1**
2. `agent-browser` installed and a Chrome debug session connected → **Path A-2**
3. Otherwise → **Path B** (manual)

After creation the app lands on the Basic Information page. Do **not** screenshot
credential pages. Proceed to Step 5.

## Step 5: Install App & Collect Credentials

After the app is created (via any path), guide the user through installation and credential collection. **The agent must NOT scrape, read, or extract secrets from the page.** The user copies them manually.

### 5a. Install to Workspace

Tell the user:

> 1. In your Slack app settings, go to **Install App** in the left sidebar
> 2. Click **Install to Workspace**
> 3. Click **Allow**

If using browser automation (A-1 or A-2), the agent can navigate to the Install App page and click the buttons — but must **stop after installation completes** and not screenshot the resulting page.

### 5b. Add Credential Placeholders

Add placeholder lines to the env file so the user can fill them in:

```bash
grep -q '^SLACK_BOT_TOKEN=' ~/.cyrus/.env || echo 'SLACK_BOT_TOKEN=' >> ~/.cyrus/.env
grep -q '^SLACK_SIGNING_SECRET=' ~/.cyrus/.env || echo 'SLACK_SIGNING_SECRET=' >> ~/.cyrus/.env
```

### 5c. Open env file for editing

```bash
# macOS
code --new-window ~/.cyrus/.env 2>/dev/null || open -a TextEdit ~/.cyrus/.env
# Linux
code --new-window ~/.cyrus/.env 2>/dev/null || xdg-open ~/.cyrus/.env
```

### 5d. Guide the user to copy credentials

Tell the user:

> I've opened `~/.cyrus/.env`. You need to paste two values:
>
> 1. **Bot User OAuth Token** — go to your app's **OAuth & Permissions** page, copy the **Bot User OAuth Token** (starts with `xoxb-`), and paste it after `SLACK_BOT_TOKEN=`
>
> 2. **Signing Secret** — go to your app's **Basic Information** page, scroll to **App Credentials**, click **Show** next to **Signing Secret**, copy it, and paste it after `SLACK_SIGNING_SECRET=`
>
> Save and close the file when done.

### 5e. Wait and verify

After the user confirms they've saved, verify:

```bash
grep -c '^SLACK_BOT_TOKEN=.' ~/.cyrus/.env
grep -c '^SLACK_SIGNING_SECRET=.' ~/.cyrus/.env
```

Both must return 1 (the `.` after `=` ensures the value is not empty). If either is 0, ask the user to check the file.

## Completion

> ✓ Slack app created from manifest and installed
> ✓ Bot token and signing secret saved to `~/.cyrus/.env`

**Note:** The event subscription `request_url` will fail Slack's verification challenge until Cyrus is actually running. Once Cyrus is started, go to the app's **Event Subscriptions** page and re-enter the URL to trigger verification, or Slack will retry automatically.
