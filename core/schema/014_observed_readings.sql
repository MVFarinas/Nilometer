-- 014_observed_readings: date status line readings by the API response they came from, not by capture (D-044).
--
-- A payload's rate_limits are the numbers from the latest API response in that session; re-running
-- the status line (a refresh timer, a window reset, /compact) repeats them. So a reading is observed
-- at the latest request line in its session at or before the capture (+1 s for whole-second
-- captures), within the window it reports, and readings of the same response collapse to one
-- observation. Every view that ordered, dated, counted, or excluded readings by capture time is
-- recreated here to use the observed time. Dependent views keep their column names and need no change.

DROP VIEW obs_unattributed_usage;
DROP VIEW obs_unattributed_usage_events;
DROP VIEW window_reading_pairs;
DROP VIEW obs_window_peak;
DROP VIEW obs_window_headroom;
DROP VIEW window_instances;
DROP VIEW status_limit_groups;
DROP VIEW source_coverage;
DROP VIEW window_readings;

-- Observed: one row per observation of a plan window: the latest capture of each API response's numbers, with when they were observed (D-024, D-044).
CREATE VIEW window_readings AS
WITH readings AS (
  SELECT
    w.raw_line_id, w.window, w.resets_at, w.used_percentage, s.session_id, s.captured_at_s,
    -- Only a request inside this window can have produced numbers for it; +1 s covers whole-second captures.
    (SELECT MAX(p.timestamp_utc) FROM parsed_lines p
       WHERE p.session_id = s.session_id AND p.class = 'request'
         AND p.timestamp_utc > strftime('%Y-%m-%dT%H:%M:%fZ',
               w.resets_at - CASE w.window WHEN 'five_hour' THEN 5 * 3600 ELSE 7 * 86400 END, 'unixepoch')
         AND p.timestamp_utc < strftime('%Y-%m-%dT%H:%M:%fZ', s.captured_at_s + 1, 'unixepoch')) AS last_request_utc
  FROM rate_limit_windows w
  JOIN status_readings s ON s.raw_line_id = w.raw_line_id
  WHERE s.status = 'ok' AND w.validity = 'valid' AND w.window IN ('five_hour', 'seven_day')
),
observed AS (
  SELECT
    r.*,
    COALESCE(r.last_request_utc, strftime('%Y-%m-%dT%H:%M:%fZ', r.captured_at_s, 'unixepoch')) AS observed_at_utc,
    ROW_NUMBER() OVER (
      -- A capture-time fallback is its own observation: NULL request times must not merge.
      PARTITION BY r.window, r.resets_at, r.session_id, r.last_request_utc,
                   CASE WHEN r.last_request_utc IS NULL THEN r.raw_line_id END
      ORDER BY r.captured_at_s DESC, r.raw_line_id DESC
    ) AS copy_rank
  FROM readings r
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
  CASE WHEN last_request_utc IS NULL THEN 'capture' ELSE 'last_request' END AS observed_via,
  unixepoch(observed_at_utc, 'subsec') > resets_at AS after_reset
FROM observed
WHERE copy_rank = 1;

-- Observed: the time span each source's data covers, from the data present (README principle 5); status line spans observations (D-044).
CREATE VIEW source_coverage AS
SELECT 'session_logs' AS source, MIN(timestamp_utc) AS covers_from, MAX(timestamp_utc) AS covers_to
FROM parsed_lines
WHERE timestamp_utc IS NOT NULL
UNION ALL
SELECT 'status_line', MIN(observed_at_utc), MAX(observed_at_utc)
FROM window_readings;

-- Observed: status line windows observed at 100%, one row per (window, resets_at), from init onward (D-023, D-044).
CREATE VIEW status_limit_groups AS
WITH at_limit AS (
  SELECT
    r.raw_line_id, r.window, r.resets_at, r.session_id, r.observed_at_utc,
    ROW_NUMBER() OVER (PARTITION BY r.window, r.resets_at ORDER BY r.observed_at_s, r.raw_line_id) AS reading_rank,
    COUNT(*) OVER (PARTITION BY r.window, r.resets_at) AS readings_at_limit
  FROM window_readings r
  WHERE r.used_percentage >= 100
)
SELECT
  raw_line_id, window, resets_at, session_id, readings_at_limit,
  observed_at_utc AS first_at_utc,
  strftime('%Y-%m-%dT%H:%M:%fZ', resets_at, 'unixepoch') AS reset_at_utc,
  CASE window WHEN 'five_hour' THEN 5 * 3600 ELSE 7 * 86400 END AS window_seconds
FROM at_limit
WHERE reading_rank = 1;

-- Observed: per window instance, observation counts, whether it is still open, and the status line coverage.
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
  (SELECT covers_to FROM source_coverage WHERE source = 'status_line') AS covers_to
FROM window_readings
GROUP BY window, resets_at;

-- Observed: last observed usage before each window's reset, with when it was observed (a lower bound on final usage; D-024, D-044).
CREATE VIEW obs_window_headroom AS
WITH ranked AS (
  SELECT
    r.*,
    ROW_NUMBER() OVER (PARTITION BY r.window, r.resets_at ORDER BY r.observed_at_s DESC, r.raw_line_id DESC) AS latest_rank
  FROM window_readings r
  WHERE r.after_reset = 0
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
  i.covers_to
FROM window_instances i
LEFT JOIN ranked r ON r.window = i.window AND r.resets_at = i.resets_at AND r.latest_rank = 1;

-- Observed: highest observed usage in each window, with the observation it came from (D-044).
CREATE VIEW obs_window_peak AS
WITH ranked AS (
  SELECT
    r.*,
    ROW_NUMBER() OVER (PARTITION BY r.window, r.resets_at ORDER BY r.used_percentage DESC, r.observed_at_s, r.raw_line_id) AS peak_rank
  FROM window_readings r
  WHERE r.after_reset = 0
)
SELECT
  i.window,
  i.reset_at_utc,
  r.used_percentage AS peak_used_percentage,
  r.observed_at_utc AS peak_reading_at_utc,
  r.raw_line_id AS peak_reading_raw_line_id,
  i.readings,
  i.readings_after_reset,
  i.window_open,
  i.covers_from,
  i.covers_to
FROM window_instances i
LEFT JOIN ranked r ON r.window = i.window AND r.resets_at = i.resets_at AND r.peak_rank = 1;

-- Observed: consecutive observations of one window, the change between them, and Claude Code requests in between (D-025, D-044).
CREATE VIEW window_reading_pairs AS
WITH ordered AS (
  SELECT
    r.*,
    LAG(r.raw_line_id) OVER w AS previous_raw_line_id,
    LAG(r.used_percentage) OVER w AS previous_used_percentage,
    LAG(r.observed_at_utc) OVER w AS previous_observed_at_utc
  FROM window_readings r
  WHERE r.after_reset = 0
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
  -- Include the previous observation's instant, and one second past this one (whole-second captures).
  (SELECT COUNT(*) FROM requests_dedup d
     WHERE d.timestamp_utc >= o.previous_observed_at_utc
       AND d.timestamp_utc < strftime('%Y-%m-%dT%H:%M:%fZ', o.observed_at_s + 1, 'unixepoch')) AS requests_between
FROM ordered o
WHERE o.previous_raw_line_id IS NOT NULL;

-- Observed: observation pairs whose usage rose with no Claude Code request in between (D-025; see D-044 on why real data rarely has any).
CREATE VIEW obs_unattributed_usage_events AS
SELECT * FROM window_reading_pairs
WHERE requests_between = 0 AND change_percentage_points > 0;

-- Observed: per window, percentage points consumed with no Claude Code request in between (a lower bound), beside pair counts.
CREATE VIEW obs_unattributed_usage AS
SELECT
  i.window,
  i.reset_at_utc,
  i.readings,
  (SELECT COUNT(*) FROM window_reading_pairs p WHERE p.window = i.window AND p.reset_at_utc = i.reset_at_utc) AS pairs,
  (SELECT COUNT(*) FROM window_reading_pairs p
     WHERE p.window = i.window AND p.reset_at_utc = i.reset_at_utc AND p.requests_between = 0) AS pairs_without_requests,
  (SELECT COUNT(*) FROM window_reading_pairs p
     WHERE p.window = i.window AND p.reset_at_utc = i.reset_at_utc AND p.change_percentage_points < 0) AS decreasing_pairs,
  -- Fewer than two observations means no pair was observed: unknown, not 0.
  CASE WHEN i.readings >= 2 THEN
    (SELECT TOTAL(e.change_percentage_points) FROM obs_unattributed_usage_events e
       WHERE e.window = i.window AND e.reset_at_utc = i.reset_at_utc)
  END AS unattributed_percentage_points,
  i.window_open,
  i.covers_from,
  i.covers_to
FROM window_instances i;
