# 12-rewritten-file: A file rewritten shorter between runs

**Setup:** `run-1` has three requests. By `run-2` the file was rewritten to one old line plus one new request.

**Proves:** Cumulative ingest keeps the two requests no longer on disk: they happened. Four requests after `run-2`.

**Rules:** D-002, D-003; skill fixture 12. Expected values in `expected.json` were computed by hand from the setup above.
