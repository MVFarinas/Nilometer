-- 017_unattributed_usage_once: compute the reading pairs once per window instead of four times.
--
-- obs_unattributed_usage asked window_reading_pairs four separate correlated questions per window
-- instance, and window_reading_pairs answers each one by running its own correlated subquery over
-- parsed_lines for every pair. Reading the view took about 8.9 seconds on a real database, 55% of
-- the whole report, to return one row per window. The numbers were right; they were just computed
-- many times over.
--
-- The rewrite aggregates the pairs once, grouped by window instance, and joins that to the
-- instances. No column, value, or row changes: a window with no pairs reported zeros through the
-- subqueries and reports them through COALESCE here, and TOTAL() over no rows is 0.0, which the
-- COALESCE reproduces. Source: no API field; this view is built from status line readings (D-025,
-- D-044).
DROP VIEW obs_unattributed_usage;

-- Observed: per window, percentage points consumed with no Claude Code request in between (a lower bound), beside pair counts.
CREATE VIEW obs_unattributed_usage AS
WITH pair_totals AS (
  SELECT
    p.window,
    p.reset_at_utc,
    COUNT(*) AS pairs,
    COUNT(*) FILTER (WHERE p.requests_between = 0) AS pairs_without_requests,
    COUNT(*) FILTER (WHERE p.change_percentage_points < 0) AS decreasing_pairs,
    -- The same rows obs_unattributed_usage_events selects: rose, with no request in between.
    TOTAL(
      CASE WHEN p.requests_between = 0 AND p.change_percentage_points > 0
        THEN p.change_percentage_points END
    ) AS unattributed_percentage_points
  FROM window_reading_pairs p
  GROUP BY p.window, p.reset_at_utc
)
SELECT
  i.window,
  i.reset_at_utc,
  i.readings,
  COALESCE(t.pairs, 0) AS pairs,
  COALESCE(t.pairs_without_requests, 0) AS pairs_without_requests,
  COALESCE(t.decreasing_pairs, 0) AS decreasing_pairs,
  -- Fewer than two observations means no pair was observed: unknown, not 0.
  CASE WHEN i.readings >= 2 THEN COALESCE(t.unattributed_percentage_points, 0.0) END
    AS unattributed_percentage_points,
  i.window_open,
  i.covers_from,
  i.covers_to
FROM window_instances i
LEFT JOIN pair_totals t ON t.window = i.window AND t.reset_at_utc = i.reset_at_utc;
