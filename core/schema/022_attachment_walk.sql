-- 022_attachment_walk: a limit hit's position looks past attachment lines of known metadata types (D-076, step G2.3).
--
-- D-021 decides a hit's position by its direct parent: a tool result means the model was inside
-- its own loop (mid-task), a non-meta prompt means a turn had just started, anything else is
-- unknown. Newer Claude Code versions write attachment lines between a request and what it
-- answered: token reminders, environment and memory context, hook output, and the like. By the
-- end of Phase 8 the direct parent of 24 of 31 hits was such a line, so "unknown" held most hits.
--
-- The walk follows a hit's parent chain past attachment lines whose type is classified as
-- metadata Claude Code adds by itself, and decides the position by D-021's rule at the first line
-- that isn't one. attachment_walk lists every type seen in real logs on 2026-10-13, classified by
-- its keys only (no values). A type not listed stops the walk, so a type a future Claude Code
-- adds can only leave a hit unknown; it can never move one to mid-task.

-- Reference: which attachment types the position walk passes (D-076). Seeded here, not derived.
CREATE TABLE attachment_walk (
  attachment_type TEXT PRIMARY KEY, -- source: attachment.type, as written in session logs (classified by structure, D-076)
  rule            TEXT NOT NULL,    -- source: D-076: 'pass' walks past it; 'by_fields' passes it only when its own fields say it's automatic
  CHECK (rule IN ('pass', 'by_fields'))
) STRICT;

INSERT INTO attachment_walk (attachment_type, rule) VALUES
  -- Reminders Claude Code adds.
  ('total_tokens_reminder', 'pass'),
  ('batching_reminder_sent', 'pass'),
  ('silent_turn_reminder', 'pass'),
  ('todo_reminder', 'pass'),
  ('task_reminder', 'pass'),
  ('plan_mode', 'pass'),
  -- Session context.
  ('environment', 'pass'),
  ('date', 'pass'),
  ('date_change', 'pass'),
  ('model', 'pass'),
  ('session_context', 'pass'),
  ('instructions', 'pass'),
  ('nested_memory', 'pass'),
  ('credential_org', 'pass'),
  ('auto_mode', 'pass'),
  ('command_permissions', 'pass'),
  ('remote_session_change', 'pass'),
  ('prompt_snapshot', 'pass'),
  -- Tool and skill listings.
  ('deferred_tools_record', 'pass'),
  ('deferred_tools_delta', 'pass'),
  ('mcp_instructions_delta', 'pass'),
  ('skill_listing', 'pass'),
  ('agent_listing_delta', 'pass'),
  ('invoked_skills', 'pass'),
  -- Notes on a tool call; the walk continues to the tool result they annotate.
  ('hook_success', 'pass'),
  ('hook_system_message', 'pass'),
  ('hook_additional_context', 'pass'),
  ('bash_output_audience_note', 'pass'),
  ('read_truncation_notice', 'pass'),
  ('structured_output', 'pass'),
  -- Notes on files and thinking.
  ('edited_text_file', 'pass'),
  ('compact_file_reference', 'pass'),
  ('thinking_drop', 'pass'),
  ('thinking_stripped', 'pass'),
  -- Carried with a prompt or a tool result; the walk continues to the line they belong to.
  ('file', 'pass'),
  ('plan_mode_exit', 'pass'),
  -- A message delivered into a running loop: automatic when it's a task notification (247 of 271
  -- on real data); a human or peer message is input, so it stops the walk.
  ('queued_command', 'by_fields');

DROP VIEW logged_limit_hits;

-- Observed: logged limit hits, one per distinct line (copies of a uuid in one session count once), with the
-- D-021 position decided past metadata attachment lines (D-076). Window and reset prefer quotaLimits (D-067).
CREATE VIEW logged_limit_hits AS
WITH RECURSIVE copies AS (
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
),
firsts AS (
  SELECT * FROM copies WHERE copy_rank = 1
),
-- Each hit's parent chain. A step finds its line as D-021 did: the first copy, in canonical
-- order, of the parent uuid in the hit's session. The walk takes another step only past an
-- attachment that attachment_walk passes; 50 steps is far past any chain seen (8), and stops a
-- loop of uuids, which nothing guarantees can't occur.
walk (raw_line_id, session_id, line_id, passed) AS (
  SELECT
    h.raw_line_id,
    h.session_id,
    (SELECT par.raw_line_id FROM parsed_lines par
       JOIN raw_lines pl ON pl.id = par.raw_line_id
       JOIN source_files pf ON pf.id = pl.source_file_id
       WHERE par.session_id = h.session_id AND par.uuid = h.parent_uuid
       ORDER BY pf.root, pf.relative_path, pl.first_run_id, pl.line_number
       LIMIT 1),
    0
  FROM firsts h
  UNION ALL
  SELECT
    w.raw_line_id,
    w.session_id,
    (SELECT par.raw_line_id FROM parsed_lines par
       JOIN raw_lines pl ON pl.id = par.raw_line_id
       JOIN source_files pf ON pf.id = pl.source_file_id
       WHERE par.session_id = w.session_id AND par.uuid = cur.parent_uuid
       ORDER BY pf.root, pf.relative_path, pl.first_run_id, pl.line_number
       LIMIT 1),
    w.passed + 1
  FROM walk w
  JOIN parsed_lines cur ON cur.raw_line_id = w.line_id
  JOIN raw_lines cb ON cb.id = cur.raw_line_id
  -- The attachment's type is read from its raw bytes: parsed_lines doesn't keep it, and only the
  -- few lines on a hit's chain are read this way.
  JOIN attachment_walk aw
    ON aw.attachment_type = json_extract(CAST(cb.bytes AS TEXT), '$.attachment.type')
  WHERE cur.type = 'attachment'
    AND (aw.rule = 'pass'
         OR json_extract(CAST(cb.bytes AS TEXT), '$.attachment.commandMode') = 'task-notification')
    AND w.passed < 50
),
-- Where each walk stopped: its last step.
ends AS (
  SELECT raw_line_id, line_id, passed
  FROM (
    SELECT w.*, ROW_NUMBER() OVER (PARTITION BY w.raw_line_id ORDER BY w.passed DESC) AS step_rank
    FROM walk w
  )
  WHERE step_rank = 1
)
SELECT
  c.raw_line_id, c.session_id, c.uuid, c.parent_uuid, c.timestamp_utc, c.is_sidechain,
  -- The structured field is exact and doesn't depend on wording; the text is the fallback for
  -- lines written before Claude Code added quotaLimits.
  COALESCE(c.quota_window, c.text_window) AS window,
  c.reset_text,
  COALESCE(c.quota_resets_at_utc, c.text_reset_at_utc) AS reset_at_utc,
  -- D-021's rule, at the line the walk stopped on. A missing parent, a meta line, another type, or
  -- an attachment the walk doesn't pass all leave the position unknown.
  COALESCE((
    SELECT CASE
      WHEN par.user_content = 'tool_result' THEN 'mid_task'
      WHEN par.user_content = 'prompt' AND par.is_meta = 0 THEN 'turn_start'
      ELSE 'unknown'
    END
    FROM parsed_lines par
    WHERE par.raw_line_id = e.line_id
  ), 'unknown') AS position,
  -- How many attachment lines the walk passed to decide it (D-076): 0 is D-021's direct parent.
  e.passed AS attachments_passed,
  CASE WHEN c.quota_window IS NOT NULL THEN 'log_field'
       WHEN c.text_window IS NOT NULL THEN 'log_text' END AS window_source,
  CASE WHEN c.quota_resets_at_utc IS NOT NULL THEN 'log_field'
       WHEN c.text_reset_at_utc IS NOT NULL THEN 'log_text' END AS reset_source
FROM firsts c
JOIN ends e ON e.raw_line_id = c.raw_line_id;

DROP VIEW obs_limit_hits_events;

-- Observed: every rate-limit interruption, logged hits merged with status line groups without double-counting
-- (D-004, D-023), each with the attachment lines its position looked past (D-076).
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
    l.is_sidechain,
    l.attachments_passed
  FROM logged l
  LEFT JOIN status_limit_groups g ON g.raw_line_id = l.status_raw_line_id
  UNION ALL
  -- A hit seen only in the status line has no parent to walk: unknown, past nothing.
  SELECT 'status_line', g.raw_line_id, g.raw_line_id, g.session_id, g.first_at_utc, g.window,
         g.reset_at_utc, 'status_line', NULL, 'unknown', 0, 0
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
