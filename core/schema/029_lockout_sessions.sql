-- 029_lockout_sessions: how many sessions each lockout refused requests from (D-090, step G4.2).
--
-- One lockout can refuse many requests: on 2026-09-24, 13 within 3 minutes across 3 sessions, 6 of
-- them in subagents. Shown as "13 hits", that read as 13 separate limits. The report now leads with
-- lockouts and calls the hit lines refused requests, naming the sessions they came from.

DROP VIEW obs_lockout_intervals;

-- Observed: elapsed lockout intervals (limit hit to reset, overlapping hits merged), with the next request after each reset, logged auto-continuations, and the sessions and refused requests in each (D-023, D-077, D-090).
CREATE VIEW obs_lockout_intervals AS
WITH interval_hits AS MATERIALIZED (
  -- Computed once for everything below: interval membership is the costly part.
  SELECT raw_line_id, start_utc, end_utc, interval_number FROM obs_lockout_interval_hits
),
grouped AS (
  SELECT
    interval_number,
    MIN(start_utc) AS locked_from_utc,
    MAX(end_utc) AS locked_until_utc,
    COUNT(*) AS hits
  FROM interval_hits
  GROUP BY interval_number
),
with_next AS (
  SELECT
    g.*,
    (SELECT MIN(d.timestamp_utc) FROM requests_dedup d WHERE d.timestamp_utc >= g.locked_until_utc) AS next_request_at_utc
  FROM grouped g
),
sessions AS (
  SELECT
    h.interval_number,
    -- A logged hit names its session; a status-line-only hit is a spool reading, which names one too.
    COUNT(DISTINCT COALESCE(p.session_id, s.session_id)) AS sessions,
    -- Hits from the session logs: each is a request the limit refused.
    COUNT(p.raw_line_id) AS refused_requests
  FROM interval_hits h
  LEFT JOIN parsed_lines p ON p.raw_line_id = h.raw_line_id
  LEFT JOIN status_readings s ON s.raw_line_id = h.raw_line_id
  GROUP BY h.interval_number
),
resumed AS (
  SELECT
    h.interval_number,
    COUNT(*) AS auto_continuations,
    MIN((round(unixepoch(m.continued_at_utc, 'subsec') * 1000) - round(unixepoch(g.locked_until_utc, 'subsec') * 1000)) / 1000.0)
      AS first_seconds
  FROM auto_continuation_marks m
  JOIN interval_hits h ON h.raw_line_id = m.hit_raw_line_id
  JOIN grouped g ON g.interval_number = h.interval_number
  GROUP BY h.interval_number
)
SELECT
  w.*,
  (round(unixepoch(w.locked_until_utc, 'subsec') * 1000) - round(unixepoch(w.locked_from_utc, 'subsec') * 1000)) / 1000.0 AS lockout_seconds,
  (round(unixepoch(w.next_request_at_utc, 'subsec') * 1000) - round(unixepoch(w.locked_until_utc, 'subsec') * 1000)) / 1000.0 AS reset_to_next_request_seconds,
  w.locked_until_utc > (SELECT covers_to FROM source_coverage WHERE source = 'session_logs') AS reset_after_coverage,
  -- How many sessions Claude Code resumed by itself after this reset, as logged; 0 when none.
  COALESCE(r.auto_continuations, 0) AS auto_continuations,
  -- The earliest of those, seconds after the reset; NULL when none.
  r.first_seconds AS first_auto_continuation_seconds,
  -- Distinct sessions with a hit in this lockout (D-090).
  COALESCE(n.sessions, 0) AS sessions,
  -- Its logged hits, each a refused request; the rest of its hits are status line readings at 100% (D-023, D-090).
  COALESCE(n.refused_requests, 0) AS refused_requests
FROM with_next w
LEFT JOIN resumed r ON r.interval_number = w.interval_number
LEFT JOIN sessions n ON n.interval_number = w.interval_number;
