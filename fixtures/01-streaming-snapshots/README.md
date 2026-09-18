# 01-streaming-snapshots: Streaming snapshots collapse to one request

**Setup:** One response (`msg_01a`) is written as three cumulative snapshots with output 5, 20, then 42. A second response (`msg_01b`) is written once.

**Proves:** Two requests; `msg_01a` counts its **final** output (42), not the sum (67) or the first (5).

**Rules:** D-001; skill fixture 1. Expected values in `expected.json` were computed by hand from the setup above.
