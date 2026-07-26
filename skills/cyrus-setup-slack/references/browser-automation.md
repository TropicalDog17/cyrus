# Slack app creation — browser automation paths

Loaded from `cyrus-setup-slack` Step 4. Follow exactly one path; the selection
rule is in `SKILL.md`. All paths use the **From a manifest** flow — never
"From scratch".

`<MANIFEST_JSON>` below means the fully-substituted contents of
`references/app-manifest.json` (`<AGENT_NAME>`, `<AGENT_DESCRIPTION>`,
`<CYRUS_BASE_URL>` replaced with real values).

**Never screenshot credential pages, and never scrape, extract, or read secret
values from a page — the user copies them manually in Step 5.**

### Path A-1: claude-in-chrome Automation

Use the `mcp__claude-in-chrome__*` tools to navigate and interact with the user's existing Chrome browser.

1. Navigate to https://api.slack.com/apps
2. Click **Create New App**
3. Select **From a manifest** in the modal
4. Pick the workspace
5. Click **Next**
6. Select **JSON** tab and paste the manifest from Step 3 (fully substituted with real values)
7. Click **Next**, review, click **Create**

After creation, the app lands on the Basic Information page. **Do NOT take screenshots of credential pages.** Proceed to Step 5 (credential collection).

### Path A-2: agent-browser Automation

If `agent-browser` is connected to a Chrome debug session:

#### 4a. Navigate to Slack app creation

```bash
agent-browser navigate "https://api.slack.com/apps"
```

Take a screenshot to verify the page loaded and the user is logged in.

#### 4b. Click "Create New App"

```bash
agent-browser click "button:text('Create New App')"
```

#### 4c. Select "From a manifest" in the modal

```bash
agent-browser click "button:text('From a manifest')"
```

#### 4d. Select workspace

Take a screenshot to see the workspace picker. Click the appropriate workspace. If multiple are listed, ask the user which one.

```bash
agent-browser click "button:text('Next')"
```

#### 4e. Select JSON format and paste manifest

Click the **JSON** tab if not already selected:

```bash
agent-browser click "button:text('JSON')"
```

Paste the manifest using JavaScript:

```bash
agent-browser eval "var editor = document.querySelector('textarea, [role=\"textbox\"], .ace_editor textarea, .CodeMirror textarea'); if (editor) { var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set; nativeInputValueSetter.call(editor, JSON.stringify(<MANIFEST_JSON>, null, 2)); editor.dispatchEvent(new Event('input', { bubbles: true })); 'pasted'; } else { 'editor not found'; }"
```

If that doesn't work, try:

```bash
agent-browser click "textarea"
agent-browser keyboard "Control+a"
agent-browser type '<MANIFEST_JSON_STRING>'
```

Take a screenshot to verify, then click **Next**:

```bash
agent-browser click "button:text('Next')"
```

#### 4f. Review and create

Take a screenshot to verify the summary, then click **Create**:

```bash
agent-browser click "button:text('Create')"
```

After creation, **do NOT screenshot credential pages or attempt to scrape secrets.** Proceed to Step 5.

### Path B: Manual Guided Setup

Guide the user through the manifest flow:

> ### Create a Slack App
>
> 1. Go to https://api.slack.com/apps
> 2. Click **Create New App**
> 3. In the modal, select **From a manifest**
> 4. Pick the **workspace** you want to associate the app with
> 5. Click **Next**
> 6. Select **JSON** format and paste the following manifest:

Print the fully-substituted manifest JSON for the user to copy.

> 7. Click **Next**, review the summary, then click **Create**

Proceed to Step 5.
