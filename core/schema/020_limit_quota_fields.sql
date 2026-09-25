-- 020_limit_quota_fields: a limit hit's window and reset come from quotaLimits when Claude Code writes it (D-067).
--
-- D-004 read the window and reset only from the message text, because that was the only place
-- they existed (Claude Code 2.1.214). By 2.1.281 every limit-hit line also carries a structured
-- quotaLimits object with rateLimitType and resetsAt (observed 2026-09-24; they agreed with the
-- text on every hit examined). The text parse stays for older lines, and events.window,
-- events.reset_text, and events.reset_at_utc keep meaning "from the text". The structured values
-- get their own columns, the views prefer them, and each logged hit says which source its window
-- and reset came from. Where the two disagree, ingestion records a line problem (report, don't
-- fix): 'quota_window_disagrees' and 'quota_reset_disagrees'; a member present but unusable is
-- 'unusable_quota_field'. line_problems is rebuilt to admit those codes, because SQLite can't
-- change a CHECK constraint in place; it's derived data, and the parser version bump that ships
-- with this migration re-derives it anyway.

ALTER TABLE events ADD COLUMN quota_window TEXT CHECK (quota_window IN ('five_hour', 'seven_day')); -- source: quotaLimits.rateLimitType when it's 'five_hour' or 'seven_day' (limit hits only, D-067)
ALTER TABLE events ADD COLUMN quota_resets_at_utc TEXT; -- source: quotaLimits.resetsAt (Unix seconds, whole, 1..253402300799) as ISO-8601 UTC (limit hits only, D-067)

CREATE TABLE line_problems_020 (
  id          INTEGER PRIMARY KEY, -- derived: row identity
  raw_line_id INTEGER NOT NULL REFERENCES raw_lines (id), -- derived: the line with the problem
  problem     TEXT NOT NULL,       -- derived: 'missing_field', 'unparsed_timestamp', 'non_message_iteration', 'unusable_quota_field', 'quota_window_disagrees', or 'quota_reset_disagrees'
  detail      TEXT,                -- derived: the field name, raw timestamp JSON, iteration type, quotaLimits member, or both disagreeing values
  CHECK (problem IN ('missing_field', 'unparsed_timestamp', 'non_message_iteration', 'unusable_quota_field', 'quota_window_disagrees', 'quota_reset_disagrees'))
) STRICT;
INSERT INTO line_problems_020 (id, raw_line_id, problem, detail)
  SELECT id, raw_line_id, problem, detail FROM line_problems;
DROP TABLE line_problems;
ALTER TABLE line_problems_020 RENAME TO line_problems;
CREATE INDEX line_problems_line ON line_problems (raw_line_id);

DROP VIEW logged_limit_hits;

-- Observed: logged limit hits, one per distinct line (copies of a uuid in one session count once), with the D-021 position.
-- Window and reset prefer quotaLimits over the message text (D-067), and say which one they came from.
CREATE VIEW logged_limit_hits AS
WITH copies AS (
  SELECT
    p.raw_line_id, p.session_id, p.uuid, p.parent_uuid, p.timestamp_utc, p.is_sidechain,
    e.window AS text_window, e.quota_window, e.reset_text,
    e.reset_at_utc AS text_reset_at_utc, e.quota_resets_at_utc,
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
  -- The structured field is exact and doesn't depend on wording; the text is the fallback for
  -- lines written before Claude Code added quotaLimits.
  COALESCE(c.quota_window, c.text_window) AS window,
  c.reset_text,
  COALESCE(c.quota_resets_at_utc, c.text_reset_at_utc) AS reset_at_utc,
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
  ), 'unknown') AS position,
  CASE WHEN c.quota_window IS NOT NULL THEN 'log_field'
       WHEN c.text_window IS NOT NULL THEN 'log_text' END AS window_source,
  CASE WHEN c.quota_resets_at_utc IS NOT NULL THEN 'log_field'
       WHEN c.text_reset_at_utc IS NOT NULL THEN 'log_text' END AS reset_source
FROM copies c
WHERE c.copy_rank = 1;

DROP VIEW obs_limit_hits_events;

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
    -- The payload's resets_at is exact; so is quotaLimits.resetsAt, and reset text has minute precision.
    COALESCE(g.reset_at_utc, l.reset_at_utc) AS reset_at_utc,
    CASE WHEN g.raw_line_id IS NOT NULL THEN 'status_line' ELSE l.reset_source END AS reset_source,
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
