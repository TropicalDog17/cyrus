# Select Agent profiles instead of Runner types

Cyrus selection will resolve an `agentProfileId` through the built-in profile
registry rather than extending provider branches around `RunnerType`. The
initial profile IDs are `claude`, `cursor`, `codex`, and `pi`; an
`[agent=<profile>]` tag, matching label, or `defaultAgentProfile` selects a
profile, while `defaultRunner` remains a backward-compatible alias for existing
configurations.
