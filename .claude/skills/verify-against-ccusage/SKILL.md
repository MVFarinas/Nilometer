---
name: verify-against-ccusage
description: Build or run the fidelity suite that proves ingestion and cost numbers are right, including the comparison against a pinned ccusage and the independent re-implementation check. Use before calling any ingest, dedup, or cost change done, and when numbers disagree with ccusage.
---

# Verifying the numbers

**Counts are necessary, not sufficient.** Row counts can match while token values are shifted, partial, or double-counted. This suite uses five checks, each stronger than the last, and `nilometer verify` carries the same comparison to a user's own machine. A change to ingest, dedup, or pricing isn't done until all five pass. Decisions: D-001, D-002, D-003, D-005, D-011.

## Fixtures

- **Synthetic only.** Real session logs contain prompts, code, and file paths from other repositories, and this repo is public.
- **Lay them out as Claude Code does:** `fixtures/<name>/projects/<encoded-project>/<session>.jsonl`, plus `.../<session>/subagents/*.jsonl`. Then the same directory works as `CLAUDE_CONFIG_DIR` for ccusage.
- **Build them from the real line shapes:** the `ingest-session-logs` skill's field table, and its fixture list of 14 cases. Keep a generator script, not only hand-written files. ccusage's `apps/ccusage/scripts/generate-large-fixture.ts` sizes synthetic files to match real-world size distributions, which is worth copying for a performance fixture.
- **Every fixture has an `expected.json`** written by hand: request count, tokens per model per token type, limit events, and cost for fixtures inside one price period.

## The five checks

1. **Key-set equality.** The set of deduplicated keys equals the expected set. This catches extra and duplicate rows that matching totals can hide.
2. **Per-column aggregate parity.** For each model and token type: count, sum, min, and max. Compute it independently (below) and by our SQL views, then compare.
3. **Row-by-row comparison.** Every deduplicated request's token fields and winning source line match the independent result.
4. **Idempotency.**
   - Fingerprint every derived table (hash of rows sorted by key).
   - Ingest again, run `--full`, then truncate-and-rewrite one fixture file.
   - Fingerprints must be byte-identical each time.
5. **Targeted edge checks:**
   - a mid-stream split across runs
   - a trailing partial line
   - a `/btw` replay
   - unkeyed rows reported, not dropped
   - a `<synthetic>` limit line producing zero tokens
   - unpriced models excluded and reported
   - malformed lines reported with their bytes

### Independent re-implementation

The checks compare our SQL against a **separate, deliberately naive implementation** of the D-001 and D-004 rules: a short standalone script, e.g. `scripts/fidelity/reference.py`, that reads the fixture JSONL directly.

- **Share no code.** It must not import the loader's parser, dedup, or classification helpers. The two have to agree independently, not share one mistake.
- **When a rule changes in `decisions.md`, change both implementations.** If only one changes, the suite fails, and that failure is the point.

## The same comparison, on a user's own logs

`nilometer verify` (D-064) applies the rules below where the logs actually are, not to the fixtures.
The comparison itself — `sameValue`, `diffTotals`, `normalizeCcusage` — lives in
`core/verify/compare.ts` and is **shared** by the audit and the command, so the two can never answer
"do these agree" differently. Change the rules in one place.

What `verify` deliberately does not do, and the audit still must:

- **Cost.** `verify` compares tokens only: cost needs both price tables to agree, which is a
  different question from whether the logs were read the same way. The fixture comparison checks
  cost, because there both tables are known.
- **Known deltas.** `verify` has no list of expected disagreements; it reports what it finds. The
  documented deltas below belong to the fixtures.
- **Everything already gone.** `verify` compares only days both sides can see, and excludes the
  current day, because ingestion is a snapshot and Claude Code keeps writing after it.

Its output carries no path, repository name, session id or prompt text, so a tester can send a
result without sending their data. A test asserts that; keep it true.

## Comparing against ccusage

The README names ccusage the reference implementation. Pin it and run it offline against fixtures only:

```bash
export CLAUDE_CONFIG_DIR="$PWD/fixtures/<name>"   # never the real ~/.claude
npx ccusage@20.0.20 claude daily   --json --mode calculate --offline -z UTC --breakdown
npx ccusage@20.0.20 claude session --json --mode calculate --offline -z UTC
```

- **`--mode calculate`:** prices from tokens. `auto` would use a legacy `costUSD` log field if present.
- **`--offline`:** uses its embedded price snapshot, so the result doesn't change from day to day.
- **What to compare:** per-day, per-model token totals by type and cost, over a **date range with no price change**. Our dated table and ccusage's current-rate snapshot legitimately disagree across a price change.
  - **Our tokens** come from `expected.json`.
  - **Our costs** come from running the real loader and `request_costs` over the same states (`loaderCosts`), because expected files hold no costs.
  - **Costs match within floating-point noise** (`sameValue`). As of 2026-09-13 they matched ccusage on every fixture state apart from the three documented deltas, and exactly on real logs.
- **Where not to compare:** ccusage's JSON doesn't split 5m and 1h cache writes, so compare cache writes as a combined total. Per-entry `costUSD` in `session --id` output is the raw log field; compare only `totalCost`.
- **When upgrading the pinned version,** re-run and review every changed expected value.

### Known deltas (expected disagreements)

Keep this list in the suite, and assert that each delta appears exactly where predicted. The field-level list lives in `KNOWN_DELTAS` in `scripts/compare/ccusage.ts`; a delta that stops occurring fails the check as stale:

| Delta | Why we differ |
|---|---|
| requests over the long-context threshold | ccusage bills each token type above 200K separately; we follow Anthropic's stated rule (D-005) |
| unpriced models | ccusage counts $0 plus a warning; we exclude them and report (D-005) |
| `fallback_message` iterations | ccusage doesn't price them (ccusage#1552) |
| requests with no `message.id` | ccusage doesn't dedup them; we fall back to `requestId` (D-001). Observed in fixture 05 |
| a log file rewritten shorter between ingests | ccusage re-reads current files, so removed requests vanish; we keep raw lines (D-002). Observed in fixture 12, run-2 |
| a request line missing `output_tokens` | ccusage drops the whole line; we count it with output 0 and report the missing field. Observed in fixture 17 |
| project grouping | ccusage uses the encoded directory name; we resolve `cwd` through git (D-010) |
| day buckets | ccusage with `-z UTC` vs our machine-local buckets; compare with our output forced to UTC |

**Handling a mismatch not on the list:** it's our bug, a new documented delta, or an ADR. Never adjust our numbers to make it go away.

## Proving the guards

Every check above must have failed at least once. For each one, write a throwaway mutation, watch the check fail, and revert:

- first-wins dedup
- counting a partial line
- dropping a malformed line
- pricing 1h writes at the 5m rate
- a prefix model match

Note in the test file which mutation proved it. A guard that has never failed isn't known to work.
