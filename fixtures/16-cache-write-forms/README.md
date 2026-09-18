# 16-cache-write-forms: Split and unsplit cache writes

**Setup:** One request with the 5m/1h split object; one older-style request with only `cache_creation_input_tokens`.

**Proves:** Split values are kept per lifetime; the unsplit value is kept separately so pricing can label it a lower bound.

**Rules:** D-005; pricing-table skill. Expected values in `expected.json` were computed by hand from the setup above.
