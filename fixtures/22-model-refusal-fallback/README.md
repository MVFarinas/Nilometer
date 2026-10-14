# 22-model-refusal-fallback: A request refused by one model and retried by another

**Setup:** One session on 2026-09-01.
- **Line 1:** a prompt.
- **Line 2:** a `system` line with subtype `model_refusal_fallback`: `claude-opus-5` refused request `req_22refused`, and `claude-sonnet-5` retried it.
- **Line 3:** Sonnet's own request (input 6, output 9).

No line records the refused request's tokens, as on the four real lines seen 2026-10-03.

**Proves:**
- **Line 2 is a `model_fallback` event,** with both models and the refused request's id, and is counted in the report's `lines`. It is not an ignored line.
- **The only request is Sonnet's:** 1 request, input 6, output 9. The refusal adds no tokens and no cost, because none were logged.
- **Line 1 is the one ignored line** (`user`).

**ccusage:** reads only request lines, so its totals equal ours. No known delta.

**Rules:** D-080; fixtures/README.md § Classification (rule 7) and § Events. Expected values in `expected.json` were computed by hand from the setup above.
