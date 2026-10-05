# 21-null-iteration-model: A message iteration with a null model

**Setup:** Two Sonnet 5 responses on 2026-09-01. Line 1 (input 4, output 12) has the usual `iterations: [{ "type": "message" }]`. Line 2 (input 3, output 8) has `iterations: [{ "type": "message", "model": null }]`, a shape seen once in a real log set.

**Proves:** Both lines are requests and both count: 2 requests, input 7, output 20. A `message` iteration is not reported as a non-message iteration, whatever its `model` holds.

**ccusage:** 20.0.20 drops line 2 entirely and counts input 4, output 12. With `model` absent or a string, it counts the line. This is a known delta: the API served the request, so it counts (README principle 1).

**Rules:** D-007; ingest skill § 3. Expected values in `expected.json` were computed by hand from the setup above.
