-- 024_counted_limit_groups: a status-line-only limit hit starts from a counted reading (D-078, step G2.6).
--
-- status_limit_groups took every reading at or over 100%, including readings observed after their
-- own window's reset (the payload lag D-024 describes: a session's reading repeats its last
-- response until it makes another request). A group whose first at-limit reading came after the
-- reset drew a lockout of 0 s, from a hit to a reset it had already passed. Every other window
-- metric counts only readings before the reset (after_reset = 0); this view now does too.

DROP VIEW status_limit_groups;

-- Observed: status line windows observed at 100%, one row per (window, resets_at), from init onward, counting only
-- readings before the window's reset (D-023, D-044, D-078).
CREATE VIEW status_limit_groups AS
WITH at_limit AS (
  SELECT
    r.raw_line_id, r.window, r.resets_at, r.session_id, r.observed_at_utc,
    ROW_NUMBER() OVER (PARTITION BY r.window, r.resets_at ORDER BY r.observed_at_s, r.raw_line_id) AS reading_rank,
    COUNT(*) OVER (PARTITION BY r.window, r.resets_at) AS readings_at_limit
  FROM window_readings r
  -- A reading after its reset belongs to no window (D-024), so it can't show that window at its limit.
  WHERE r.used_percentage >= 100 AND r.after_reset = 0
)
SELECT
  raw_line_id, window, resets_at, session_id, readings_at_limit,
  observed_at_utc AS first_at_utc,
  strftime('%Y-%m-%dT%H:%M:%fZ', resets_at, 'unixepoch') AS reset_at_utc,
  CASE window WHEN 'five_hour' THEN 5 * 3600 ELSE 7 * 86400 END AS window_seconds
FROM at_limit
WHERE reading_rank = 1;
