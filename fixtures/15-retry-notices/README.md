# 15-retry-notices: Retry notices

**Setup:** Two `system`/`api_error` retry notices with status 429 (the second with non-null `error.rateLimits`) and a `system`/`turn_duration` line.

**Proves:** Two retry-notice events, zero limit hits. The non-null `rateLimits` is counted in the report; the other system line is ignored by subtype.

**Rules:** D-019; skill fixture 15. Expected values in `expected.json` were computed by hand from the setup above.
