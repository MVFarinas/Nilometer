# Changelog

## 0.1.0 (unreleased)

First public version.

- **Status line collector:** a POSIX shell hook that records Claude Code's `rate_limits` payload after every terminal reply, wrapping any status line you already have. `init` installs it with a settings backup, and `uninstall` restores the previous setting.
- **Ingestion:** session logs and status line readings copied into a local SQLite database, with backfill from every log still on disk, deduplication of streamed responses, and a report of anything malformed.
- **Report:** observed interruptions (limit hits, mid-task hits, elapsed lockout time, sessions not resumed), usage windows (last observed usage, peak), unattributed usage, and usage by model and repository. Projections are kept in a separate, labeled section: burn rate, and observed tokens at API list price beside your plan price.
- **`explain`:** the events behind any number, with file, line, and byte, added back up.
- **`report --save`:** dated text and JSON copies.
- **Platforms:** macOS; Windows with Git for Windows; Linux, tested in CI.
