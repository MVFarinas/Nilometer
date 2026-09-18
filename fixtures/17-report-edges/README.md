# 17-report-edges: Report edge cases

**Setup:** A request missing `output_tokens`, one with an unparseable timestamp, and one whose usage has an `advisor` iteration.

**Proves:** Each line still counts as a request; each problem appears in the report; the unparseable timestamp is excluded from day totals only.

**Rules:** D-007; ingest skill § 3–4. Expected values in `expected.json` were computed by hand from the setup above.
