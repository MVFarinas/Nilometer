-- 028_stale_readings: a reading below an earlier one in its window is stale, kept and not used (D-089, step G4.1).
--
-- Within one window usage only rises, but about 1% of real readings came in lower than an earlier
-- reading in the same window, in every Claude Code version and model (found in the 2026-10-22
-- click-through: a 5-hour window locked at 100% from 01:17 showed a "last observed" 73% at 01:59).
-- Such a reading is marked stale. It stays a row, counted and listed in explain (principle 1), but
-- isn't the window's last observed value, isn't part of a reading pair, and isn't drawn on the line.
-- Peaks and crossings are unaffected: a stale reading is below an earlier one by definition.

DROP VIEW window_reading_pairs;
DROP VIEW obs_window_headroom;
DROP VIEW window_instances;
DROP VIEW window_readings;

-- Observed: one row per observation of a plan window, as in 026 (D-044, D-045, D-086), with stale = 1 when a counted reading is more than 1 point below an earlier counted one in its window (D-089).
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
),
counted AS (
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
  WHERE copy_rank = 1
)
SELECT
  c.*,
  -- Usage within one window only rises, so a counted reading more than 1 point below an earlier one
  -- in the same window, from any session, carries a number from before that earlier reading (D-089).
  CASE
    WHEN c.after_reset = 0 AND c.used_percentage < MAX(c.used_percentage) OVER (
      PARTITION BY c.window, c.resets_at ORDER BY c.observed_at_s, c.raw_line_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) - 1 THEN 1
    ELSE 0
  END AS stale
FROM counted c;

-- Observed: per window instance, observation counts (stale ones also on their own), whether it is still open, and the status line coverage.
CREATE VIEW window_instances AS
SELECT
  window,
  resets_at,
  reset_at_utc,
  COUNT(*) FILTER (WHERE after_reset = 0) AS readings,
  COUNT(*) FILTER (WHERE after_reset = 1) AS readings_after_reset,
  MIN(observed_at_utc) FILTER (WHERE after_reset = 0) AS first_reading_at_utc,
  -- Open: no status line reading at all was captured at or after this reset, so later usage may still come.
  resets_at > (SELECT MAX(captured_at_s) FROM status_readings WHERE status = 'ok') AS window_open,
  (SELECT covers_from FROM source_coverage WHERE source = 'status_line') AS covers_from,
  (SELECT covers_to FROM source_coverage WHERE source = 'status_line') AS covers_to,
  -- Counted readings marked stale: in readings above, and used for no value (D-089).
  COUNT(*) FILTER (WHERE after_reset = 0 AND stale = 1) AS readings_stale
FROM window_readings
GROUP BY window, resets_at;

-- Observed: last observed usage before each window's reset that isn't stale, with when it was observed (a lower bound on final usage; D-024, D-044, D-089).
CREATE VIEW obs_window_headroom AS
WITH ranked AS (
  SELECT
    r.*,
    ROW_NUMBER() OVER (PARTITION BY r.window, r.resets_at ORDER BY r.observed_at_s DESC, r.raw_line_id DESC) AS latest_rank
  FROM window_readings r
  WHERE r.after_reset = 0 AND r.stale = 0
)
SELECT
  i.window,
  i.reset_at_utc,
  r.used_percentage AS last_used_percentage,
  r.observed_at_utc AS last_reading_at_utc,
  r.raw_line_id AS last_reading_raw_line_id,
  i.readings,
  i.readings_after_reset,
  i.first_reading_at_utc,
  i.window_open,
  i.covers_from,
  i.covers_to,
  i.readings_stale
FROM window_instances i
LEFT JOIN ranked r ON r.window = i.window AND r.resets_at = i.resets_at AND r.latest_rank = 1;

-- Observed: consecutive non-stale observations of one window, the change between them, and Claude Code responses in between (D-025, D-045, D-089).
CREATE VIEW window_reading_pairs AS
WITH ordered AS (
  SELECT
    r.*,
    LAG(r.raw_line_id) OVER w AS previous_raw_line_id,
    LAG(r.used_percentage) OVER w AS previous_used_percentage,
    LAG(r.observed_at_utc) OVER w AS previous_observed_at_utc
  FROM window_readings r
  WHERE r.after_reset = 0 AND r.stale = 0
  WINDOW w AS (PARTITION BY r.window, r.resets_at ORDER BY r.observed_at_s, r.raw_line_id)
)
SELECT
  o.window,
  o.reset_at_utc,
  o.previous_raw_line_id,
  o.raw_line_id,
  o.previous_observed_at_utc,
  o.observed_at_utc,
  o.used_percentage - o.previous_used_percentage AS change_percentage_points,
  -- Distinct responses with any line from the previous observation up to one second past this one.
  (SELECT COUNT(DISTINCT COALESCE(rq.dedup_key, 'line:' || rq.raw_line_id))
     FROM parsed_lines p
     JOIN requests rq ON rq.raw_line_id = p.raw_line_id
     WHERE p.class = 'request'
       AND p.timestamp_utc >= o.previous_observed_at_utc
       AND p.timestamp_utc < strftime('%Y-%m-%dT%H:%M:%fZ', o.observed_at_s + 1, 'unixepoch')) AS requests_between
FROM ordered o
WHERE o.previous_raw_line_id IS NOT NULL;
