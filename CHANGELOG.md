# Changelog

## 0.2.1 (2026-10-26)

- **A clone pulled without `npm run build` no longer reports old numbers.** Its compiled code ran newer migrations it didn't know how to keep up to date, so the report and `verify` read a copy of the requests that stopped at the pull. Nilometer now stops with "run npm run build" when its schema files or its database are newer than its code, and opening the database refreshes that copy whenever it has fallen behind. npm installs weren't affected.

## 0.2.0 (2026-10-22)

- **`nilometer view`:** shows the report page in your browser with a **Refresh** button that reads new log lines and rebuilds the page in place, on the tab you're on. It runs until you press Ctrl+C, listening on 127.0.0.1 only, behind a random address made for each run; a refresh must come from that page. `report --save --html` still writes a page you can keep or share, with no button.
- **Reports in seconds:** on three months of real data, `report` went from 23 s to under 2 s, and `report --save --html` from 53 s to under 7 s, with the same output. Ingest now stores the two building blocks every report query read, instead of each query recomputing them. The first `ingest` after updating takes a few seconds longer, once.

## 0.1.0 (2026-10-22)

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
- **Published to npm:** `npm install -g nilometer`, then `nilometer init`; or `npx nilometer <command>` without installing. `nilometer --version` prints the installed version. Every push now installs the packed package in an empty home on Linux, macOS and Windows, under Node.js 24 and 26: `init`, a status line reading, the package removed (the hook still records), ingest, report, and an `uninstall` that leaves `settings.json` byte-identical.
- **Nothing to compile:** the database is Node's built-in SQLite (`node:sqlite`) instead of the `better-sqlite3` native module, so installing downloads no binary and needs no compiler. Reports are unchanged: on the same database, both produce the same JSON. They take about 3% longer.
- **Node.js 26:** tested beside Node.js 24, on Linux, macOS and Windows. The SQLite inside Node.js 26 refused two of the interruption views ("nested too deep"). They now read each underlying view once, which gives the same numbers and halves the time those views take.
- **Node.js check:** every command checks the Node.js version first. On a version older than 24 it stops with a message saying what to install, where it used to crash with no explanation; on a version other than 24 or 26 it warns that the version isn't tested and runs.
- **Limit hits read structured fields:** on current Claude Code versions, the window and reset of a limit hit come from the structured `quotaLimits` fields in the log, with the message text as the fallback for older versions. Each hit records which source it used, and any disagreement between the two is reported.
- **Usage above 100% is kept:** a usage window reading above 100%, which Claude Code reports once a limit is passed, is recorded as a reading instead of being discarded as invalid, so peak and last observed usage show it.
- **Concurrent sessions no longer corrupt status line readings:** the hook appends each reading in a single write. Before, a reading written while other sessions' hooks ran could interleave with theirs, and both were lost (reported as malformed). Run `nilometer init` after updating to install the new hook.
- **The HTML page has tabs:**
  - **Overview first:** a card for each observed chart, with its key numbers and a small picture of the chart.
  - **Then one tab per chart:** usage windows, interruptions, by model, and by repository.
  - **Projections in their own labelled group:** burn rate and observed tokens at API list price.

  Usage by repository and burn rate are new to the page; before, only the text report showed them. Every number on a card still opens its events. Printing shows every tab, and without JavaScript the page reads top to bottom as before.
- **Interruptions per plan:**
  - **Per plan period:** once you've entered a plan price with `plan-price set`, the report splits limit hits, lockouts, and elapsed lockout time by the plan in effect, so a count no longer mixes your old plan with your new one.
  - **The HTML page** shows the split as a table on the Interruptions tab and as one lane per plan on the lockout chart.
  - **`nilometer explain by-plan`** lists the events behind each row.
- **Mid-task interruptions count again:** current Claude Code versions write context lines (token reminders, memory, hook output) between a request and the tool result or prompt it answered. A limit hit's position now looks past them, so most hits that showed as "position unknown" are now counted as mid-task or at the start of a turn. A line of a kind Nilometer hasn't classified stops the lookup and leaves the position unknown. `nilometer explain mid-task` says how many lines each lookup passed.
- **Claude Code's own resumption is shown:**
  - **What changes:** where Claude Code logged that it resumed a session by itself after a limit reset (an `auto-continuation` line), the report says so beside the lockout it followed. The page draws a ring at the end of that lockout's bar, and `nilometer explain lockout` lists the logged lines.
  - **What stays:** nothing is labeled automatic from timing alone.
- **"Open" means not yet reset:** a usage window counts as open only until its reset time, as of when you run the report. Before, a window stayed "open" if no status line reading had come in since its reset, for example after a stretch of work in the VS Code extension, and burn rate kept projecting it. A note under the table says an open window's usage is as of its last reading.
- **No more 0-second lockouts from late readings:** a limit seen only in the status line is now counted only from readings taken before the window's reset. Before, a reading that arrived after the reset could add a lockout of 0 s.
- **Unattributed usage is no longer reported:** the section that looked for usage outside Claude Code (a rise between status line readings with no Claude Code request in between) was zero in every window of a month of real use. Each reading follows a request in its own session, so it can't see that usage separately. `nilometer explain unattributed` still lists it.
- **Refused requests are recorded:**
  - **What changes:** when Claude Code logs that one model refused a request and another model retried it, that line is now its own event, keeping both models and the refused request's id, and `ingest` counts it. Before, it was filed with the lines Nilometer ignores.
  - **What doesn't:** the refused request leaves no token count in the log, so nothing is added to tokens or cost.
  - **When it takes effect:** the next `ingest` re-reads stored lines once to apply this.
- **A missing status line hook is reported:** when your status line names a Nilometer hook file that doesn't exist, for example after moving to a new machine, `report` warns above the numbers and on the page, and says to run `nilometer init`. Until then no usage readings are recorded, and nothing else shows it: the hook can't log an error if it never starts. `report` reads `settings.json` and never writes it.
- **`report --save --html --open`:** opens the saved page in your browser. If it can't, for example over SSH, it says where the page is and the command still succeeds.
- **`verify` names UTC days:** its days are UTC dates, as ccusage counts them. The output now says so, so in the evening the newest day no longer reads as "today" when it's tomorrow's local date.
- **Readings that change between requests are dated correctly:** newer Claude Code versions sometimes update an idle session's status line with the account's later usage. Such a value used to be dated back to that session's last request, which could draw a late-week number days early on the chart, and it replaced the request's own value. It's now its own reading, dated when it was captured.
- **Weekly windows at 75% and 90%:** the report and the page now list, for each weekly window, the first reading at or above 75% and 90%, and how long was left before the reset. A week that came close to the limit without hitting it used to show no interruptions and nothing else. `nilometer explain crossings` lists the readings.
- **Stale readings set aside:** about 1% of status line readings come in lower than an earlier reading in the same window, which can't be true, since usage within a window only rises. Such a reading could become a window's "last observed usage" (a window locked at 100% showed 73%), and it made the usage lines dip. It's now marked stale: counted under the windows table, listed in `nilometer explain headroom`, drawn as a hollow point off the line, and never used as the last observed value.
- **Lockouts first:** the interruptions section now leads with lockouts, and each says how many requests it refused and from how many sessions, for example "13 refused requests in 3 sessions". Before, those 13 read as "13 hits", which looked like 13 separate limits. The total reads "Limit hits: 35 in 8 lockouts".
- **Page layout fixes:**
  - Lockout labels no longer run off the chart; where they don't fit beside the bars, they go under them.
  - A time axis uses one style ("1 h 30 m", never "90 m" beside "2 h").
  - A window with a lockout gets a plain marker instead of a number too small to read.
  - Number columns line up under their headers, and tables scroll in their box on a narrow screen instead of stacking their text.
  - The Overview's small charts are clean pictures without unreadable text.
  - Labels no longer repeat, and lines that only say "0" are left off the page; the text report keeps them.
  - The repository chart names the top 20 instead of 10.
  - The first section is now "Where the numbers come from", with a sentence on why usage percentages start later than the session logs.
- **Less text on the page:** each section's explanations now sit behind a small "i" beside its heading, which opens on hover, keyboard focus or a tap, opens along the bottom on a narrow screen, and prints in full. Caveats that change what a number means stay beside it. The page's visible paragraph text is about 30% shorter.
- **Repository aliases:** `nilometer alias set <old-path> <new-path>` counts a renamed or moved project's old path under its new one, so it shows as one repository. The report lists each alias you entered under the repository table, and `nilometer explain by-repo` marks each request an alias moved. `alias list` and `alias remove` show and undo them.
- **Install guide:** [`docs/requirements.md`](docs/requirements.md) explains how to check for and install everything Nilometer needs, including how to get Node.js 24 and not a newer release.
