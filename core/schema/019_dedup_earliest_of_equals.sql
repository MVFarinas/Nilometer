-- 019_dedup_earliest_of_equals: when the dedup rule cannot choose, take the earliest line.
--
-- One API response is written as several lines and the largest output_tokens wins (D-001). When
-- every line carries the SAME counts the rule selects nothing, and the tie-breaks that followed it
-- ended on `line_number DESC` — the last line — which decided nothing except, at a day boundary,
-- which day the response landed on. Observed on a real log set: one response written three times
-- across 23:59:57 to 00:00:01, counted on the later day here and the earlier one by ccusage.
--
-- The rule this project already states for the same problem is D-045: collapse duplicates of one
-- response and date it by its first line, "when its numbers first existed". That is applied here.
-- Nothing changes where output_tokens grow, because the largest still wins before this is reached.
-- Source: no API field; this is a choice among lines the API produced (D-001, D-045, D-065).
DROP VIEW requests_dedup;

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
               -- Among lines tied on output, the earliest: when those numbers first existed
               -- (D-065, the same rule D-045 applies to readings). NULLs last, so an unparsed
               -- timestamp never wins.
               (p.timestamp_utc IS NULL) ASC, p.timestamp_utc ASC,
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
