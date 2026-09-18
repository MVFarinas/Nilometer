# 05-missing-ids: Missing message and request IDs

**Setup:** Two snapshots with only a `requestId`, one line with only a `message.id`, and two lines with neither.

**Proves:** Fallback to `requestId` dedups the first pair; the two ID-less lines pass through as separate unkeyed requests and are counted in the report, with no invented keys.

**Rules:** D-001; skill fixture 5. Expected values in `expected.json` were computed by hand from the setup above.
