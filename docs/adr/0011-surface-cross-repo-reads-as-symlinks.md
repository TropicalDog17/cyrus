# Surface cross-repo reads as worktree symlinks

When a single-repo session's routed repository sets `readParentDirectory`, Cyrus
already grants read access to sibling checkouts under the shared parent, but the
agent — which only sees its own worktree — cannot discover those paths and falls
back to guessing sibling contracts (DEV-167). Cyrus will make that grant
discoverable by dropping read-only reference symlinks to the sibling repos into
`<worktree>/cross-repo/<name>`, added to the worktree's git exclude so they never
pollute `git status`. This was chosen over injecting the sibling paths into the
system prompt (keeps prompt context lean and lets the agent find the repos the
same way it finds any file) and over registering them as `--add-dir` roots (that
mechanism is reserved for the multi-repo workspace layout, where each repo is a
real sub-worktree). The link target is the canonical checkout; writes stay
confined to the worktree exactly as `readParentDirectory` already guarantees, so
the symlinks add read discoverability without widening write access.
