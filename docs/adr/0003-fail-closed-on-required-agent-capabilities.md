# Fail closed on required Agent capabilities

When an ACP host initializes, Cyrus will validate the capabilities required by
the Agent profile and the requested session semantics. Missing mandatory
capabilities make that profile unavailable with a clear diagnostic, rather than
silently weakening behavior or crashing Cyrus; optional presentation features
may degrade, and steering remains an optional negotiated extension with the
per-session prompt queue as its fallback.
