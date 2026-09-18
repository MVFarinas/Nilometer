---
name: pricing-table
description: Add, correct, or restructure the dated API price table and the SQL cost view. Use when a new Claude model appears in logs, a price changes, the ingest report shows unpriced tokens, or cost numbers disagree with ccusage.
---

# Pricing table and cost view

Decisions: D-005 (dated table, exact match, unpriced over guessed), D-006 (cost computed at query time), D-011 (verification against ccusage). The displayed label is always **"observed tokens at API list price"** (README principle 3).

## Getting a rate: sourced, never recalled

Every studied tool shipped wrong prices. Rates come from Anthropic's published pricing page, read at the time of the change. Never from memory, a blog post, or LiteLLM alone. Use the `claude-api` skill to find current model IDs and pricing, then confirm against the official page.

LiteLLM's `model_prices_and_context_window.json` is useful as a **second opinion**. If it disagrees with Anthropic's page, Anthropic wins, and the disagreement goes into the commit message.

## Where the table lives (D-020)

- **Rows:** `core/pricing/prices.json`, validated by `core/pricing/prices.ts` and synced into the `prices` table on every ingest. Edit the file, never the database.
- **`effective_from: "0000-01-01"`** means "in effect since release as far as can be verified". The pricing page publishes today's rates, not history. A real price change adds a row with the date from the announcement that states it.
- **The cost view is `request_costs`** (migration 007). Requests it can't price carry `unpriced_reason`:

  | Reason | When |
  |---|---|
  | `unparsed_timestamp` | the request has no parseable timestamp |
  | `no_price_row` | the model has no row |
  | `fast_rate_unknown` | the request used fast mode and the model has no fast rates |
  | `service_tier_not_standard` | the request's service tier isn't standard |
  | `long_context_rate_unverified` | total input exceeds `standard_rate_max_input_tokens` |

- **`inference_geo: "us"`** multiplies every token type by 1.1 (pricing page, Claude 4.6 and later).
- **Fast mode** rates are stored as published ($10/$50 for Opus 5 and 4.8), with caching multipliers applied to the fast input rate.

## Row shape

One row per `(model_id, effective_from)`:

| Field | Rule |
|---|---|
| `model_id` | exact string as it appears in `message.model` (e.g. `claude-sonnet-5`) |
| `effective_from` | UTC date the rate took effect; the first row for a model uses its release date |
| `input_per_mtok` | USD per million tokens |
| `output_per_mtok` | |
| `cache_write_5m_per_mtok` | explicit value, not "1.25 × input" computed in code |
| `cache_write_1h_per_mtok` | explicit value. phuryn priced these as 5m and undercounted cache-write cost by 49% (phuryn#162) |
| `cache_read_per_mtok` | |
| `long_context_*` | only if Anthropic prices it, with the threshold and the rule for which tokens it applies to, written as Anthropic states it |
| `fast_multiplier` | only if Anthropic publishes one for this model; otherwise NULL, and fast requests are reported as unpriced-fast |
| `source_url` | page the rate was read from |
| `verified_on` | date someone read that page |

- **Don't express rates as multipliers of input.** Multipliers are what let a wrong base rate spread to every other token type (jimdawdy's Opus at 3×, Monitor#182).
- **A price change adds a row. It never edits the old one.** Editing an old row changes history; that's jimdawdy's retroactive repricing.

## Cost view rules

- Join each deduplicated request to the row with the same `model_id` and the latest `effective_from <= request date`.
- **No row → unpriced.**
  - Excluded from cost sums.
  - The output shows "N tokens unpriced (models: ...)" next to the total.
  - Never shown as $0 (haasonsaas, phuryn#21).
  - Never priced as its model family (phuryn#175 priced a new Sonnet at the old Sonnet's rate).
- **No fuzzy or prefix matching.** `claude-opus-4` matching `claude-opus-4-7` is how jimdawdy mispriced a model, and ccusage#934 overcharged 5×.
- **Old logs without the 5m/1h split:** price `cache_write_unsplit_tokens` at the 5m rate. Label the result as a lower bound in the output.
- **Compute from unrounded values.** Round only at display.
- **The view returns request IDs**, so every cost number can be traced back to its requests (principle 4).

## Workflow: a new model shows up as unpriced

1. Confirm the exact `model_id` string from the ingest report.
2. Read the rates from Anthropic's pricing page and fill in every field above.
3. Add the row in a migration or seed file with `source_url` and `verified_on`.
4. Add a fixture request for the model with a hand-computed expected cost. Work it out by hand, not by running the view.
5. Run the ccusage comparison (see `verify-against-ccusage`) for a date range after `effective_from`.

## Where we intentionally differ from ccusage

Record each of these in the verification suite's known-deltas list, not by bending our math:

- **Dated prices:** ccusage applies current rates to old requests.
- **Long-context pricing:** ccusage bills each token type above 200K separately; follow Anthropic's stated rule instead.
- **`fallback_message` iterations:** ccusage doesn't handle them (ccusage#1552); we report them until an ADR decides.
- **Unpriced models:** ccusage shows $0 plus a warning; we exclude them and report the token count.
