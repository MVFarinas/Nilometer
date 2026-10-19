-- 027_weekly_crossings: when each weekly window was first read at or above 75% and 90% (D-087, step G3.2).
--
-- Interruptions count only limits that were hit. Weekly pass 3 found a week that reached 99% with
-- no hit: a weekly window at 91% with four and a half days left, and the work around it. This view
-- states the observed part, the first reading at or above each level and the time left before the
-- reset, without inferring why usage changed afterwards (principle 3).

-- Observed: per weekly window and level (75, 90), the first counted reading at or above it and the seconds from it to the window's reset, from init onward (D-087).
CREATE VIEW obs_weekly_crossings AS
WITH levels (threshold) AS (VALUES (75), (90)),
at_level AS (
  SELECT
    l.threshold, r.window, r.resets_at, r.reset_at_utc, r.raw_line_id, r.used_percentage,
    r.observed_at_utc, r.observed_at_s,
    ROW_NUMBER() OVER (
      PARTITION BY l.threshold, r.window, r.resets_at ORDER BY r.observed_at_s, r.raw_line_id
    ) AS reading_rank
  FROM window_readings r
  JOIN levels l ON r.used_percentage >= l.threshold
  -- Counted readings only: one after its reset belongs to no window (D-024).
  WHERE r.window = 'seven_day' AND r.after_reset = 0
)
SELECT
  window,
  reset_at_utc,
  threshold,
  observed_at_utc AS first_at_utc,
  used_percentage,
  resets_at - observed_at_s AS seconds_before_reset,
  raw_line_id
FROM at_level
WHERE reading_rank = 1;
