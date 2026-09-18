# 04-btw-replay: A `/btw` sidechain replay

**Setup:** The same `message.id` appears again under a new `requestId` with `isSidechain: true`.

**Proves:** One request; the non-sidechain copy wins the tie. Keying on `requestId` alone would double-count it.

**Rules:** D-001; skill fixture 4. Expected values in `expected.json` were computed by hand from the setup above.
