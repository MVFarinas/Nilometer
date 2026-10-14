-- 021_plan_periods: limit hits, lockouts, and elapsed lockout time per plan period (D-075, step G2.2).
--
-- The interruption counts span the whole log history (D-004), so after a plan change one count
-- mixed two plans: a hit on the plan before an upgrade counted beside hits on the plan after it.
-- The plan in effect comes from what the user entered with plan-price set (D-027): a plan applies
-- from the first day of its entered month, in the process's local zone, until the next entry's.
--
-- Observed views may not read plan_prices, which holds prices (structure.test.ts). plan_periods
-- reads only its names and months, and the structure test lets an observed view reach plan_prices
-- through plan_periods alone, and fails if plan_periods ever reads a price. The counts stay
-- observations: each hit and lockout is an event, and the plan is a label the user supplied.

-- Helper: each entered plan's months, from its effective month until the next entry's (D-027, D-075).
CREATE VIEW plan_periods AS
SELECT
  effective_month AS from_month, -- source: plan_prices.effective_month, the first local month the plan applies
  -- derived: the next entry's month, where this plan stops applying (exclusive); NULL while it applies.
  LEAD(effective_month) OVER (ORDER BY effective_month) AS until_month,
  plan_name -- source: plan_prices.plan_name, as the user wrote it
FROM plan_prices;

-- Observed: each limit hit, with the plan period its local month falls in (D-075).
CREATE VIEW obs_limit_hits_by_plan_events AS
SELECT
  e.raw_line_id,
  e.session_id,
  e.hit_at_utc,
  e.window,
  e.source,
  -- 'plan' inside an entered plan's months, 'none' before the first entry (or with none at all),
  -- and 'unknown' for a hit with no time, which no month can place.
  CASE
    WHEN e.hit_at_utc IS NULL THEN 'unknown'
    WHEN p.from_month IS NULL THEN 'none'
    ELSE 'plan'
  END AS period_kind,
  p.from_month,
  p.until_month,
  p.plan_name
FROM obs_limit_hits_events e
-- Periods never overlap, so a hit matches at most one; months compare as YYYY-MM text.
LEFT JOIN plan_periods p
  ON e.hit_at_utc IS NOT NULL
 AND strftime('%Y-%m', e.hit_at_utc, 'localtime') >= p.from_month
 AND (p.until_month IS NULL OR strftime('%Y-%m', e.hit_at_utc, 'localtime') < p.until_month);

-- Observed: each lockout interval, with the plan period its first hit falls in (D-075).
-- An interval crossing a period boundary belongs to the period where it began, so it is never
-- split or counted twice.
CREATE VIEW obs_lockout_by_plan_events AS
SELECT
  i.*,
  CASE WHEN p.from_month IS NULL THEN 'none' ELSE 'plan' END AS period_kind,
  p.from_month,
  p.until_month,
  p.plan_name
FROM obs_lockout_intervals i
LEFT JOIN plan_periods p
  ON strftime('%Y-%m', i.locked_from_utc, 'localtime') >= p.from_month
 AND (p.until_month IS NULL OR strftime('%Y-%m', i.locked_from_utc, 'localtime') < p.until_month);

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
-- Materialized: the hit and lockout views are among the costliest on real data (D-059), and every
-- period reads them.
hits AS MATERIALIZED (
  SELECT period_kind, from_month, window, hit_at_utc FROM obs_limit_hits_by_plan_events
),
locks AS MATERIALIZED (
  SELECT period_kind, from_month, lockout_seconds FROM obs_lockout_by_plan_events
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
    (SELECT COUNT(*) FROM hits h WHERE h.period_kind = p.period_kind AND h.from_month IS p.from_month) AS hits,
    (SELECT COUNT(*) FROM hits h WHERE h.period_kind = p.period_kind AND h.from_month IS p.from_month
       AND h.window = 'five_hour') AS five_hour_hits,
    (SELECT COUNT(*) FROM hits h WHERE h.period_kind = p.period_kind AND h.from_month IS p.from_month
       AND h.window = 'seven_day') AS seven_day_hits,
    (SELECT COUNT(*) FROM hits h WHERE h.period_kind = p.period_kind AND h.from_month IS p.from_month
       AND h.window IS NULL) AS unknown_window_hits,
    (SELECT COUNT(*) FROM locks l WHERE l.period_kind = p.period_kind AND l.from_month IS p.from_month) AS lockouts,
    -- TOTAL, as obs_lockout_time totals intervals: 0 over none.
    (SELECT TOTAL(l.lockout_seconds) FROM locks l
       WHERE l.period_kind = p.period_kind AND l.from_month IS p.from_month) AS lockout_seconds,
    -- The span the period's data covers, from what is in it (principle 5); none for 'unknown'.
    (SELECT MIN(d.at_utc) FROM dated d WHERE p.period_kind <> 'unknown'
       AND (p.from_month IS NULL OR d.month >= p.from_month)
       AND (p.until_month IS NULL OR d.month < p.until_month)) AS covers_from,
    (SELECT MAX(d.at_utc) FROM dated d WHERE p.period_kind <> 'unknown'
       AND (p.from_month IS NULL OR d.month >= p.from_month)
       AND (p.until_month IS NULL OR d.month < p.until_month)) AS covers_to
  FROM periods p
)
SELECT *
FROM counted
-- A period appears when it holds a hit or any dated data; an entry for a month with no data, or
-- a plan entered for the future, has nothing to report.
WHERE hits > 0 OR covers_from IS NOT NULL;
