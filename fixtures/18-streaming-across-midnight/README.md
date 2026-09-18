# 18-streaming-across-midnight

One API response written as two cumulative streaming snapshots, 5 seconds apart, straddling UTC
midnight: the first at `2026-09-01T23:59:58Z` with 10 output tokens, the second at
`2026-09-02T00:00:03Z` with 25.

**What it pins down:** which day a response counts on when its snapshots fall on either side of
midnight. Deduplication keeps the largest `output_tokens` (D-001), which is the final snapshot, so
the request is dated `2026-09-02` — when the response finished, not when it started. Case 07 covers
day boundaries but gives every response a single line, so nothing else here exercises this.

**Why it matters:** it is the one case where the tie-break in D-001 moves a number between days
rather than only choosing between equal ones, and it is the case the ccusage comparison has to agree
on for the reference implementation to mean anything here.
