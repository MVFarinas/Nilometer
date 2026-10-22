-- 030_repository_aliases: a renamed or moved project's old path counts under its new one (D-092, step G4.5).
--
-- Nothing in the logs links a repository's old path to its new one (D-028), so a renamed or moved
-- project shows twice. The first real case: this project under its old name on the old Mac, a
-- directory that no longer exists, beside its current checkout. The user enters the link with
-- `nilometer alias set`; it's user data, like plan prices, and rebuilds never touch it. Each
-- request keeps the path it was attributed to before the alias, so every number still traces.

-- User data: one row per old path; entering the same old path again replaces its target.
CREATE TABLE repository_aliases (
  from_repository TEXT PRIMARY KEY, -- source: user entry, a repository path exactly as attributed (the old name or place)
  to_repository   TEXT NOT NULL,    -- source: user entry, the repository path its requests count under
  entered_at      TEXT NOT NULL,    -- derived: ISO-8601 UTC time the row was written
  CHECK (from_repository <> to_repository)
) STRICT;

DROP VIEW request_repositories;

-- Observed: each deduplicated request's repository (worktrees and subfolders count as their repository, D-028, D-049), after any alias the user entered (D-092), with the path it had before.
CREATE VIEW request_repositories AS
WITH attributed AS (
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
  LEFT JOIN repositories r ON r.cwd = d.cwd
),
normalized AS MATERIALIZED (
  SELECT
    raw_line_id,
    cwd,
    repo_kind,
    CASE
      WHEN repository GLOB '[A-Za-z]:[\/]*'
      THEN upper(substr(repository, 1, 1)) || replace(substr(repository, 2), char(92), '/')
      ELSE repository
    END AS repository,
    resolved_via
  FROM attributed
),
targets AS (
  -- An aliased request takes its target's kind, so the two count as one row: a repository when any
  -- request under the target is one, else whatever the target has, else its own.
  SELECT
    a.from_repository,
    a.to_repository,
    (SELECT m.repo_kind FROM normalized m WHERE m.repository = a.to_repository
       ORDER BY m.repo_kind = 'repo' DESC, m.repo_kind LIMIT 1) AS to_kind
  FROM repository_aliases a
)
SELECT
  n.raw_line_id,
  n.cwd,
  CASE WHEN t.from_repository IS NULL THEN n.repo_kind ELSE COALESCE(t.to_kind, n.repo_kind) END AS repo_kind,
  COALESCE(t.to_repository, n.repository) AS repository,
  n.resolved_via,
  -- The repository the request had before an alias moved it; NULL when no alias applies.
  CASE WHEN t.from_repository IS NULL THEN NULL ELSE n.repository END AS aliased_from
FROM normalized n
LEFT JOIN targets t ON t.from_repository = n.repository;

DROP VIEW obs_usage_events;

-- Observed: every deduplicated request with its repository, as obs_usage_by_repo sums it (D-028), and the path an alias moved it from (D-092).
CREATE VIEW obs_usage_events AS
SELECT
  d.raw_line_id, d.dedup_key, d.session_id, d.timestamp_utc, d.model,
  r.repository, r.repo_kind,
  d.input_tokens, d.output_tokens, d.cache_read_tokens,
  d.cache_write_5m_tokens, d.cache_write_1h_tokens, d.cache_write_unsplit_tokens,
  r.aliased_from
FROM requests_dedup d
JOIN request_repositories r ON r.raw_line_id = d.raw_line_id;
