# Changelog

## 0.1.0 (unreleased)

First public version.

- **Status line collector:** a POSIX shell hook that records Claude Code's `rate_limits` payload after every terminal reply, wrapping any status line you already have. `init` installs it with a settings backup, and `uninstall` restores the previous setting.
- **Ingestion:** session logs and status line readings copied into a local SQLite database, with backfill from every log still on disk, deduplication of streamed responses, and a report of anything malformed.
- **Report:** observed interruptions (limit hits, mid-task hits, elapsed lockout time, sessions not resumed), usage windows (last observed usage, peak), unattributed usage, and usage by model and repository. Projections are kept in a separate, labeled section: burn rate, and observed tokens at API list price beside your plan price.
- **`explain`:** the events behind any number, with file, line, and byte, added back up.
- **`report --save`:** dated text and JSON copies.
- **`verify`:** runs the same comparison the audit makes against [ccusage](https://github.com/ryoppippi/ccusage), but on your own logs, and prints a verdict and any differing day, model and field. Nothing it prints is a path, a repository name, a session id, or prompt text, so the result can be shared without the data behind it. The one command that uses the network.
- **`uninstall --delete-data`:** removes the recorded data too, after saying what it held and that it cannot be undone. It removes only the files Nilometer wrote, and names anything it left alone.
- **Platforms:** macOS; Windows with Git for Windows; Linux, tested in CI.
