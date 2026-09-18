-- 012_unsplit_cache_writes: unsplit cache writes sum to 0, not NULL, when every request has the split.
--
-- In 010, SUM over cache_write_unsplit_tokens returned NULL for a model or repository whose requests
-- all recorded the 5m/1h split, and the viewer showed "unknown" for tokens that were known to be 0.
-- A NULL in the 5m and 1h columns still means unknown: those tokens exist, but their duration wasn't
-- recorded. Views are recreated rather than editing 010, which existing databases have applied.

DROP VIEW obs_usage_by_model;
DROP VIEW obs_usage_by_repo;

-- Observed: tokens per model per token type, with request counts and unknowns.
CREATE VIEW obs_usage_by_model AS
SELECT
  model,
  COUNT(*) AS requests,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_write_5m_tokens) AS cache_write_5m_tokens,
  SUM(cache_write_1h_tokens) AS cache_write_1h_tokens,
  -- NULL here means every request recorded the 5m/1h split, so there were no unsplit writes: 0, not unknown.
  COALESCE(SUM(cache_write_unsplit_tokens), 0) AS cache_write_unsplit_tokens,
  COUNT(*) FILTER (WHERE dedup_key IS NULL) AS unkeyed_requests,
  COUNT(*) FILTER (WHERE timestamp_utc IS NULL) AS requests_without_timestamp,
  MIN(timestamp_utc) AS first_request_at_utc,
  MAX(timestamp_utc) AS last_request_at_utc,
  (SELECT covers_from FROM source_coverage WHERE source = 'session_logs') AS covers_from,
  (SELECT covers_to FROM source_coverage WHERE source = 'session_logs') AS covers_to
FROM obs_usage_events
GROUP BY model;

-- Observed: tokens per repository (git root, or the working directory outside git; NULL when no cwd) per token type.
CREATE VIEW obs_usage_by_repo AS
SELECT
  repository,
  repo_kind,
  COUNT(*) AS requests,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_write_5m_tokens) AS cache_write_5m_tokens,
  SUM(cache_write_1h_tokens) AS cache_write_1h_tokens,
  -- NULL here means every request recorded the 5m/1h split, so there were no unsplit writes: 0, not unknown.
  COALESCE(SUM(cache_write_unsplit_tokens), 0) AS cache_write_unsplit_tokens,
  COUNT(*) FILTER (WHERE timestamp_utc IS NULL) AS requests_without_timestamp,
  (SELECT covers_from FROM source_coverage WHERE source = 'session_logs') AS covers_from,
  (SELECT covers_to FROM source_coverage WHERE source = 'session_logs') AS covers_to
FROM obs_usage_events
GROUP BY repository, repo_kind;
