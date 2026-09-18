---
name: add-metric
description: Add or change a metric, projection, or any number the viewer displays. Use before writing the SQL view, the viewer output, or the wording for anything a user will read, including labels, headings, and help text.
---

# Adding a metric

The README's Measurement Principles decide whether a metric may exist. This skill is the checklist that makes it compliant. A metric is **done** only when every box below is checked.

## 0. Classify it before writing SQL

Ask one question: **did an event recorded in `raw_lines` directly produce this number?**

- **Yes → observed.** Examples: a count of `limit_hit` events, the last `used_percentage` before a `resets_at`, tokens per model.
- **It needs a rate, a model of behavior, or an extrapolation → projection.** Examples: burn rate, observed tokens at API list price.
- **It needs an imagined timeline → not allowed** (principle 3). Examples: "what you would have spent", "time lost", "savings", which plan fits you, inferred limits (D-009, D-012). Offer the compliant version: usually the observed inputs side by side, with no subtraction or verdict.

Projections that other tools presented as fact, and which we won't copy:

| Tool | Projection presented as observed |
|---|---|
| Monitor | P90 "limits" labeled as machine learning with "95% accuracy"; hit = any message containing "rate" or "limit" |
| haasonsaas | weekly hours used, from invented hours-per-plan ranges, driving "approaching your limits" warnings |
| jimdawdy | 30-day projected cost in the same summary object as observed data |
| ccusage | `projection` and `burnRate` fields beside observed block totals in the same JSON |

## 1. Structure

- [ ] **Observed metrics and projections live in separate SQL views** (e.g. `obs_*` and `proj_*`) and separate output sections. Never a flag on a shared row, and never mixed in one JSON object.
- [ ] **The view returns the date range it covers:** `covers_from` and `covers_to`, computed from the data actually present, not from the filter the user asked for. Rate-limit-derived metrics start at the first spool reading. Log-derived metrics start at the oldest ingested line (README principle 5, D-004).
- [ ] **The view can return its contributing events:** a companion query or column that lists the `raw_lines` IDs, request IDs, or reading IDs behind each number (principle 4). If it can't, the metric isn't done.
- [ ] **Computed in SQL** from unrounded values. Rounding happens once, in the viewer.
- [ ] **Unknowns stay unknown:** NULL shows as "unknown", never 0 (Monitor d6e372d). Show unpriced tokens, unparsed reset times, and unkeyed requests as counts next to the metric.
- [ ] **Per request, not per session,** for model and time buckets (D-007). The display timezone's name is printed.

## 2. Wording

- [ ] The label states what was measured: *elapsed lockout time*, *last observed usage before reset (lower bound)*, *your observed tokens at API list price*.
- [ ] Projections carry the word **estimate** or **projected** in the label itself, not only in a footnote.
- [ ] **Caveats sit next to the number.** Examples: headroom is a lower bound, since usage after the last turn isn't seen. Cost covers Claude Code only. A resumed session may have been auto-resumed.
- [ ] No banned phrasing (CLAUDE.md plus D-012): *time lost, wasted, would have spent, you should switch plans, savings, cheaper by, verdict, recommend, score, efficiency, productivity*.
- [ ] Nothing is phrased as advice or a warning. "Approaching your limits" is a judgment; "5-hour window: 92% used at 14:05" is an observation.

## 3. Tests

- [ ] **A fixture with a hand-computed expected value** for the metric, worked out on paper from the fixture, not by running the query.
- [ ] **An edge-case fixture:** an empty range, a single event, an unknown value, and a range spanning the `init` boundary where log-derived and payload-derived coverage differ.
- [ ] **The banned-phrase test runs over the viewer's rendered output,** both the table and the page. After adding new wording, **prove the guard still works**: inject one banned phrase into a throwaway copy, watch the test fail, then revert. A guard that has never failed isn't known to work.
- [ ] **The traceability query's events reproduce the number:** re-sum the returned events in the test and compare.

## 4. Record it

- [ ] The README's MVP table lists the metric and its source.
- [ ] If the metric needed a judgment call (a threshold, a definition of "mid-task", how to treat a gap), write an ADR in `decisions.md` with the options rejected.
