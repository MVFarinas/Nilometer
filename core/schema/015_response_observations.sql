-- 015_response_observations: one status line observation per API response, dated by its first log line (D-045).
--
-- 014 keyed observations by the latest request line, but one response is several streaming snapshot
-- lines with their own timestamps (D-001), so readings taken mid-stream became separate observations
-- of one response. Here the key is the response (its D-001 dedup key, or the line itself when
-- unkeyed), dated by the response's first line, and reading pairs count distinct responses with any
-- line in the interval. Dependent views keep their column names.

DROP VIEW obs_unattributed_usage;
DROP VIEW obs_unattributed_usage_events;
DROP VIEW window_reading_pairs;
DROP VIEW window_readings;

-- Observed: one row per observation of a plan window: the latest capture of each API response's numbers, dated by that response's first line (D-044, D-045).
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
          OR rq.dedup_key = r.response_key) AS response_first_utc
  FROM readings r
),
observed AS (
  SELECT
    d.*,
    COALESCE(d.response_first_utc, strftime('%Y-%m-%dT%H:%M:%fZ', d.captured_at_s, 'unixepoch')) AS observed_at_utc,
    ROW_NUMBER() OVER (
      -- A capture-time fallback is its own observation: NULL response keys must not merge.
      PARTITION BY d.window, d.resets_at, d.session_id, d.response_key,
                   CASE WHEN d.response_key IS NULL THEN d.raw_line_id END
      ORDER BY d.captured_at_s DESC, d.raw_line_id DESC
    ) AS copy_rank
  FROM dated d
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
  CASE WHEN response_key IS NULL THEN 'capture' ELSE 'last_request' END AS observed_via,
  unixepoch(observed_at_utc, 'subsec') > resets_at AS after_reset
FROM observed
WHERE copy_rank = 1;

-- Observed: consecutive observations of one window, the change between them, and Claude Code responses in between (D-025, D-045).
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
  -- Distinct responses with any line from the previous observation up to one second past this one.
  (SELECT COUNT(DISTINCT COALESCE(rq.dedup_key, 'line:' || rq.raw_line_id))
     FROM parsed_lines p
     JOIN requests rq ON rq.raw_line_id = p.raw_line_id
     WHERE p.class = 'request'
       AND p.timestamp_utc >= o.previous_observed_at_utc
       AND p.timestamp_utc < strftime('%Y-%m-%dT%H:%M:%fZ', o.observed_at_s + 1, 'unixepoch')) AS requests_between
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
