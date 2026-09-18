-- 011_projections: projections derived from observations, kept apart from observed views (P6.4, D-026, D-027).
--
-- Every view here is a projection: it carries the proj_ prefix, and no obs_ view may read from it
-- (README principle 2; enforced by tests/unit/core/metrics/structure.test.ts). plan_prices is user
-- data entered with the plan-price command: not derived, never rebuilt, never committed.

CREATE TABLE plan_prices (
  effective_month TEXT PRIMARY KEY, -- source: user entry, YYYY-MM (local calendar month from which the price applies)
  plan_name       TEXT NOT NULL,    -- source: user entry, the plan's name as the user writes it
  usd_per_month   REAL NOT NULL,    -- source: user entry, the plan's USD list price per month (README, Currency)
  entered_at      TEXT NOT NULL,    -- derived: ISO-8601 UTC time the row was written
  CHECK (effective_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  CHECK (usd_per_month >= 0)
) STRICT;

-- Projected: when each window's limit would be reached at its average rate since the window began (D-026).
CREATE VIEW proj_burn_rate AS
WITH timed AS (
  SELECT
    h.*,
    unixepoch(h.reset_at_utc) - CASE h.window WHEN 'five_hour' THEN 5 * 3600 ELSE 7 * 86400 END AS window_start_s,
    unixepoch(h.last_reading_at_utc, 'subsec') AS last_reading_s
  FROM obs_window_headroom h
)
SELECT
  window,
  reset_at_utc,
  strftime('%Y-%m-%dT%H:%M:%fZ', window_start_s, 'unixepoch') AS window_start_utc,
  last_used_percentage,
  last_reading_at_utc,
  window_open,
  last_used_percentage >= 100 AS limit_reached,
  -- Unknown without a reading after the window start: the premise (0% at the start) can't apply.
  CASE WHEN last_reading_s > window_start_s
       THEN last_used_percentage * 3600.0 / (last_reading_s - window_start_s)
  END AS projected_percentage_points_per_hour,
  CASE WHEN last_reading_s > window_start_s AND last_used_percentage > 0 AND last_used_percentage < 100
       THEN strftime('%Y-%m-%dT%H:%M:%fZ',
                     window_start_s + (last_reading_s - window_start_s) * 100.0 / last_used_percentage,
                     'unixepoch')
  END AS projected_limit_at_utc,
  CASE WHEN last_reading_s > window_start_s AND last_used_percentage > 0 AND last_used_percentage < 100
       THEN window_start_s + (last_reading_s - window_start_s) * 100.0 / last_used_percentage < unixepoch(reset_at_utc)
  END AS projected_limit_before_reset,
  covers_from,
  covers_to
FROM timed;

-- Projected: observed tokens at API list price per local calendar month, beside the plan price entered for that month (D-027).
CREATE VIEW proj_api_list_price AS
WITH months AS (
  SELECT
    strftime('%Y-%m', timestamp_utc, 'localtime') AS month,
    COUNT(*) AS requests,
    COUNT(*) FILTER (WHERE unpriced_reason IS NULL) AS priced_requests,
    COUNT(*) FILTER (WHERE unpriced_reason IS NOT NULL) AS unpriced_requests,
    COUNT(*) FILTER (WHERE is_lower_bound = 1) AS lower_bound_requests,
    COUNT(*) FILTER (WHERE unpriced_reason IS NULL AND day_utc < verified_on) AS priced_before_verified_requests,
    MAX(verified_on) AS verified_on,
    TOTAL(total_usd) AS priced_usd,
    MIN(timestamp_utc) AS covers_from,
    MAX(timestamp_utc) AS covers_to
  FROM request_costs
  WHERE timestamp_utc IS NOT NULL
  GROUP BY month
)
SELECT
  m.month,
  m.requests,
  m.priced_requests,
  m.unpriced_requests,
  m.lower_bound_requests,
  m.priced_before_verified_requests,
  m.verified_on,
  -- No priced request in the month: the cost is unknown, not $0.
  CASE WHEN m.priced_requests > 0 THEN m.priced_usd END AS api_list_price_usd,
  (SELECT p.plan_name FROM plan_prices p WHERE p.effective_month <= m.month
     ORDER BY p.effective_month DESC LIMIT 1) AS plan_name,
  (SELECT p.usd_per_month FROM plan_prices p WHERE p.effective_month <= m.month
     ORDER BY p.effective_month DESC LIMIT 1) AS plan_usd_per_month,
  m.covers_from,
  m.covers_to
FROM months m;
