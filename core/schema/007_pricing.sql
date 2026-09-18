-- 007_pricing: dated API list prices and the per-request cost view (D-005, D-006, D-020).
--
-- prices is replaced from core/pricing/prices.json on every ingest. request_costs prices each
-- deduplicated request at the row in effect on its UTC day, in SQL, from unrounded values. The
-- displayed label for these numbers is "observed tokens at API list price" (README principle 3):
-- a projection, never "what you would have spent".

CREATE TABLE prices (
  model_id                       TEXT NOT NULL, -- source: prices.json model_id (exact message.model string)
  effective_from                 TEXT NOT NULL, -- source: prices.json effective_from, YYYY-MM-DD; 0000-01-01 = since release (D-020)
  input_per_mtok                 REAL NOT NULL, -- source: pricing page, base input USD per million tokens
  output_per_mtok                REAL NOT NULL, -- source: pricing page, output
  cache_write_5m_per_mtok        REAL NOT NULL, -- source: pricing page, 5-minute cache writes
  cache_write_1h_per_mtok        REAL NOT NULL, -- source: pricing page, 1-hour cache writes
  cache_read_per_mtok            REAL NOT NULL, -- source: pricing page, cache hits and refreshes
  fast_input_per_mtok            REAL,          -- source: pricing page, fast mode input; NULL when not published
  fast_output_per_mtok           REAL,          -- source: pricing page, fast mode output
  fast_cache_write_5m_per_mtok   REAL,          -- source: pricing page, caching multipliers on fast input
  fast_cache_write_1h_per_mtok   REAL,          -- source: pricing page, caching multipliers on fast input
  fast_cache_read_per_mtok       REAL,          -- source: pricing page, caching multipliers on fast input
  standard_rate_max_input_tokens INTEGER,       -- source: prices.json; NULL when the full context window is standard-priced
  source_url                     TEXT NOT NULL, -- source: page the rates were read from
  verified_on                    TEXT NOT NULL, -- source: day the page was read, YYYY-MM-DD
  PRIMARY KEY (model_id, effective_from)
) STRICT;

ALTER TABLE requests ADD COLUMN service_tier TEXT; -- source: message.usage.service_tier when it's a string
ALTER TABLE requests ADD COLUMN inference_geo TEXT; -- source: message.usage.inference_geo when it's a string

-- Projected: each deduplicated request at API list price, or NULL cost with the reason it can't be priced.
CREATE VIEW request_costs AS
WITH matched AS (
  SELECT
    d.*,
    r.service_tier,
    r.inference_geo,
    substr(d.timestamp_utc, 1, 10) AS day_utc,
    d.input_tokens + d.cache_read_tokens + COALESCE(d.cache_write_5m_tokens, 0)
      + COALESCE(d.cache_write_1h_tokens, 0) + COALESCE(d.cache_write_unsplit_tokens, 0) AS total_input_tokens,
    (SELECT p.effective_from FROM prices p
       WHERE p.model_id = d.model AND p.effective_from <= substr(d.timestamp_utc, 1, 10)
       ORDER BY p.effective_from DESC LIMIT 1) AS price_effective_from
  FROM requests_dedup d
  JOIN requests r ON r.raw_line_id = d.raw_line_id
),
rated AS (
  SELECT
    m.*,
    p.verified_on,
    p.standard_rate_max_input_tokens,
    CASE
      WHEN m.timestamp_utc IS NULL THEN 'unparsed_timestamp'
      WHEN p.model_id IS NULL THEN 'no_price_row'
      WHEN m.speed = 'fast' AND p.fast_input_per_mtok IS NULL THEN 'fast_rate_unknown'
      WHEN m.service_tier IS NOT NULL AND m.service_tier <> 'standard' THEN 'service_tier_not_standard'
      WHEN p.standard_rate_max_input_tokens IS NOT NULL
           AND m.total_input_tokens > p.standard_rate_max_input_tokens THEN 'long_context_rate_unverified'
      ELSE NULL
    END AS unpriced_reason,
    CASE WHEN m.speed = 'fast' THEN p.fast_input_per_mtok ELSE p.input_per_mtok END AS rate_input,
    CASE WHEN m.speed = 'fast' THEN p.fast_output_per_mtok ELSE p.output_per_mtok END AS rate_output,
    CASE WHEN m.speed = 'fast' THEN p.fast_cache_write_5m_per_mtok ELSE p.cache_write_5m_per_mtok END AS rate_write_5m,
    CASE WHEN m.speed = 'fast' THEN p.fast_cache_write_1h_per_mtok ELSE p.cache_write_1h_per_mtok END AS rate_write_1h,
    CASE WHEN m.speed = 'fast' THEN p.fast_cache_read_per_mtok ELSE p.cache_read_per_mtok END AS rate_read,
    CASE WHEN m.inference_geo = 'us' THEN 1.1 ELSE 1.0 END AS geo_multiplier
  FROM matched m
  LEFT JOIN prices p ON p.model_id = m.model AND p.effective_from = m.price_effective_from
)
SELECT
  raw_line_id, dedup_key, model, day_utc, timestamp_utc, speed, service_tier, inference_geo,
  input_tokens, output_tokens, cache_read_tokens,
  cache_write_5m_tokens, cache_write_1h_tokens, cache_write_unsplit_tokens,
  unpriced_reason,
  price_effective_from,
  verified_on,
  -- 1 when unsplit cache writes were priced at the 5-minute rate, so the cost is a lower bound.
  CASE WHEN unpriced_reason IS NULL AND cache_write_unsplit_tokens > 0 THEN 1 ELSE 0 END AS is_lower_bound,
  CASE WHEN unpriced_reason IS NULL THEN input_tokens * rate_input * geo_multiplier / 1e6 END AS input_usd,
  CASE WHEN unpriced_reason IS NULL THEN output_tokens * rate_output * geo_multiplier / 1e6 END AS output_usd,
  CASE WHEN unpriced_reason IS NULL THEN cache_read_tokens * rate_read * geo_multiplier / 1e6 END AS cache_read_usd,
  CASE WHEN unpriced_reason IS NULL
       THEN (COALESCE(cache_write_5m_tokens, 0) + COALESCE(cache_write_unsplit_tokens, 0)) * rate_write_5m * geo_multiplier / 1e6 END AS cache_write_5m_usd,
  CASE WHEN unpriced_reason IS NULL THEN COALESCE(cache_write_1h_tokens, 0) * rate_write_1h * geo_multiplier / 1e6 END AS cache_write_1h_usd,
  CASE WHEN unpriced_reason IS NULL THEN
    (input_tokens * rate_input + output_tokens * rate_output + cache_read_tokens * rate_read
     + (COALESCE(cache_write_5m_tokens, 0) + COALESCE(cache_write_unsplit_tokens, 0)) * rate_write_5m
     + COALESCE(cache_write_1h_tokens, 0) * rate_write_1h) * geo_multiplier / 1e6
  END AS total_usd
FROM rated;

-- Observed: requests that couldn't be priced, and why (D-005: never $0, never a family fallback).
CREATE VIEW unpriced_requests AS
SELECT raw_line_id, dedup_key, model, day_utc, speed, service_tier, unpriced_reason
FROM request_costs
WHERE unpriced_reason IS NOT NULL;
