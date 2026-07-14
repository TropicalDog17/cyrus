# Keep Agent authentication out of band

Authentication for the built-in Codex profile will be established outside Issue
sessions through an existing writable Codex home or API-key environment. Cyrus
will mark the profile unavailable with actionable diagnostics when authentication
is required, but it will not route login challenges, links, or credentials
through issue comments because authentication belongs to the shared profile and
not to any individual Issue.
