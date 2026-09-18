# Security

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab → **Report a vulnerability**. Please don't open a public issue for a security problem.

Include what you found, how to reproduce it, and what it could expose. Don't attach real session logs, reports, databases, or settings files: they hold prompts, code, file paths, and spend figures. A synthetic reproduction is enough.

This is a small project maintained in spare time, so replies are best effort. You'll get an acknowledgement, and a fix or a decision is recorded before the report is made public.

## Supported versions

Only the latest release gets fixes.

## What's in scope

- **Exposure of recorded data:** the database holds copies of Claude Code session logs, so anything that makes it readable by another account, sends it anywhere, or leaks it into output is in scope.
- **Changes to Claude Code's settings:** `init` and `uninstall` edit `settings.json`. Anything that clobbers a user's settings, runs an unexpected command, or mishandles a backup is in scope.
- **The status line hook:** it runs after every Claude Code reply. Anything that lets it write outside the data directory or change what the status bar shows is in scope.

Nilometer makes no network requests while it collects or reports: not when the hook runs, not during
`ingest`, and not when a report is built. A report that it does is in scope too.

Two commands reach the network, both by fetching a pinned
[ccusage](https://github.com/ryoppippi/ccusage) through `npx`, and neither runs unless you run it:

- **`nilometer verify`** compares this tool's token totals against ccusage on your own logs, and
  prints a verdict and any differing days. It reads your logs and your database locally and sends
  nothing anywhere. Its output is deliberately free of paths, repository names, session ids and
  prompt text, so it can be shared without sharing your data.
- **`npm run compare:ccusage`** is the same comparison over the committed fixtures, as an audit
  check. It reads only those fixtures.

Nothing either one downloads is used by the installed tool.
