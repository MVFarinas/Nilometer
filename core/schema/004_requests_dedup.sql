-- 004_requests_dedup: the deduplicated request set, as a view over derived rows (D-001).
--
-- One API response is written as several cumulative log lines. Each dedup key keeps one winner:
-- largest output_tokens, then the non-sidechain copy, then the later line in (file, first run, line)
-- order. Unkeyed requests (neither message.id nor requestId) pass through as themselves.
-- Rows carry their source position so every number built on this view can be traced to a line.

-- Observed: one row per distinct API response (winners) plus every unkeyed request line.
CREATE VIEW requests_dedup AS
WITH ranked AS (
  SELECT
    r.raw_line_id,
    r.dedup_key,
    r.message_id,
    r.request_id,
    r.model,
    r.input_tokens,
    r.output_tokens,
    r.cache_read_tokens,
    r.cache_write_5m_tokens,
    r.cache_write_1h_tokens,
    r.cache_write_unsplit_tokens,
    r.speed,
    p.session_id,
    p.timestamp_raw,
    p.timestamp_utc,
    p.cwd,
    p.is_sidechain,
    f.root,
    f.relative_path,
    l.first_run_id,
    l.line_number,
    ROW_NUMBER() OVER (
      PARTITION BY r.dedup_key
      ORDER BY r.output_tokens DESC, p.is_sidechain ASC,
               f.root DESC, f.relative_path DESC, l.first_run_id DESC, l.line_number DESC
    ) AS candidate_rank
  FROM requests r
  JOIN parsed_lines p ON p.raw_line_id = r.raw_line_id
  JOIN raw_lines l ON l.id = r.raw_line_id
  JOIN source_files f ON f.id = l.source_file_id
)
SELECT
  raw_line_id, dedup_key, message_id, request_id, model,
  input_tokens, output_tokens, cache_read_tokens,
  cache_write_5m_tokens, cache_write_1h_tokens, cache_write_unsplit_tokens, speed,
  session_id, timestamp_raw, timestamp_utc, cwd, is_sidechain,
  root, relative_path, first_run_id, line_number
FROM ranked
WHERE dedup_key IS NULL OR candidate_rank = 1;
