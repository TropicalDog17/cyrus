# Use profile-scoped runner session identity

Cyrus will persist `agentProfileId` and `runnerSessionId` for new ACP-backed
sessions. The profile identifies the stable launch configuration that can resume
the opaque runner session; its protocol is derived rather than duplicated in
session state. Existing provider-specific session ID fields remain migration
inputs, but new ACP sessions do not write them, avoiding another provider branch
for every ACP-compatible agent.
