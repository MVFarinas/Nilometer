# Changelog

## 0.1.0 (unreleased)

First public version.

- **Status line collector:** a POSIX shell hook that records Claude Code's `rate_limits` payload after every terminal reply, wrapping any status line you already have. `init` installs it with a settings backup, and `uninstall` restores the previous setting.
- **Ingestion:** session logs and status line readings copied into a local SQLite database, with backfill from every log still on disk, deduplication of streamed responses, and a report of anything malformed.
- **Report:** observed interruptions (limit hits, mid-task hits, elapsed lockout time, sessions not resumed), usage windows (last observed usage, peak), unattributed usage, and usage by model and repository. Projections are kept in a separate, labeled section: burn rate, and observed tokens at API list price beside your plan price.
- **`explain`:** the events behind any number, with file, line, and byte, added back up.
- **`report --save`:** dated text and JSON copies.
- **`report --save --html`:** also saves the report as one HTML page you open in a browser, beside the text and JSON copies. It draws the same numbers as charts, and clicking a bar, column, or point lists the events behind it. Everything is inside the file, so it works offline and makes no network requests. Like `explain` output, it includes session IDs.
- **`verify`:** runs the same comparison the audit makes against [ccusage](https://github.com/ryoppippi/ccusage), but on your own logs, and prints a verdict and any differing day, model and field. Nothing it prints is a path, a repository name, a session id, or prompt text, so the result can be shared without the data behind it. The one command that uses the network.
- **`uninstall --delete-data`:** removes the recorded data too, after saying what it held and that it cannot be undone. It removes only the files Nilometer wrote, and names anything it left alone.
- **Platforms:** macOS; Windows with Git for Windows; Linux, tested in CI.
- **Prices:** every model on Anthropic's pricing page has a dated, sourced row, including Opus 5.5 and Mythos 5.1, whose cache reads are priced at their own rates rather than their family's. A model that isn't on the page stays unpriced and is reported as such, never priced as $0.
- **Node.js check:** every command checks the Node.js version first. On a version older than 24 it stops with a message saying what to install, where it used to crash with no explanation; on a newer one it warns that the version isn't tested and runs.
- **Limit hits read structured fields:** on current Claude Code versions, the window and reset of a limit hit come from the structured `quotaLimits` fields in the log, with the message text as the fallback for older versions. Each hit records which source it used, and any disagreement between the two is reported.
- **Usage above 100% is kept:** a usage window reading above 100%, which Claude Code reports once a limit is passed, is recorded as a reading instead of being discarded as invalid, so peak and last observed usage show it.
- **Concurrent sessions no longer corrupt status line readings:** the hook appends each reading in a single write. Before, a reading written while other sessions' hooks ran could interleave with theirs, and both were lost (reported as malformed). Run `nilometer init` after updating to install the new hook.
- **Install guide:** [`docs/requirements.md`](docs/requirements.md) explains how to check for and install everything Nilometer needs, including how to get Node.js 24 and not a newer release.
