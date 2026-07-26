---
name: cyrus-setup-github
description: Configure GitHub for Cyrus — gh CLI login and git config for PRs, with optional webhook setup to enable @mention responses in PR comments, automated rebases and merges, and auto-fixing based on CI failures (coming soon).
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.cyrus/.env` or any file inside `~/.cyrus/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with env files — secrets must never be read into the conversation context.**

# Setup GitHub

Configures GitHub CLI and git so Cyrus can create branches, commits, and pull requests. Optionally creates a GitHub App so Cyrus can receive and respond to @mentions in PR comments and reviews, automate rebases and merges, and auto-fix based on CI failures (coming soon).

---

## Part A: GitHub CLI + Git Config (Outbound)

### Step 1: Check Existing Configuration

Check if `gh` is already authenticated:

```bash
gh auth status 2>&1
```

If authenticated, check git config:

```bash
git config --global user.name
git config --global user.email
```

If both `gh` auth and git config are set, inform the user:

> GitHub is already configured. Skipping to webhook setup.

Skip to Part B.

### Step 2: Authenticate GitHub CLI

If `gh` is not authenticated:

```bash
gh auth login
```

This opens an interactive browser flow. Let the user complete it.

After completion, verify:

```bash
gh auth status
```

### Step 3: Configure Git Identity

If git user name or email are not set, ask the user for their preferred values:

> **What name should appear on commits made by Cyrus?**
> (e.g., your name, or "Cyrus Bot")

> **What email should appear on commits?**
> (e.g., your email, or a noreply address)

Then set them:

```bash
git config --global user.name "<name>"
git config --global user.email "<email>"
```

### Step 4: Verify

```bash
gh auth status
git config --global user.name
git config --global user.email
```

---

## Part B: GitHub App + Webhooks (Inbound — Optional)

Ask the user:

> **Do you want Cyrus to respond to GitHub @mentions in PR comments and reviews?**
>
> - **Yes — enable @mentions**: Creates a GitHub App so Cyrus can receive PR comments and reviews via webhooks, respond when @mentioned, and act on "changes requested" reviews.
> - **No — PRs only**: Cyrus will create branches, commits, and PRs but won't respond to comments.

If **No** → skip to Completion.

If **Yes** → read `references/github-app-webhooks.md` and follow it. It covers
Steps 5-11: checking existing webhook config, collecting inputs (including the
GitHub @mention autocomplete quirk), building and POSTing the app manifest,
exchanging the one-time code for credentials, writing them to `~/.cyrus/`, and
installing the app on repositories. Return here for Completion.

---

## Completion

> ✓ GitHub CLI authenticated
> ✓ Git identity configured: `<name>` <`email`>

If webhooks were enabled:

> ✓ GitHub App created: `<GITHUB_APP_SLUG>`
> ✓ Webhook secret and app credentials saved to `~/.cyrus/.env`
> ✓ Private key saved to `~/.cyrus/github-app.pem`
> ✓ App installed (installation ID: `<GITHUB_APP_INSTALLATION_ID>`)
> ✓ Cyrus will respond to `@<GITHUB_BOT_USERNAME>` mentions in PR comments

**Note:** The webhook URL will only respond successfully once Cyrus is running. If GitHub shows a webhook delivery failure during setup, it will retry automatically once Cyrus starts.
