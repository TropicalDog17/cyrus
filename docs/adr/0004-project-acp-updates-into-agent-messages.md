# Project ACP updates into Agent messages

`AcpRunner` will translate ACP session updates into Cyrus's existing neutral
`AgentMessage` contract before they reach session or activity logic. ACP types
will not enter the core business boundary; protocol-only updates without a
defined Cyrus behavior remain diagnostic data until a product requirement
justifies extending the neutral contract, preserving one shared
`ActivityMapper` and containing protocol churn inside the runner.
