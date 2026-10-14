-- 023_auto_continuations: Claude Code's own resumption after a lockout is shown where it was logged (D-077, step G2.4).
--
-- After a limit's window resets, Claude Code continues a stopped session by itself and marks it:
-- a user line with isMeta true and origin.kind "auto-continuation" (D-022, observed from 2.1.281).
-- The report said only "reset to next Claude Code request", which doesn't say who continued.
-- Only the logged marker earns the label; nothing is inferred from timing (D-022), so a workflow
-- restarting its subagents, which writes no marker, stays unlabeled.
--
-- A marker belongs to the latest logged limit hit before it in its own session, and through that
-- hit to the hit's lockout interval (D-023). A marker with no earlier hit in its session, or whose
-- hit has no known reset and so no interval, follows no lockout and isn't counted.
--
-- Cost: the lockout views are read by several metrics, and the merged hit views behind them are
-- the costliest on real data (D-059). So the markers and their hits are found from the raw lines
-- (auto_continuation_marks), and each view computes interval membership once.

-- Helper: each logged auto-continuation, once per line, with the latest logged limit hit before it in its session (D-077).
CREATE VIEW auto_continuation_marks AS
WITH marks AS (
  SELECT
    p.raw_line_id, p.session_id, p.timestamp_utc,
    -- Copies of one line (a uuid written twice in a session) count once, as limit hits do.
    ROW_NUMBER() OVER (
      PARTITION BY p.session_id, p.uuid, CASE WHEN p.uuid IS NULL THEN p.raw_line_id END
      ORDER BY f.root, f.relative_path, l.first_run_id, l.line_number
    ) AS copy_rank
  FROM parsed_lines p
  JOIN raw_lines l ON l.id = p.raw_line_id
  JOIN source_files f ON f.id = l.source_file_id
  WHERE p.origin_kind = 'auto-continuation' AND p.is_meta = 1 AND p.timestamp_utc IS NOT NULL
),
-- The logged limit-hit lines, one per distinct line, chosen as logged_limit_hits chooses them.
hit_lines AS MATERIALIZED (
  SELECT raw_line_id, session_id, timestamp_utc
  FROM (
    SELECT
      p.raw_line_id, p.session_id, p.timestamp_utc,
      ROW_NUMBER() OVER (
        PARTITION BY p.session_id, p.uuid, CASE WHEN p.uuid IS NULL THEN p.raw_line_id END
        ORDER BY f.root, f.relative_path, l.first_run_id, l.line_number
      ) AS copy_rank
    FROM events e
    JOIN parsed_lines p ON p.raw_line_id = e.raw_line_id
    JOIN raw_lines l ON l.id = e.raw_line_id
    JOIN source_files f ON f.id = l.source_file_id
    WHERE e.class = 'limit_hit'
  )
  WHERE copy_rank = 1
)
SELECT
  m.raw_line_id,                       -- source: the marker line
  m.session_id,                        -- source: its sessionId
  m.timestamp_utc AS continued_at_utc, -- source: its timestamp
  (SELECT h.raw_line_id FROM hit_lines h
     WHERE h.session_id = m.session_id AND h.timestamp_utc < m.timestamp_utc
     ORDER BY h.timestamp_utc DESC, h.raw_line_id DESC
     LIMIT 1) AS hit_raw_line_id       -- derived: the latest logged hit before it in the session
FROM marks m
WHERE m.copy_rank = 1;

DROP VIEW obs_lockout_intervals;

-- Observed: merged lockout intervals, hit → reset, with the first Claude Code request at or after each reset (D-023),
-- and the sessions Claude Code itself resumed after it, as logged (D-077).
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
  r.first_seconds AS first_auto_continuation_seconds
FROM with_next w
LEFT JOIN resumed r ON r.interval_number = w.interval_number;

-- Observed: each logged auto-continuation that followed a lockout, with its interval and how long after the reset (D-077).
CREATE VIEW obs_auto_continuation_events AS
WITH interval_hits AS MATERIALIZED (
  SELECT raw_line_id, end_utc, interval_number FROM obs_lockout_interval_hits
),
resets AS (
  -- Each interval's reset as obs_lockout_intervals takes it: the latest end of its hits' spans.
  SELECT interval_number, MAX(end_utc) AS locked_until_utc FROM interval_hits GROUP BY interval_number
)
SELECT
  m.raw_line_id,
  m.session_id,
  m.continued_at_utc,
  m.hit_raw_line_id,
  h.interval_number,
  r.locked_until_utc,
  -- As written: a marker logged before the reset would show a negative time (none observed).
  (round(unixepoch(m.continued_at_utc, 'subsec') * 1000) - round(unixepoch(r.locked_until_utc, 'subsec') * 1000)) / 1000.0
    AS seconds_after_reset
FROM auto_continuation_marks m
JOIN interval_hits h ON h.raw_line_id = m.hit_raw_line_id
JOIN resets r ON r.interval_number = h.interval_number;
