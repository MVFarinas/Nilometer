-- 005_repositories: which repository each working directory belongs to (D-010).
--
-- Filled by core/ingest/attribution.ts, once per distinct cwd, using git's common directory, so
-- worktrees and subdirectories of one repository share a repo_root. Unlike the derived tables in
-- 003, this depends on the filesystem at resolution time (a directory can disappear later), so it
-- is a cache and is not part of the rebuild-identical set.

CREATE TABLE repositories (
  cwd         TEXT PRIMARY KEY, -- source: cwd from log lines
  kind        TEXT NOT NULL,    -- derived: 'repo', 'not_git' (git found no repository), or 'missing' (path gone)
  repo_root   TEXT,             -- derived: parent of git's common dir (the dir itself for bare repos); NULL unless kind = 'repo'
  resolved_at TEXT NOT NULL,    -- derived: ISO-8601 UTC time of resolution
  CHECK (kind IN ('repo', 'not_git', 'missing')),
  CHECK ((kind = 'repo') = (repo_root IS NOT NULL))
) STRICT;

-- Observed: each request's repository, or its working directory when it has none.
CREATE VIEW request_repositories AS
SELECT
  d.raw_line_id,
  d.cwd,
  COALESCE(r.kind, 'unresolved') AS repo_kind,
  COALESCE(r.repo_root, d.cwd) AS repository
FROM requests_dedup d
LEFT JOIN repositories r ON r.cwd = d.cwd;
