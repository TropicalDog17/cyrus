# @cyrus/edge-worker

Unified edge worker for processing Linear (and GitHub) issues with Claude Code or Cursor. Handles webhook events on a local Fastify server, manages agent sessions, and posts activities back to Linear.

## Installation

```bash
pnpm add @cyrus/edge-worker
```

## Usage

The EdgeWorker supports multiple repository/Linear workspace pairs. Each repository configuration includes:
- Git repository path and branch
- Linear workspace ID and OAuth token
- Workspace directory for issue processing

### Single Repository Example (CLI)

```typescript
import { EdgeWorker } from '@cyrus/edge-worker'

const edgeWorker = new EdgeWorker({
  cyrusHome: '/home/user/.cyrus',
  serverPort: 3456,
  defaultRunner: 'claude',

  // Single repository configuration
  repositories: [{
    id: 'main-repo',
    name: 'Main Repository',
    repositoryPath: '/home/user/projects/main',
    baseBranch: 'main',
    linearWorkspaceId: 'workspace-123',
    linearToken: await oauthHelper.getAccessToken(),
    workspaceBaseDir: '/home/user/.cyrus/workspaces/main'
  }],
  
  // Optional handlers
  handlers: {
    // Custom workspace creation (e.g., git worktrees)
    createWorkspace: async (issue, repository) => {
      const path = await createGitWorktree(
        repository.repositoryPath,
        issue.identifier,
        repository.baseBranch
      )
      return { path, isGitWorktree: true }
    },
    
    // Log errors
    onError: (error) => {
      console.error('EdgeWorker error:', error)
    }
  },
  
  // Features
  features: {
    enableContinuation: true,
    enableTokenLimitHandling: true
  }
})

// Start processing
await edgeWorker.start()
```

### Multi-Repository Example

```typescript
import { EdgeWorker } from '@cyrus/edge-worker'

const repositories = userSettings.repositories.map(repo => ({
  id: repo.id,
  name: repo.name,
  repositoryPath: repo.path,
  baseBranch: repo.branch || 'main',
  linearWorkspaceId: repo.linearWorkspaceId,
  linearToken: repo.linearToken,
  workspaceBaseDir: path.join(cyrusHome, 'worktrees', repo.id),
  isActive: repo.enabled
}))

const edgeWorker = new EdgeWorker({
  cyrusHome,
  serverPort: 3456,
  repositories,
  
  handlers: {
    createWorkspace: async (issue, repository) => {
      const worktreePath = await createWorktree(
        repository.repositoryPath,
        issue.identifier,
        repository.baseBranch
      )
      return { path: worktreePath, isGitWorktree: true }
    }
  }
})

await edgeWorker.start()
```

## Configuration

### Required Config

- `cyrusHome`: Cyrus home directory (e.g. `~/.cyrus`)
- `repositories`: Array of repository configurations
- `serverPort` / `serverHost`: Local Fastify server bind (webhooks land here)

### Repository Configuration

Each repository in the `repositories` array requires:

- `id`: Unique identifier for the repository
- `name`: Display name for the repository
- `repositoryPath`: Local git repository path
- `baseBranch`: Branch to create worktrees from (e.g., 'main')
- `linearWorkspaceId`: Linear workspace/team ID
- `linearToken`: OAuth token for this Linear workspace
- `workspaceBaseDir`: Where to create issue workspaces

Optional per-repository settings:
- `isActive`: Whether to process webhooks (default: true)
- `promptTemplatePath`: Custom prompt template for this repo

### Optional Handlers

All handlers are optional and now include repository context:

- `createWorkspace(issue, repository)`: Custom workspace creation
- `onClaudeEvent(issueId, event, repositoryId)`: Claude event updates
- `onSessionStart(issueId, issue, repositoryId)`: Session started
- `onSessionEnd(issueId, exitCode, repositoryId)`: Session ended
- `onError(error, context)`: Error handling

### Features

- `enableContinuation`: Use `--continue` flag for follow-up comments (default: true)
- `enableTokenLimitHandling`: Auto-restart on token limits (default: true)
- `enableAttachmentDownload`: Download issue attachments (default: false)

## Events

The EdgeWorker extends EventEmitter and emits session lifecycle events (for example `session:started`, `session:ended`, runner message events, and `error`). In production the CLI wires these internally; F1 exposes session output over RPC.

## Architecture

```
cyrus CLI (or F1 server)
    ↓ starts
SharedApplicationServer (Fastify, optional Cloudflare tunnel)
    ↓ POST /linear-webhook, /github-webhook
LinearEventTransport / GitHubEventTransport
    ↓ normalized events
EdgeWorker
    ↓ per issue
    ├─→ RepositoryRouter → git worktree (GitService)
    ├─→ RunnerSelectionService → ClaudeRunner | CursorRunner
    └─→ AgentSessionManager → LinearActivitySink → Linear API
```

Key features:
- Multiple repositories can share the same Linear workspace/token
- Each repository has its own worktree base directory and configuration
- Self-hosted runtimes receive webhooks directly (or via CYHOST forwarding + bearer auth)
- OAuth tokens on repository/workspace config are used for Linear API calls

## Prompt Templates

The EdgeWorker supports customizable prompt templates to tailor Claude's behavior for different repositories or workflows.

### Default Template

If no custom template is specified, EdgeWorker uses a built-in template that helps Claude determine whether to:
1. **Execute** - When requirements are clear, implement the solution
2. **Clarify** - When requirements are vague, ask clarifying questions

### Custom Templates

You can provide custom templates at two levels:
- **Global**: Via `config.features.promptTemplatePath`
- **Per-repository**: Via `repository.promptTemplatePath` (takes precedence)

### Template Variables

Templates use Handlebars-style variables that are automatically replaced:

- `{{repository_name}}` - Name of the repository
- `{{issue_id}}` - Linear issue ID
- `{{issue_title}}` - Issue title
- `{{issue_description}}` - Full issue description
- `{{issue_state}}` - Current issue state
- `{{issue_priority}}` - Priority level (0-4)
- `{{issue_url}}` - Direct link to Linear issue
- `{{comment_history}}` - All previous comments formatted
- `{{latest_comment}}` - Most recent comment text
- `{{working_directory}}` - Current working directory
- `{{base_branch}}` - Base git branch (e.g., 'main')
- `{{branch_name}}` - Issue branch name

### Example Custom Template

```markdown
You are an expert {{repository_name}} developer.

## Current Task
**Issue**: {{issue_title}} (#{{issue_id}})
**Priority**: {{issue_priority}}
**Status**: {{issue_state}}

## Description
{{issue_description}}

## Previous Discussion
{{comment_history}}

## Technical Context
- Repository: {{repository_name}}
- Working Directory: {{working_directory}}
- Branch: {{branch_name}} (from {{base_branch}})

## Instructions
1. Review the issue requirements carefully
2. Check existing code patterns in the repository
3. Implement a solution following project conventions
4. Ensure all tests pass
5. Create a descriptive pull request

Remember to ask clarifying questions if requirements are unclear.
```

### Using Custom Templates

```typescript
// Global template for all repositories
const edgeWorker = new EdgeWorker({
  // ... other config
  features: {
    promptTemplatePath: './prompts/default.md'
  }
})

// Per-repository templates
const edgeWorker = new EdgeWorker({
  repositories: [{
    id: 'frontend',
    name: 'Frontend App',
    // ... other config
    promptTemplatePath: './prompts/frontend-specific.md'
  }, {
    id: 'backend', 
    name: 'Backend API',
    // ... other config
    promptTemplatePath: './prompts/backend-specific.md'
  }]
})