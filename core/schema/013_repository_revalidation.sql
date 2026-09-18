-- 013_repository_revalidation: repositories remembers how each working directory resolved and whether its root exists (D-028).
--
-- 005 cached one resolution per working directory forever, so a renamed or deleted folder kept its
-- "git repository" label, and a subfolder deleted before its first ingest couldn't be placed in its
-- repository. The table is rebuilt because SQLite can't change CHECK constraints in place, and the
-- views that read it are recreated around the rebuild. Only 'repo' and 'not_git' rows are carried
-- over: 'missing' rows are dropped so the next ingest resolves them again with the parent-folder
-- lookup. Every carried row is re-checked against the filesystem on that ingest too.

DROP VIEW obs_usage_by_model;
DROP VIEW obs_usage_by_repo;
DROP VIEW obs_usage_events;
DROP VIEW request_repositories;

CREATE TABLE repositories_013 (
  cwd          TEXT PRIMARY KEY, -- source: cwd from log lines
  kind         TEXT NOT NULL,    -- derived: the working directory at the last check: 'repo', 'not_git', or 'missing'
  repo_root    TEXT,             -- derived: git's root for 'repo'; for 'missing', the last-known or nearest existing parent's root; else NULL
  root_exists  INTEGER,          -- derived: 1 if repo_root existed at the last check, 0 if not; NULL without repo_root
  resolved_via TEXT NOT NULL,    -- derived: 'git' (run in the directory), 'last_known', 'parent', or 'none'
  resolved_at  TEXT NOT NULL,    -- derived: ISO-8601 UTC time of the last resolution
  CHECK (kind IN ('repo', 'not_git', 'missing')),
  CHECK (resolved_via IN ('git', 'last_known', 'parent', 'none')),
  CHECK (root_exists IN (0, 1)),
  CHECK ((repo_root IS NULL) = (root_exists IS NULL)),
  CHECK (kind <> 'repo' OR (repo_root IS NOT NULL AND resolved_via = 'git')),
  CHECK (kind <> 'not_git' OR (repo_root IS NULL AND resolved_via = 'git')),
  CHECK (kind <> 'missing' OR (resolved_via = 'none') = (repo_root IS NULL)),
  CHECK (kind = 'missing' OR resolved_via = 'git')
) STRICT;

INSERT INTO repositories_013 (cwd, kind, repo_root, root_exists, resolved_via, resolved_at)
SELECT cwd, kind, repo_root, CASE WHEN repo_root IS NULL THEN NULL ELSE 1 END, 'git', resolved_at
FROM repositories
WHERE kind IN ('repo', 'not_git');

DROP TABLE repositories;
ALTER TABLE repositories_013 RENAME TO repositories;

-- Observed: each request's repository and how it was attributed (D-010, D-028); a missing folder whose repository still exists counts as that repository.
CREATE VIEW request_repositories AS
SELECT
  d.raw_line_id,
  d.cwd,
  CASE
    WHEN r.cwd IS NULL THEN 'unresolved'
    WHEN r.repo_root IS NOT NULL AND r.root_exists = 1 THEN 'repo'
    WHEN r.repo_root IS NOT NULL THEN 'missing'
    ELSE r.kind
  END AS repo_kind,
  COALESCE(r.repo_root, d.cwd) AS repository,
  r.resolved_via
FROM requests_dedup d
LEFT JOIN repositories r ON r.cwd = d.cwd;

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
