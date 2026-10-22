-- 031_cte_cursor_budget: the lockout views read each costly view once, so they prepare on SQLite 3.54 (D-094, step G5.2).
--
-- SQLite 3.54.0 refuses a statement once a CTE's cursor number passes SQLITE_LIMIT_EXPR_DEPTH (1,000), with
-- "VIEWs and/or subqueries nested too deep". Every reference to a view expands it again, cursors and all, so a
-- view read four times costs four times its cursors. obs_lockout_intervals read the lockout hits four times
-- (593 by that measure), and obs_lockout_time and obs_interruptions_by_plan read it twice more: over the limit.
-- Node 26 bundles 3.54.0. Same rows, same columns, same order; only how often each view is read changes.

DROP VIEW obs_lockout_intervals;

-- Observed: elapsed lockout intervals (limit hit to reset, overlapping hits merged), with the next request after each reset, logged auto-continuations, and the sessions and refused requests in each (D-023, D-077, D-090).
CREATE VIEW obs_lockout_intervals AS
WITH continuation_counts AS (
  -- Logged auto-continuations per limit hit, counted before the join so a hit stays one row.
  SELECT hit_raw_line_id, COUNT(*) AS marks, MIN(continued_at_utc) AS first_continued_at_utc
  FROM auto_continuation_marks
  WHERE hit_raw_line_id IS NOT NULL
  GROUP BY hit_raw_line_id
),
grouped AS (
  -- One pass over the lockout hits: each is one row (its raw line), and every join below is one-to-one.
  SELECT
    h.interval_number,
    MIN(h.start_utc) AS locked_from_utc,
    MAX(h.end_utc) AS locked_until_utc,
    COUNT(*) AS hits,
    -- A logged hit names its session; a status-line-only hit is a spool reading, which names one too.
    COUNT(DISTINCT COALESCE(p.session_id, s.session_id)) AS sessions,
    -- Hits from the session logs: each is a request the limit refused.
    COUNT(p.raw_line_id) AS refused_requests,
    SUM(m.marks) AS auto_continuations,
    MIN(m.first_continued_at_utc) AS first_continued_at_utc
  FROM obs_lockout_interval_hits h
  LEFT JOIN parsed_lines p ON p.raw_line_id = h.raw_line_id
  LEFT JOIN status_readings s ON s.raw_line_id = h.raw_line_id
  LEFT JOIN continuation_counts m ON m.hit_raw_line_id = h.raw_line_id
  GROUP BY h.interval_number
),
with_next AS (
  SELECT
    g.*,
    (SELECT MIN(d.timestamp_utc) FROM requests_dedup d WHERE d.timestamp_utc >= g.locked_until_utc) AS next_request_at_utc
  FROM grouped g
)
SELECT
  w.interval_number,
  w.locked_from_utc,
  w.locked_until_utc,
  w.hits,
  w.next_request_at_utc,
  (round(unixepoch(w.locked_until_utc, 'subsec') * 1000) - round(unixepoch(w.locked_from_utc, 'subsec') * 1000)) / 1000.0 AS lockout_seconds,
  (round(unixepoch(w.next_request_at_utc, 'subsec') * 1000) - round(unixepoch(w.locked_until_utc, 'subsec') * 1000)) / 1000.0 AS reset_to_next_request_seconds,
  w.locked_until_utc > (SELECT covers_to FROM source_coverage WHERE source = 'session_logs') AS reset_after_coverage,
  -- How many sessions Claude Code resumed by itself after this reset, as logged; 0 when none.
  COALESCE(w.auto_continuations, 0) AS auto_continuations,
  -- The earliest of those, seconds after the reset; NULL when none. The reset is one time per lockout, so the
  -- earliest continuation gives the smallest difference.
  (round(unixepoch(w.first_continued_at_utc, 'subsec') * 1000) - round(unixepoch(w.locked_until_utc, 'subsec') * 1000)) / 1000.0
    AS first_auto_continuation_seconds,
  -- Distinct sessions with a hit in this lockout (D-090).
  w.sessions,
  -- Its logged hits, each a refused request; the rest of its hits are status line readings at 100% (D-023, D-090).
  w.refused_requests
FROM with_next w;

DROP VIEW obs_lockout_time;

-- Observed: total elapsed lockout time (hit → reset, overlaps counted once), beside hits whose reset is unknown.
CREATE VIEW obs_lockout_time AS
SELECT
  COUNT(*) AS intervals,
  TOTAL(lockout_seconds) AS lockout_seconds,
  -- Every hit with a known reset is in exactly one interval, so the intervals' hits add up to them.
  COALESCE(SUM(hits), 0) AS hits_with_known_reset,
  (SELECT COUNT(*) FROM obs_limit_hits_events WHERE reset_at_utc IS NULL OR hit_at_utc IS NULL) AS hits_with_unknown_reset,
  (SELECT covers_from FROM source_coverage WHERE source = 'session_logs') AS covers_from,
  (SELECT covers_to FROM source_coverage WHERE source = 'session_logs') AS covers_to
FROM obs_lockout_intervals;

DROP VIEW obs_interruptions_by_plan;

-- Observed: limit hits, lockouts, and elapsed lockout time per plan period, each with its own span (D-075).
CREATE VIEW obs_interruptions_by_plan AS
WITH periods AS (
  SELECT 'plan' AS period_kind, from_month, until_month, plan_name FROM plan_periods
  UNION ALL
  -- Before the first entered plan; with no plan entered, the whole history.
  SELECT 'none', NULL, (SELECT MIN(from_month) FROM plan_periods), NULL
  UNION ALL
  -- Hits with no time: counted, so the rows add up to obs_limit_hits, but in no period.
  SELECT 'unknown', NULL, NULL, NULL
),
-- Materialized: the hit view is among the costliest on real data (D-059), and two CTEs read it.
hits AS MATERIALIZED (
  SELECT period_kind, from_month, window, hit_at_utc FROM obs_limit_hits_by_plan_events
),
-- Counted per period once, then joined: a subquery per count would read the views once per count (D-094).
hit_counts AS (
  SELECT
    period_kind,
    from_month,
    COUNT(*) AS hits,
    SUM(window = 'five_hour') AS five_hour_hits,
    SUM(window = 'seven_day') AS seven_day_hits,
    SUM(window IS NULL) AS unknown_window_hits
  FROM hits
  GROUP BY period_kind, from_month
),
lock_counts AS (
  SELECT period_kind, from_month, COUNT(*) AS lockouts, TOTAL(lockout_seconds) AS lockout_seconds
  FROM obs_lockout_by_plan_events
  GROUP BY period_kind, from_month
),
-- What a period's span is drawn from: request times and hit times, each with its local month.
dated AS MATERIALIZED (
  SELECT timestamp_utc AS at_utc, strftime('%Y-%m', timestamp_utc, 'localtime') AS month
  FROM requests_dedup WHERE timestamp_utc IS NOT NULL
  UNION ALL
  SELECT hit_at_utc, strftime('%Y-%m', hit_at_utc, 'localtime') FROM hits WHERE hit_at_utc IS NOT NULL
),
counted AS (
  SELECT
    p.period_kind,
    p.from_month,
    -- The last month the plan applies, for display: the month before until_month.
    CASE WHEN p.until_month IS NOT NULL
      THEN strftime('%Y-%m', p.until_month || '-01', '-1 month') END AS to_month,
    p.until_month,
    p.plan_name,
    COALESCE(hc.hits, 0) AS hits,
    COALESCE(hc.five_hour_hits, 0) AS five_hour_hits,
    COALESCE(hc.seven_day_hits, 0) AS seven_day_hits,
    COALESCE(hc.unknown_window_hits, 0) AS unknown_window_hits,
    COALESCE(lc.lockouts, 0) AS lockouts,
    -- TOTAL, as obs_lockout_time totals intervals: 0 over none.
    COALESCE(lc.lockout_seconds, 0.0) AS lockout_seconds,
    -- The span the period's data covers, from what is in it (principle 5); none for 'unknown'.
    (SELECT MIN(d.at_utc) FROM dated d WHERE p.period_kind <> 'unknown'
       AND (p.from_month IS NULL OR d.month >= p.from_month)
       AND (p.until_month IS NULL OR d.month < p.until_month)) AS covers_from,
    (SELECT MAX(d.at_utc) FROM dated d WHERE p.period_kind <> 'unknown'
       AND (p.from_month IS NULL OR d.month >= p.from_month)
       AND (p.until_month IS NULL OR d.month < p.until_month)) AS covers_to
  FROM periods p
  -- IS, not =: the 'none' and 'unknown' periods have no month, and NULL = NULL is never true.
  LEFT JOIN hit_counts hc ON hc.period_kind = p.period_kind AND hc.from_month IS p.from_month
  LEFT JOIN lock_counts lc ON lc.period_kind = p.period_kind AND lc.from_month IS p.from_month
)
SELECT *
FROM counted
-- A period appears when it holds a hit or any dated data; an entry for a month with no data, or
-- a plan entered for the future, has nothing to report.
WHERE hits > 0 OR covers_from IS NOT NULL;
