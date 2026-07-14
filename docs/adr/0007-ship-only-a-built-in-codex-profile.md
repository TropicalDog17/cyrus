# Ship only a built-in Codex profile initially

Milestone one will expose a built-in `codex` Agent profile backed by a pinned ACP
adapter, while keeping the internal profile registry capable of representing
future agents. Cyrus will not yet accept arbitrary ACP commands, arguments, or
environment variables from user or remote configuration, avoiding an
unreviewed process-execution surface until its trust and validation model is
designed.
