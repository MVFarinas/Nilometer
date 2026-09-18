-- 009_headroom: last observed usage and peak usage per rate-limit window, from init onward (P6.2, D-024).
--
-- A window instance is (window, resets_at). Readings come only from the status line, so these
-- metrics cover the status line's span, not the logs' (README principle 5). The last reading is a
-- lower bound on the window's final usage: budget spent after the last Claude Code turn isn't seen.

-- Observed: valid plan-window readings, each with its window instance and whether it was captured after that reset.
CREATE VIEW window_readings AS
SELECT
  w.raw_line_id,
  w.window,
  w.resets_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', w.resets_at, 'unixepoch') AS reset_at_utc,
  w.used_percentage,
  s.session_id,
  s.captured_at_s,
  strftime('%Y-%m-%dT%H:%M:%fZ', s.captured_at_s, 'unixepoch') AS captured_at_utc,
  s.captured_at_s > w.resets_at AS captured_after_reset
FROM rate_limit_windows w
JOIN status_readings s ON s.raw_line_id = w.raw_line_id
WHERE s.status = 'ok' AND w.validity = 'valid' AND w.window IN ('five_hour', 'seven_day');

-- Observed: per window instance, reading counts, whether it is still open, and the status line coverage.
CREATE VIEW window_instances AS
SELECT
  window,
  resets_at,
  reset_at_utc,
  COUNT(*) FILTER (WHERE captured_after_reset = 0) AS readings,
  COUNT(*) FILTER (WHERE captured_after_reset = 1) AS readings_after_reset,
  MIN(captured_at_utc) FILTER (WHERE captured_after_reset = 0) AS first_reading_at_utc,
  -- Open: no status line reading at all was captured at or after this reset, so later usage may still come.
  resets_at > (SELECT MAX(captured_at_s) FROM status_readings WHERE status = 'ok') AS window_open,
  (SELECT covers_from FROM source_coverage WHERE source = 'status_line') AS covers_from,
  (SELECT covers_to FROM source_coverage WHERE source = 'status_line') AS covers_to
FROM window_readings
GROUP BY window, resets_at;

-- Observed: last observed usage before each window's reset, with that reading's time (a lower bound on final usage).
CREATE VIEW obs_window_headroom AS
WITH ranked AS (
  SELECT
    r.*,
    ROW_NUMBER() OVER (PARTITION BY r.window, r.resets_at ORDER BY r.captured_at_s DESC, r.raw_line_id DESC) AS latest_rank
  FROM window_readings r
  WHERE r.captured_after_reset = 0
)
SELECT
  i.window,
  i.reset_at_utc,
  r.used_percentage AS last_used_percentage,
  r.captured_at_utc AS last_reading_at_utc,
  r.raw_line_id AS last_reading_raw_line_id,
  i.readings,
  i.readings_after_reset,
  i.first_reading_at_utc,
  i.window_open,
  i.covers_from,
  i.covers_to
FROM window_instances i
LEFT JOIN ranked r ON r.window = i.window AND r.resets_at = i.resets_at AND r.latest_rank = 1;

-- Observed: highest observed usage in each window, with the reading it came from.
CREATE VIEW obs_window_peak AS
WITH ranked AS (
  SELECT
    r.*,
    ROW_NUMBER() OVER (PARTITION BY r.window, r.resets_at ORDER BY r.used_percentage DESC, r.captured_at_s, r.raw_line_id) AS peak_rank
  FROM window_readings r
  WHERE r.captured_after_reset = 0
)
SELECT
  i.window,
  i.reset_at_utc,
  r.used_percentage AS peak_used_percentage,
  r.captured_at_utc AS peak_reading_at_utc,
  r.raw_line_id AS peak_reading_raw_line_id,
  i.readings,
  i.readings_after_reset,
  i.window_open,
  i.covers_from,
  i.covers_to
FROM window_instances i
LEFT JOIN ranked r ON r.window = i.window AND r.resets_at = i.resets_at AND r.peak_rank = 1;
