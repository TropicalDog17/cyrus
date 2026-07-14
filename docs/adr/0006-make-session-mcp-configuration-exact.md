# Make session MCP configuration exact

Cyrus will supply the complete MCP server catalog for each ACP session and will
not allow ambient Codex MCP configuration to be merged into it. This requires an
isolated Codex configuration environment or adapter support, but prevents local
servers from silently replacing Cyrus-managed servers such as `linear` or
`cyrus-tools` and keeps credentials, permissions, and resume behavior
deterministic.
