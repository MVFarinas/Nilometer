-- 026_changed_readings: a value that changed without a new response is its own observation (D-086, step G3.1).
--
-- D-044 dates a reading by its session's last API response, on the premise that an idle session
-- repeats that response's numbers. Since Claude Code 2.1.281 an idle session sometimes carries the
-- account's later total instead (found 2026-10-19, weekly pass 3). Those captures were dated back to
-- the response, and keeping the latest capture per response replaced the response's own value.
-- Here the captures of one response are split into runs of the same value: the first run is dated
-- by the response, as before; each later run, by its first capture. Columns are unchanged.

DROP VIEW window_readings;

-- Observed: one row per observation of a plan window. Captures of one API response's numbers are dated by that response's first line (D-044, D-045); a value that changed after it, by its first capture (D-086).
CREATE VIEW window_readings AS
WITH readings AS (
  SELECT
    w.raw_line_id, w.window, w.resets_at, w.used_percentage, s.session_id, s.captured_at_s,
    -- The response behind the latest request line in this session, inside this window, at or before
    -- the capture (+1 s for whole-second captures). An unkeyed line is its own response.
    (SELECT COALESCE(rq.dedup_key, 'line:' || rq.raw_line_id)
       FROM parsed_lines p
       JOIN requests rq ON rq.raw_line_id = p.raw_line_id
       WHERE p.session_id = s.session_id AND p.class = 'request'
         AND p.timestamp_utc > strftime('%Y-%m-%dT%H:%M:%fZ',
               w.resets_at - CASE w.window WHEN 'five_hour' THEN 5 * 3600 ELSE 7 * 86400 END, 'unixepoch')
         AND p.timestamp_utc < strftime('%Y-%m-%dT%H:%M:%fZ', s.captured_at_s + 1, 'unixepoch')
       ORDER BY p.timestamp_utc DESC, p.raw_line_id DESC
       LIMIT 1) AS response_key
  FROM rate_limit_windows w
  JOIN status_readings s ON s.raw_line_id = w.raw_line_id
  WHERE s.status = 'ok' AND w.validity = 'valid' AND w.window IN ('five_hour', 'seven_day')
),
dated AS (
  SELECT
    r.*,
    -- The response's first line: when its numbers first existed.
    (SELECT MIN(p.timestamp_utc)
       FROM requests rq
       JOIN parsed_lines p ON p.raw_line_id = rq.raw_line_id
       WHERE (r.response_key LIKE 'line:%' AND rq.raw_line_id = CAST(substr(r.response_key, 6) AS INTEGER))
          OR rq.dedup_key = r.response_key) AS response_first_utc,
    -- The previous capture of the same response, in capture order.
    LAG(r.used_percentage) OVER captures AS previous_used_percentage
  FROM readings r
  -- A capture-time fallback is its own group: NULL response keys must not merge (D-044).
  WINDOW captures AS (
    PARTITION BY r.window, r.resets_at, r.session_id, r.response_key,
                 CASE WHEN r.response_key IS NULL THEN r.raw_line_id END
    ORDER BY r.captured_at_s, r.raw_line_id
  )
),
runs AS (
  SELECT
    d.*,
    -- A new run starts at the first capture and at every change of more than 0.01 points: payloads
    -- carry computed values such as 7.000000000000001, which are the same number (D-044, D-086).
    SUM(CASE WHEN d.previous_used_percentage IS NULL
               OR abs(d.used_percentage - d.previous_used_percentage) > 0.01 THEN 1 ELSE 0 END)
      OVER (
        PARTITION BY d.window, d.resets_at, d.session_id, d.response_key,
                     CASE WHEN d.response_key IS NULL THEN d.raw_line_id END
        ORDER BY d.captured_at_s, d.raw_line_id
        ROWS UNBOUNDED PRECEDING
      ) AS run
  FROM dated d
),
observed AS (
  SELECT
    u.*,
    -- A later run's value didn't come from the response, so it's dated when it was first seen.
    CASE
      WHEN u.response_first_utc IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', u.captured_at_s, 'unixepoch')
      WHEN u.run = 1 THEN u.response_first_utc
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', MIN(u.captured_at_s) OVER run_captures, 'unixepoch')
    END AS observed_at_utc,
    ROW_NUMBER() OVER run_captures_latest AS copy_rank
  FROM runs u
  WINDOW
    run_captures AS (
      PARTITION BY u.window, u.resets_at, u.session_id, u.response_key,
                   CASE WHEN u.response_key IS NULL THEN u.raw_line_id END, u.run
    ),
    run_captures_latest AS (
      PARTITION BY u.window, u.resets_at, u.session_id, u.response_key,
                   CASE WHEN u.response_key IS NULL THEN u.raw_line_id END, u.run
      ORDER BY u.captured_at_s DESC, u.raw_line_id DESC
    )
)
SELECT
  raw_line_id,
  window,
  resets_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', resets_at, 'unixepoch') AS reset_at_utc,
  used_percentage,
  session_id,
  captured_at_s,
  strftime('%Y-%m-%dT%H:%M:%fZ', captured_at_s, 'unixepoch') AS captured_at_utc,
  observed_at_utc,
  unixepoch(observed_at_utc, 'subsec') AS observed_at_s,
  CASE
    WHEN response_key IS NULL THEN 'capture'
    WHEN run = 1 THEN 'last_request'
    ELSE 'changed_capture'
  END AS observed_via,
  unixepoch(observed_at_utc, 'subsec') > resets_at AS after_reset
FROM observed
WHERE copy_rank = 1;
