# Keep Cyrus authoritative over Agent access

Cyrus will remain the authority for each session's effective access policy and
will render that policy into the Codex sandbox and tool configuration. ACP
`session/request_permission` handles interactive approval only within that
maximum: Cyrus denies requests outside the policy, and an Agent or user approval
can never broaden the enforced sandbox, preserving approval and containment as
independent security layers.
