# Share one ACP host per Agent profile

Cyrus will run one long-lived ACP host for each active Agent profile and multiplex
that profile's Runner sessions over its initialized connection. Session-scoped
runner objects remain lightweight facades over the shared host. This avoids one
Codex app-server process per Issue and negotiates capabilities once, accepting a
profile-wide failure domain in exchange; after a host restart, Cyrus resumes each
affected session from its persisted Runner session ID.
