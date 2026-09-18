# Nilometer

A local tool that reads Claude Code's status line payload and session logs, then reports the
observed cost of a Claude subscription in both directions: interruptions when the plan is too
small, and unused headroom when it is too big.

**[`README.md`](README.md) is the specification and the source of truth.** Read all of it before
proposing code, metrics, or UI. Its **Measurement Principles** win over every other consideration,
including a request for a metric that breaks them. When that happens, say which principle it
breaks and offer the compliant version: reworked, or labeled as a projection.

**[`decisions.md`](decisions.md) records why things are built the way they are**, with the options that were rejected. Many entries are lessons from five existing Claude usage tools. Check it before re-deciding anything, and add an entry for any new judgment call.

**Skills in `.claude/skills/`** are the build checklists: `ingest-session-logs`, `statusline-collector`, `pricing-table`, `add-metric`, `verify-against-ccusage`. Load the matching one before working in that area.

**[`docs/development.md`](docs/development.md) holds the Standards and the audit,** which are binding for all
code, and the build history that code cites (`docs/development.md P4.5`). The Standards require:
- TSDoc on every function
- inline comments explaining *why* on every non-obvious line
- a source comment on every schema column
- 100% function coverage
- an audit record per change

This project wants more documentation than a default code style would write.

## Rules the code must hold to

These are the places an implementation most easily drifts from the README.

### Observed vs. projected is structural, not cosmetic

- **Projections are a separate type and a separate view from observations**, not a flag on the
  same row. Then no query can headline a projection by accident (principle 2).
- **Every metric carries the date range it covers** (principle 5). Usage-percentage metrics
  (headroom, peak, unattributed) start at `init`. Token and limit-hit metrics start at the oldest
  backfilled log (D-004). Never render a number without its span.
- **Every displayed number resolves back to the events it was computed from** (principle 4). If a
  query cannot return its contributing events, the metric is not done.
- **Round only at display.** Compute percentages, sums, and costs from unrounded values.

### Wording is part of correctness

Banned framings: *time lost*, *wasted*, *would have spent*, *you should switch plans*, *savings*,
*cheaper by*, *verdict*, *recommend*, and any productivity or efficiency score (D-012). Use the README's wording instead: *elapsed lockout time*, *your
observed tokens at API list price*.

Enforce this with a test that fails when a banned phrase appears in viewer output. **Prove the
test works by injecting a banned phrase once and watching it fail.** A guard that has never failed
is not known to work.

### Ingestion

- **Deduplicate by `(sessionId, message.id)`; the largest `output_tokens` wins** (D-001). One API
  response is written as several cumulative JSONL lines, and `/btw` replays reuse `message.id`
  under a new `requestId`. Never invent a key for a line missing both IDs; report it.
- **Limit hits are the structured `error: "rate_limit"` field on `<synthetic>` lines** (D-004),
  never a text match. Synthetic lines are events, not requests: no tokens, no cost.
- **A missing rate-limit window means it reset**, not that data is missing. `rate_limits` only
  appears after a session's first API response.
- **`cost.total_cost_usd` is a cross-check, never a source.**
- **Copy logs into SQLite.** Claude Code deletes session logs after 30 days by default.
- **Re-runnable:** ingesting the same logs twice yields identical tables. Make `init`'s backfill
  safe to repeat.
- **Report, don't fix.** Record malformed or unrecognized lines with their raw content and surface
  a count. Never silently drop or repair them.
- **The payload shape is not a stable public API.** Version the ingest schema from the first
  migration, and keep the raw payload so readings can be re-ingested after a shape change.
- **Resolve a working directory to a repository through git, not by directory name.** Use
  `git -C <cwd> rev-parse --git-common-dir`. A worktree is a different directory but the same repo,
  and a subdirectory is not a separate project. A `cwd` that no longer exists on disk stays
  attributable by path and is labeled as such.

### Verification: counts are necessary, not sufficient

Row counts can match while values are wrong. Check cost math against **ccusage** on the same logs
(the README names it the reference implementation). Test ingestion with an **independent
re-implementation** of the rules, rather than importing the loader's own helpers, so the two have
to agree instead of sharing one mistake.

### Everything else

- **Pricing** is a dated table keyed by model and effective date. Price each request at the rate in
  effect on its own date. USD throughout.
- **Analysis lives in SQL** (views and queries), not in JS that fetches rows and filters them.
- **Never clobber `statusLine`.** `init` wraps an existing entry and passes its output through
  unchanged. Back up `settings.json` before writing to it, and make `init` idempotent: running it
  twice must not wrap the wrapper.

## Conventions

- **Nothing personal in commits:** no spend figures, real log content, credentials, or
  machine-specific paths. The personal-data and secret scans (A10) must pass.
- **Test fixtures are synthetic.** Real session logs contain prompts, file paths, and code from
  other repositories.
- **Record design decisions** in `decisions.md`, with the options that were rejected.
- No AI co-author trailers in commit messages.
