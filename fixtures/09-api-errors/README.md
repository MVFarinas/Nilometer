# 09-api-errors: Other synthetic and API error lines

**Setup:** A `server_error`, an unrecognized `billing_error`, an error line with no `error` field, and a non-error synthetic line.

**Proves:** None of these are limit hits or requests. Unrecognized and missing `error` values show up in the report.

**Rules:** D-004; skill fixture 9. Expected values in `expected.json` were computed by hand from the setup above.
