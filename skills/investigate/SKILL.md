---
name: investigate
description: Researches the codebase to answer a question — searches for relevant files, gathers context, and provides a clear, direct answer. Use for questions and research requests where no code change is expected. Not for making code changes (use implementation or debug).
---

# Investigate

Research the codebase and provide a clear, direct answer to the question.

## Approach

1. **Search** — Search the codebase for relevant files, functions, and patterns
2. **Read** — Read necessary files to understand the implementation
3. **Gather context** — Use tools as needed to collect comprehensive information
4. **Answer** — Provide a clear, direct answer using your findings

## Answer Format

- Present in Linear-compatible markdown
- Use `+++Section Name\n...\n+++` for collapsible sections with detailed information
- Include code references with file paths and line numbers
- For @mentions, use the Linear profile URL format from `<assignee>` context (e.g. `https://linear.app/<workspace>/profiles/<username>`)
- Be complete but concise — answer the question directly without unnecessary preamble
