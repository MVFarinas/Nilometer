# 07-utc-midnight: Requests around UTC midnight

**Setup:** Timestamps just before and after 00:00Z, plus one with a `+02:00` offset.

**Proves:** Day totals split across Sept 1 and 2; the offset timestamp lands on Sept 1 after conversion to UTC.

**Rules:** D-007; skill fixture 7. Expected values in `expected.json` were computed by hand from the setup above.
