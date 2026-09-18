# 10-malformed-lines: Malformed lines between valid ones

**Setup:** Line 2 is truncated JSON; line 3 is a JSON array.

**Proves:** Both are reported with their positions; the requests on lines 1 and 4 still count.

**Rules:** D-002 (report, don't fix); skill fixture 10. Expected values in `expected.json` were computed by hand from the setup above.
