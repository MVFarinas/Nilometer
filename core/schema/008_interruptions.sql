-- 008_interruptions: conversation links, resolved reset times, and the interruption metrics (P6.1).
--
-- Rules: D-004 (limit hits), D-021 (mid-task), D-022 (resumption), D-023 (lockout, merging hits).
-- Every metric has a summary view (obs_<metric>) returning covers_from/covers_to, and an events
-- view listing the rows behind its number, so each number can be re-summed from its events
-- (README principles 4 and 5). Timestamps are UTC text, `YYYY-MM-DDTHH:MM:SS.sssZ`, which sorts
-- chronologically. Spans subtract whole milliseconds, which is the timestamps' precision, so
-- they carry no floating-point noise.

ALTER TABLE parsed_lines ADD COLUMN uuid TEXT; -- source: uuid when it's a non-empty string
ALTER TABLE parsed_lines ADD COLUMN parent_uuid TEXT; -- source: parentUuid when it's a non-empty string (D-021)
ALTER TABLE parsed_lines ADD COLUMN origin_kind TEXT; -- source: origin.kind when it's a string (D-022)
ALTER TABLE parsed_lines ADD COLUMN user_content TEXT CHECK (user_content IN ('tool_result', 'prompt')); -- derived: user lines only; 'tool_result' when message.content holds a tool_result block
ALTER TABLE parsed_lines ADD COLUMN is_meta INTEGER NOT NULL DEFAULT 0 CHECK (is_meta IN (0, 1)); -- source: isMeta === true (1) or anything else (0)
ALTER TABLE events ADD COLUMN reset_at_utc TEXT; -- derived: limit hits only; reset_text resolved against the hit's timestamp (D-023)

-- Parent lookups and "next line in this session" lookups.
CREATE INDEX parsed_lines_session_uuid ON parsed_lines (session_id, uuid);
CREATE INDEX parsed_lines_session_time ON parsed_lines (session_id, timestamp_utc);

-- Observed: the time span each source's data covers, from the data present (README principle 5).
CREATE VIEW source_coverage AS
SELECT 'session_logs' AS source, MIN(timestamp_utc) AS covers_from, MAX(timestamp_utc) AS covers_to
FROM parsed_lines
WHERE timestamp_utc IS NOT NULL
UNION ALL
SELECT
  'status_line',
  strftime('%Y-%m-%dT%H:%M:%fZ', MIN(captured_at_s), 'unixepoch'),
  strftime('%Y-%m-%dT%H:%M:%fZ', MAX(captured_at_s), 'unixepoch')
FROM status_readings
WHERE status = 'ok';

-- Observed: logged limit hits, one per distinct line (copies of a uuid in one session count once), with the D-021 position.
CREATE VIEW logged_limit_hits AS
WITH copies AS (
  SELECT
    p.raw_line_id, p.session_id, p.uuid, p.parent_uuid, p.timestamp_utc, p.is_sidechain,
    e.window, e.reset_text, e.reset_at_utc,
    ROW_NUMBER() OVER (
      -- A line without a uuid is its own group: NULL uuids must not merge with each other.
      PARTITION BY p.session_id, p.uuid, CASE WHEN p.uuid IS NULL THEN p.raw_line_id END
      ORDER BY f.root, f.relative_path, l.first_run_id, l.line_number
    ) AS copy_rank
  FROM events e
  JOIN parsed_lines p ON p.raw_line_id = e.raw_line_id
  JOIN raw_lines l ON l.id = e.raw_line_id
  JOIN source_files f ON f.id = l.source_file_id
  WHERE e.class = 'limit_hit'
)
SELECT
  c.raw_line_id, c.session_id, c.uuid, c.parent_uuid, c.timestamp_utc, c.is_sidechain,
  c.window, c.reset_text, c.reset_at_utc,
  COALESCE((
    SELECT CASE
      WHEN par.user_content = 'tool_result' THEN 'mid_task'
      WHEN par.user_content = 'prompt' AND par.is_meta = 0 THEN 'turn_start'
      ELSE 'unknown'
    END
    FROM parsed_lines par
    JOIN raw_lines pl ON pl.id = par.raw_line_id
    JOIN source_files pf ON pf.id = pl.source_file_id
    WHERE par.session_id = c.session_id AND par.uuid = c.parent_uuid
    ORDER BY pf.root, pf.relative_path, pl.first_run_id, pl.line_number
    LIMIT 1
  ), 'unknown') AS position
FROM copies c
WHERE c.copy_rank = 1;

-- Observed: status line windows that reached 100%, one row per (window, resets_at), from init onward (D-023).
CREATE VIEW status_limit_groups AS
WITH at_limit AS (
  SELECT
    w.raw_line_id, w.window, w.resets_at, s.session_id, s.captured_at_s,
    ROW_NUMBER() OVER (PARTITION BY w.window, w.resets_at ORDER BY s.captured_at_s, w.raw_line_id) AS reading_rank,
    COUNT(*) OVER (PARTITION BY w.window, w.resets_at) AS readings_at_limit
  FROM rate_limit_windows w
  JOIN status_readings s ON s.raw_line_id = w.raw_line_id
  WHERE s.status = 'ok' AND w.validity = 'valid'
    AND w.window IN ('five_hour', 'seven_day') AND w.used_percentage >= 100
)
SELECT
  raw_line_id, window, resets_at, session_id, readings_at_limit,
  strftime('%Y-%m-%dT%H:%M:%fZ', captured_at_s, 'unixepoch') AS first_at_utc,
  strftime('%Y-%m-%dT%H:%M:%fZ', resets_at, 'unixepoch') AS reset_at_utc,
  CASE window WHEN 'five_hour' THEN 5 * 3600 ELSE 7 * 86400 END AS window_seconds
FROM at_limit
WHERE reading_rank = 1;

-- Observed: every rate-limit interruption, logged hits merged with status line groups without double-counting (D-004, D-023).
CREATE VIEW obs_limit_hits_events AS
WITH logged AS (
  SELECT
    h.*,
    (SELECT g.raw_line_id FROM status_limit_groups g
       WHERE (h.window IS NULL OR h.window = g.window)
         AND unixepoch(h.timestamp_utc, 'subsec') > g.resets_at - g.window_seconds
         AND unixepoch(h.timestamp_utc, 'subsec') <= g.resets_at
       ORDER BY g.resets_at, g.window
       LIMIT 1) AS status_raw_line_id
  FROM logged_limit_hits h
),
merged AS (
  SELECT
    'session_log' AS source,
    l.raw_line_id,
    l.status_raw_line_id,
    l.session_id,
    l.timestamp_utc AS hit_at_utc,
    COALESCE(l.window, g.window) AS window,
    -- The payload's resets_at is exact; reset text has minute precision.
    COALESCE(g.reset_at_utc, l.reset_at_utc) AS reset_at_utc,
    CASE WHEN g.raw_line_id IS NOT NULL THEN 'status_line' WHEN l.reset_at_utc IS NOT NULL THEN 'log_text' END AS reset_source,
    l.reset_text,
    l.position,
    l.is_sidechain
  FROM logged l
  LEFT JOIN status_limit_groups g ON g.raw_line_id = l.status_raw_line_id
  UNION ALL
  SELECT 'status_line', g.raw_line_id, g.raw_line_id, g.session_id, g.first_at_utc, g.window,
         g.reset_at_utc, 'status_line', NULL, 'unknown', 0
  FROM status_limit_groups g
  WHERE NOT EXISTS (SELECT 1 FROM logged l WHERE l.status_raw_line_id = g.raw_line_id)
)
SELECT
  m.*,
  (round(unixepoch(m.reset_at_utc, 'subsec') * 1000) - round(unixepoch(m.hit_at_utc, 'subsec') * 1000)) / 1000.0 AS hit_to_reset_seconds,
  (SELECT MIN(d.timestamp_utc) FROM requests_dedup d
     WHERE d.session_id = m.session_id AND d.timestamp_utc > m.hit_at_utc) AS next_session_request_at_utc,
  (SELECT p.timestamp_utc FROM parsed_lines p
     WHERE p.session_id = m.session_id AND p.user_content = 'prompt' AND p.is_meta = 0
       AND p.timestamp_utc > m.hit_at_utc
     ORDER BY p.timestamp_utc, p.raw_line_id LIMIT 1) AS next_session_prompt_at_utc,
  -- origin.kind as written (D-022): never relabeled as automatic or manual.
  (SELECT p.origin_kind FROM parsed_lines p
     WHERE p.session_id = m.session_id AND p.user_content = 'prompt' AND p.is_meta = 0
       AND p.timestamp_utc > m.hit_at_utc
     ORDER BY p.timestamp_utc, p.raw_line_id LIMIT 1) AS next_session_prompt_origin_kind,
  m.reset_at_utc > (SELECT covers_to FROM source_coverage WHERE source = 'session_logs') AS reset_after_coverage
FROM merged m;

-- Observed: count of rate-limit interruptions, by source and window.
CREATE VIEW obs_limit_hits AS
SELECT
  COUNT(e.raw_line_id) AS hits,
  COUNT(e.raw_line_id) FILTER (WHERE e.source = 'session_log') AS logged_hits,
  COUNT(e.raw_line_id) FILTER (WHERE e.source = 'status_line') AS status_line_only_hits,
  COUNT(e.raw_line_id) FILTER (WHERE e.window = 'five_hour') AS five_hour_hits,
  COUNT(e.raw_line_id) FILTER (WHERE e.window = 'seven_day') AS seven_day_hits,
  COUNT(e.raw_line_id) FILTER (WHERE e.window IS NULL) AS unknown_window_hits,
  (SELECT covers_from FROM source_coverage WHERE source = 'session_logs') AS covers_from,
  (SELECT covers_to FROM source_coverage WHERE source = 'session_logs') AS covers_to,
  (SELECT covers_from FROM source_coverage WHERE source = 'status_line') AS status_line_covers_from,
  (SELECT covers_to FROM source_coverage WHERE source = 'status_line') AS status_line_covers_to
FROM obs_limit_hits_events e;

-- Observed: the interruptions that stopped the model while it was continuing its own tool loop (D-021).
CREATE VIEW obs_mid_task_interruptions_events AS
SELECT * FROM obs_limit_hits_events WHERE position = 'mid_task';

-- Observed: mid-task interruptions, beside turn-start and unknown-position counts (D-021).
CREATE VIEW obs_mid_task_interruptions AS
SELECT
  COUNT(e.raw_line_id) FILTER (WHERE e.position = 'mid_task') AS mid_task,
  COUNT(e.raw_line_id) FILTER (WHERE e.position = 'turn_start') AS turn_start,
  COUNT(e.raw_line_id) FILTER (WHERE e.position = 'unknown') AS position_unknown,
  (SELECT covers_from FROM source_coverage WHERE source = 'session_logs') AS covers_from,
  (SELECT covers_to FROM source_coverage WHERE source = 'session_logs') AS covers_to
FROM obs_limit_hits_events e;

-- Observed: which merged lockout interval each hit with a known reset belongs to (D-023).
CREATE VIEW obs_lockout_interval_hits AS
WITH spans AS (
  SELECT
    raw_line_id,
    hit_at_utc AS start_utc,
    -- A reset in the hit's own minute can precede the hit by seconds; the span is then empty.
    MAX(reset_at_utc, hit_at_utc) AS end_utc
  FROM obs_limit_hits_events
  WHERE hit_at_utc IS NOT NULL AND reset_at_utc IS NOT NULL
),
ordered AS (
  SELECT
    s.*,
    MAX(end_utc) OVER (ORDER BY start_utc, end_utc, raw_line_id
                       ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_end_utc
  FROM spans s
)
SELECT
  raw_line_id, start_utc, end_utc,
  -- A span starting after every earlier span has ended opens a new interval; touching spans merge.
  SUM(CASE WHEN previous_end_utc IS NULL OR start_utc > previous_end_utc THEN 1 ELSE 0 END)
    OVER (ORDER BY start_utc, end_utc, raw_line_id) AS interval_number
FROM ordered;

-- Observed: merged lockout intervals, hit → reset, with the first Claude Code request at or after each reset (D-023).
CREATE VIEW obs_lockout_intervals AS
WITH grouped AS (
  SELECT
    interval_number,
    MIN(start_utc) AS locked_from_utc,
    MAX(end_utc) AS locked_until_utc,
    COUNT(*) AS hits
  FROM obs_lockout_interval_hits
  GROUP BY interval_number
),
with_next AS (
  SELECT
    g.*,
    (SELECT MIN(d.timestamp_utc) FROM requests_dedup d WHERE d.timestamp_utc >= g.locked_until_utc) AS next_request_at_utc
  FROM grouped g
)
SELECT
  w.*,
  (round(unixepoch(w.locked_until_utc, 'subsec') * 1000) - round(unixepoch(w.locked_from_utc, 'subsec') * 1000)) / 1000.0 AS lockout_seconds,
  (round(unixepoch(w.next_request_at_utc, 'subsec') * 1000) - round(unixepoch(w.locked_until_utc, 'subsec') * 1000)) / 1000.0 AS reset_to_next_request_seconds,
  w.locked_until_utc > (SELECT covers_to FROM source_coverage WHERE source = 'session_logs') AS reset_after_coverage
FROM with_next w;

-- Observed: total elapsed lockout time (hit → reset, overlaps counted once), beside hits whose reset is unknown.
CREATE VIEW obs_lockout_time AS
SELECT
  (SELECT COUNT(*) FROM obs_lockout_intervals) AS intervals,
  (SELECT TOTAL(lockout_seconds) FROM obs_lockout_intervals) AS lockout_seconds,
  (SELECT COUNT(*) FROM obs_lockout_interval_hits) AS hits_with_known_reset,
  (SELECT COUNT(*) FROM obs_limit_hits_events WHERE reset_at_utc IS NULL OR hit_at_utc IS NULL) AS hits_with_unknown_reset,
  (SELECT covers_from FROM source_coverage WHERE source = 'session_logs') AS covers_from,
  (SELECT covers_to FROM source_coverage WHERE source = 'session_logs') AS covers_to;

-- Observed: sessions whose last limit hit has no later request in that session (D-022).
CREATE VIEW obs_sessions_not_resumed_events AS
WITH ranked AS (
  SELECT
    e.session_id, e.raw_line_id, e.hit_at_utc, e.reset_at_utc, e.reset_after_coverage,
    ROW_NUMBER() OVER (PARTITION BY e.session_id ORDER BY e.hit_at_utc DESC, e.raw_line_id DESC) AS hit_rank,
    COUNT(*) OVER (PARTITION BY e.session_id) AS hits
  FROM obs_limit_hits_events e
  WHERE e.session_id IS NOT NULL AND e.session_id <> '<missing>' AND e.hit_at_utc IS NOT NULL
)
SELECT
  session_id,
  raw_line_id AS last_hit_raw_line_id,
  hit_at_utc AS last_hit_at_utc,
  reset_at_utc,
  reset_after_coverage,
  hits
FROM ranked r
WHERE hit_rank = 1
  AND NOT EXISTS (
    SELECT 1 FROM requests_dedup d WHERE d.session_id = r.session_id AND d.timestamp_utc > r.hit_at_utc
  );

-- Observed: sessions not resumed after a limit hit, with those whose reset was after log coverage counted separately.
CREATE VIEW obs_sessions_not_resumed AS
SELECT
  (SELECT COUNT(DISTINCT session_id) FROM obs_limit_hits_events
     WHERE session_id IS NOT NULL AND session_id <> '<missing>' AND hit_at_utc IS NOT NULL) AS sessions_with_hits,
  COUNT(n.session_id) AS sessions_not_resumed,
  COUNT(n.session_id) FILTER (WHERE n.reset_after_coverage = 1) AS reset_after_coverage,
  COUNT(n.session_id) FILTER (WHERE n.reset_at_utc IS NULL) AS reset_unknown,
  (SELECT covers_from FROM source_coverage WHERE source = 'session_logs') AS covers_from,
  (SELECT covers_to FROM source_coverage WHERE source = 'session_logs') AS covers_to
FROM obs_sessions_not_resumed_events n;
