# 20-limit-quota-fields: Limit hits that carry `quotaLimits`

**Setup:** Seven `<synthetic>` limit-hit lines. From Claude Code 2.1.281 on (observed; D-067), a limit hit carries a `quotaLimits` object with the window (`rateLimitType`) and reset (`resetsAt`, Unix seconds) as fields:
- line 2: fields agree with the text (5-hour; resets 2026-09-02 06:10 UTC, which is what "6:10am (UTC)" resolves to).
- line 3: the text says weekly, the field says 5-hour.
- line 4: the text names no window; `rateLimitType` is an unrecognized value and `resetsAt` is a string.
- line 5: fields and text agree on the window but not the reset (the field says Sep 5 09:00, the text resolves to Sep 2 06:10).
- line 6: `quotaLimits` is `null`.
- line 7: no `quotaLimits`, as in older versions.
- line 8: the text names no window; the field says weekly, and `resetsAt` is `0`.

**Proves:** Every line is still one limit event. `quota_window` and `quota_resets_at` are read only from recognized values, and each unusable member present is reported, while an absent one isn't. A window disagreement between field and text is reported. Line 5's reset disagreement is reported by the loader as a line problem (`quota_reset_disagrees`), which isn't part of this README's report shape because resolving reset text is loader-only (D-023).

**Rules:** D-004, D-067. Expected values in `expected.json` were computed by hand from the setup above.
