# 03-trailing-fragment: An incomplete last line

**Setup:** `run-1` ends with the first 40 bytes of the next line and no newline. `run-2` has the full line.

**Proves:** The fragment is neither malformed nor counted in `run-1`; the completed line counts once in `run-2`.

**Rules:** D-003; skill fixture 3. Expected values in `expected.json` were computed by hand from the setup above.
