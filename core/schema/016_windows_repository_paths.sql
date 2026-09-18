-- 016_windows_repository_paths: a Windows repository path is written one way, whatever its source (D-049).
--
-- Observed on a Windows PC (2026-09-17, counts and structure only): Claude Code logged working
-- directories with `\` separators and with the drive letter both as `C:` and `c:`, while git returns
-- repository roots with `/` separators. For a folder that still exists, git resolved both spellings to
-- one root. A deleted folder with no known root is its own repository, so one such folder appeared as
-- two rows. Here a repository that starts with a drive letter gets an uppercase letter and `/`
-- separators. Windows paths are case-insensitive for the drive, and a POSIX repository is an absolute
-- path starting with `/`, so no POSIX value changes. The stored cwd and repo_root keep their source
-- spelling; only the attributed repository is normalized.

DROP VIEW request_repositories;

-- Observed: each request's repository and how it was attributed (D-010, D-028); a missing folder whose repository still exists counts as that repository; a Windows path is written with an uppercase drive letter and `/` separators (D-049).
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
)
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
FROM attributed;
