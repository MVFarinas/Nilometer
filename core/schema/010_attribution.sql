-- 010_attribution: where observed usage goes, by model and repository, and budget used outside Claude Code (P6.3).
--
-- Model and repository metrics are log-derived and cover the logs' span; unattributed usage is
-- status-line-derived and covers the status line's span (README principle 5). Token sums are
-- per request after dedup (D-001, D-007). A token type with no requests reporting it sums to NULL.

-- Observed: every deduplicated request with the model and repository it's attributed to.
CREATE VIEW obs_usage_events AS
SELECT
  d.raw_line_id, d.dedup_key, d.session_id, d.timestamp_utc, d.model,
  r.repository, r.repo_kind,
  d.input_tokens, d.output_tokens, d.cache_read_tokens,
  d.cache_write_5m_tokens, d.cache_write_1h_tokens, d.cache_write_unsplit_tokens
FROM requests_dedup d
JOIN request_repositories r ON r.raw_line_id = d.raw_line_id;

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
  SUM(cache_write_unsplit_tokens) AS cache_write_unsplit_tokens,
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
  SUM(cache_write_unsplit_tokens) AS cache_write_unsplit_tokens,
  COUNT(*) FILTER (WHERE timestamp_utc IS NULL) AS requests_without_timestamp,
  (SELECT covers_from FROM source_coverage WHERE source = 'session_logs') AS covers_from,
  (SELECT covers_to FROM source_coverage WHERE source = 'session_logs') AS covers_to
FROM obs_usage_events
GROUP BY repository, repo_kind;

-- Observed: consecutive readings of one window, the change between them, and Claude Code requests in between (D-025).
CREATE VIEW window_reading_pairs AS
WITH ordered AS (
  SELECT
    r.*,
    LAG(r.raw_line_id) OVER w AS previous_raw_line_id,
    LAG(r.used_percentage) OVER w AS previous_used_percentage,
    LAG(r.captured_at_s) OVER w AS previous_captured_at_s
  FROM window_readings r
  WHERE r.captured_after_reset = 0
  WINDOW w AS (PARTITION BY r.window, r.resets_at ORDER BY r.captured_at_s, r.raw_line_id)
)
SELECT
  o.window,
  o.reset_at_utc,
  o.previous_raw_line_id,
  o.raw_line_id,
  strftime('%Y-%m-%dT%H:%M:%fZ', o.previous_captured_at_s, 'unixepoch') AS previous_captured_at_utc,
  o.captured_at_utc,
  o.used_percentage - o.previous_used_percentage AS change_percentage_points,
  -- Captures are whole seconds: include the previous capture's second, and one second past this capture.
  (SELECT COUNT(*) FROM requests_dedup d
     WHERE d.timestamp_utc >= strftime('%Y-%m-%dT%H:%M:%fZ', o.previous_captured_at_s, 'unixepoch')
       AND d.timestamp_utc < strftime('%Y-%m-%dT%H:%M:%fZ', o.captured_at_s + 1, 'unixepoch')) AS requests_between
FROM ordered o
WHERE o.previous_raw_line_id IS NOT NULL;

-- Observed: reading pairs whose usage rose with no Claude Code request in between (D-025).
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
  -- Fewer than two readings means no pair was observed: unknown, not 0.
  CASE WHEN i.readings >= 2 THEN
    (SELECT TOTAL(e.change_percentage_points) FROM obs_unattributed_usage_events e
       WHERE e.window = i.window AND e.reset_at_utc = i.reset_at_utc)
  END AS unattributed_percentage_points,
  i.window_open,
  i.covers_from,
  i.covers_to
FROM window_instances i;
