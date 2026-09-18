# 08-limit-hits: Limit hits from structured fields

**Setup:** Four `<synthetic>` lines with `error: "rate_limit"` and different wordings: session limit, weekly limit, older `5-hour limit reached`, and text with no window or reset.

**Proves:** Four limit events and zero extra requests or tokens. Window and reset parse where the text allows and are null otherwise; the event counts either way.

**Rules:** D-004; skill fixture 8. Expected values in `expected.json` were computed by hand from the setup above.
