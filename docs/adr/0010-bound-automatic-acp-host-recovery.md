# Bound automatic ACP host recovery

If a shared ACP host fails during active work, Cyrus will restart it with bounded
backoff, resume affected Runner sessions, and make at most one automatic recovery
attempt per interrupted Prompt turn. Recovery sends a continuation instruction
against the existing transcript and worktree rather than replaying the original
prompt verbatim, then drains retained follow-up prompts; a second failure marks
the session interrupted and requires new user input, limiting duplicate side
effects and restart loops.
