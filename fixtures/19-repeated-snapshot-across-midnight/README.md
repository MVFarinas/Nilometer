# 19-repeated-snapshot-across-midnight

One API response written as three log lines that all carry the **same** token counts, straddling UTC
midnight: `2026-09-01T23:59:57Z`, `23:59:58Z`, and `2026-09-02T00:00:01Z`, each reporting 30 output
tokens.

**What it pins down:** which day a response lands on when the deduplication rule cannot choose.
Case 18 has growing counts, so "largest `output_tokens` wins" ([D-001](../../decisions.md)) selects
the final line by itself and the day follows from that. Here every line reports the same counts, the
rule selects nothing, and whichever tie-break runs next decides the date.

**The answer:** the earliest of the tied lines, so this counts on `2026-09-01`. That is the rule
[D-045](../../decisions.md) already states for collapsing duplicate readings — date it by when its
numbers first existed — applied to requests by [D-065](../../decisions.md). ccusage agrees.

**Why it exists:** this shape was found in a real log set (three lines, identical counts, spanning
23:59:57 to 00:00:01), where the two tools dated it differently and `nilometer verify` reported the
whole day as a difference.
