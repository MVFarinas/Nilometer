# 02-split-across-runs: A response split across two ingests

**Setup:** `run-1` is captured mid-stream (snapshots 5 and 20); `run-2` has the finished file (adds 42).

**Proves:** After `run-1`: output 20. After `run-2`: output 42, replacing 20, never added to it and never stuck at the first value seen.

**Rules:** D-001, D-003; skill fixture 2. Expected values in `expected.json` were computed by hand from the setup above.
