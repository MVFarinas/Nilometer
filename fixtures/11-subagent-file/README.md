# 11-subagent-file: A subagent transcript

**Setup:** A request in the main session file and one in `<session>/subagents/agent-a1.jsonl`, which has `isSidechain: true` and the parent's session ID.

**Proves:** Both requests count, in the same session; discovery isn't depth-limited.

**Rules:** D-001; skill fixture 11. Expected values in `expected.json` were computed by hand from the setup above.
