# Nilometer

**See what your Claude subscription is actually costing you: in interruptions when it's too small, in unused capacity when it's too big.**

*Named after the ancient Egyptian nilometers: columns that recorded how high the Nile actually rose each year, a record of what happened that was then used to judge what it cost.*

---

## What this is

A local tool that reads Claude Code's subscription telemetry and session logs. It reports how often usage limits interrupt your work, how much of each usage window you actually use, where your tokens go (by repository and by model), and what those tokens would cost at API list price.

Every observed number comes from an event that actually happened. Estimates are allowed only when derived from those observations, and they are always labeled. The tool does not tell you which plan to buy, and it does not score your productivity.

Nilometer is an independent tool for Claude Code. It isn't made, endorsed, or supported by Anthropic.

## Why

Claude subscriptions come in tiers, and you can pick wrong in either direction.

- **Too small:** long Claude Code sessions hit the usage limit, and work stops until the window resets.
- **Too big:** you pay every month for capacity you never touch.

People usually make this decision on vibes, because nothing shows how much interruption they're absorbing or how much headroom they're paying for.

This tool doesn't answer *"which plan should I be on?"* It shows the observed cost of your current plan in both directions and lets you judge it yourself.

---

## Measurement Principles

These limit what the tool is allowed to display. If a proposed metric breaks them, it gets reworked, labeled as a projection, or dropped.

1. **Every metric states exactly what was observed, and nothing more.** Elapsed lockout time is elapsed lockout time, not "time lost." What you did during the lockout is unknown, so the tool does not claim to know it.
2. **Observations and projections are visually and structurally separate.** Projections are allowed, but they must be derived from observations, labeled as estimates, and kept out of the headline.
3. **No counterfactuals.** The tool will not report what would have happened under a different plan, session structure, or prompting style. *Repricing is not a counterfactual:* showing your observed tokens at API list price keeps the usage fixed and changes only the price, so it's allowed as a labeled projection. Claiming you *would have spent* that amount on the API is not allowed, because paying per token changes how people work.
4. **Every number is traceable.** Any metric can show the underlying events it was computed from (in the CLI: `nilometer explain <metric>`).
5. **Every metric shows its date range.** Data sources start at different dates (see [History](#history)), so each number states the time span it covers.

---

## How it works

Two local sources feed one SQLite database.

### 1. Status line payload (subscription state)

Claude Code runs a status line script after every assistant turn and passes it a JSON payload on stdin. For Claude.ai Pro/Max subscribers, that payload includes a `rate_limits` object:

```json
{ "session_id": "abc123...",
  "transcript_path": "/path/to/transcript.jsonl",
  "rate_limits": {
    "five_hour":  { "used_percentage": 42, "resets_at": 1774036800 },
    "seven_day":  { "used_percentage": 86, "resets_at": 1774580400 } } }
```

This is exact, first-party subscription state: no scraping of output, no estimating tokens, no reverse-engineered limits. **Claude Code runs the script itself, so there is no daemon and no background process to keep alive.** The status line script is the collector.

Things about the payload that matter here:

- **`session_id` and `transcript_path`** point each rate-limit reading at the matching session log, so readings don't have to be matched to sessions by timestamp.
- **A window disappears once its `resets_at` passes.** A missing window means "reset," not "no data."
- **The numbers are from the session's last API response.** *Observed (2026-09-14/15):* re-rendering the status line (a refresh timer, a window reset) repeats them unchanged until that session makes another request, even while other sessions use the account. Nilometer dates each reading by that response, not by when it was captured, and counts repeats once ([D-044](decisions.md)). A terminal left open on a refresh timer therefore can't record usage from the VS Code extension.
- **`used_percentage` arrives in whole-number steps** (sometimes with float noise, e.g. `7.000000000000001`), so small amounts of usage show as 0%.
- **`rate_limits` only appears after the first API response in a session.**
- **The payload also carries `cost.total_cost_usd`**, Claude Code's own list-price estimate for the session. It's stored with each reading as a possible cross-check on the tool's cost math, never as a source. No check uses it yet.
- **A third window, `spend_limit`,** only appears for organizations behind a Claude apps gateway with spend limits. It's ignored for personal subscriptions.

### 2. Session logs (tokens, model, attribution)

Claude Code writes one JSONL file per session under `~/.claude/projects/`. For each request, the log records:

- **Request details:** the model and a `requestId`.
- **Full token breakdown:** input, output, cache writes (5-minute and 1-hour), and cache reads.
- **Context:** working directory, git branch, and timestamp.

The payload carries none of this.

When a usage limit stops a turn, Claude Code also writes a synthetic log line with `error: "rate_limit"`. That makes limit hits observable in logs written before this tool was installed.

Two ingestion rules:

- **Deduplicate by session and message ID** ([D-001](decisions.md)). One API response is written as several cumulative log lines. Summing them overcounts tokens, and keeping the first undercounts; the largest record wins.
- **Copy logs before Claude Code deletes them.** Logs are deleted after 30 days by default. The database is the long-term record; the logs are not.

```
Claude Code ──(stdin JSON, every turn)──▶ statusline script ──▶ SQLite ◀── pricing table
     │                                                            ▲         (dated, per model)
     └──(session logs on disk)──▶ ingestion (backfill at init) ───┘
                                                                  │
                                                       viewer (on demand)
```

**Chaining, not clobbering.** Many developers already run a custom status line. `init` detects an existing `statusLine` entry, wraps it, passes its output through unchanged, and logs the payload on the side. The tool is a passive tap on a hook you were already running. If you don't have one, you get a minimal default.

### History

`init` backfills from every session log still on disk. Token, model, repository, and cost metrics start as far back as those logs go; Claude Code keeps 30 days by default. So do interruption metrics, from the logged limit-hit lines ([D-004](decisions.md)). Elapsed lockout time is backfilled only where the logged reset time can be parsed.

Usage percentages exist only from the moment the collector is installed, and only from Claude Code sessions in a terminal ([D-029](decisions.md)). Claude Code doesn't write them anywhere else, so they can't be backfilled. Headroom, peak usage, unattributed usage, and burn rate start at `init`. Principle 5 keeps those differing start dates visible.

---

## MVP scope

One screen. No daemon, no desktop app, no live updating. Every metric below is retrospective.

### Observed: "Is my plan too small?"

| Metric | Source |
|---|---|
| Rate-limit interruptions | Logged `error: "rate_limit"` lines; `used_percentage` reaching 100 after `init`. A hit seen in both counts once ([D-023](decisions.md)) |
| Mid-task interruptions | The stopped request was answering a tool result, so the model was mid-agentic-loop rather than at a turn boundary. Hits whose position can't be determined are counted separately ([D-021](decisions.md)) |
| Elapsed lockout time | Limit hit → reset time, with overlapping hits counted once. **Not** a claim about lost productivity. Shown beside it: reset → next Claude Code request ([D-023](decisions.md)) |
| Sessions not resumed | No further request in the session after a limit was hit. May be abandonment; may be a deliberate stop. Reported without interpretation; sessions whose reset came after the logs end are counted separately ([D-022](decisions.md)) |

### Observed: "Am I paying for more than I use?"

| Metric | Source |
|---|---|
| Window headroom | Last observed `used_percentage` before each window's `resets_at`, shown with the time of that reading. Budget used after the last Claude Code turn isn't seen, so this is a lower bound ([D-024](decisions.md)) |
| Peak usage per window | Highest observed `used_percentage` in each 5-hour and 7-day window ([D-024](decisions.md)) |

### Observed: "Where does it go?"

| Metric | Source |
|---|---|
| Usage by repository | Session logs, grouped by git repository: worktrees and subfolders count as their repository, and a folder that no longer exists keeps its last known repository ([D-010](decisions.md), [D-028](decisions.md)) |
| Usage by model | Session logs, grouped by model (e.g. Opus vs. Sonnet), by token type |
| **Unattributed usage** | Budget consumed while Claude Code made no requests, i.e. from the web app, mobile, or Claude Design: rises between status line readings with no Claude Code request in between, a lower bound. The share is observable; its contents are not ([D-025](decisions.md)). **Under review:** a fresh reading always follows a Claude Code request, so status line data alone rarely, if ever, shows such a rise ([D-044](decisions.md)) |

### Projected (labeled as such)

- **Burn rate** → estimated time until the current window's limit is reached, at the window's average rate since it began. The premise, that the window started at 0% and the rate continues, is shown beside the number ([D-026](decisions.md)).
- **API-equivalent cost** → your observed tokens priced at Anthropic API list price, compared against what the plan cost you over the same period.
  - **How each request is priced:** per model and per token type (input, output, 5-minute and 1-hour cache writes, cache reads), at the price in effect *on that request's date*. The pricing table is dated because prices change.
  - **Display label:** *"Your observed tokens at API list price."* Never *"what you would have spent on the API"* (principle 3).
  - **Scope:** covers Claude Code usage only. Web, mobile, and Claude Design usage produces no token records.
  - **Currency:** USD, Anthropic's billing currency. Plan price is entered as the plan's USD list price, not a local-currency charge, so both sides of the comparison use the same currency.
  - **Period:** calendar months in the machine's timezone. The plan price is entered with `plan-price set <YYYY-MM> <usd> --name <plan>` and applies from that month on ([D-027](decisions.md)).

### Explicitly out of scope

Auto-resume (now built into Claude Code) · multi-assistant support · prompt-quality or "efficiency" scoring · flow-interruption metrics · plugin architecture · cloud sync · recommendations engine

---

## What this cannot see

`rate_limits` is account-wide, so usage from the Claude web app, mobile app, and Claude Design shows up in the totals. But those surfaces leave nothing on disk to read.

So the tool can report *that* budget was spent elsewhere, and how much. It cannot report *what* it was spent on, and it cannot price it. Any breakdown or cost of non-CLI usage would break principle 1.

The same goes for Claude Code on your other computers. Their session logs stay on those machines, so their tokens and limit hits aren't read here. Their share of the account-wide percentages shows up as unattributed usage.

Rate-limit state is only sampled when Claude Code runs a turn. Between turns, the tool is blind. This is why headroom is a lower bound.

The status line only runs when Claude Code runs in a terminal. *Observed (2026-09-13):* the VS Code extension doesn't run it, so turns made there leave no usage-percentage readings. Their tokens, costs, and limit hits are still read from the session logs. Headroom, peak, unattributed usage, and burn rate cover terminal sessions only ([D-029](decisions.md)).

---

## Auto-resume

Built into Claude Code since v2.1.234 (August 2026). Claude Code continues automatically when a session limit resets. It's on by default and set in `/config`, and the Desktop app has its own checkbox. This tool doesn't do auto-resume and doesn't need to.

It does change what two metrics mean. A session that continues right after a reset may have been resumed automatically, not by you. **Sessions not resumed** and **elapsed lockout time** therefore report *activity*, not whether you personally came back. As of 2026-09-13, no automatic continuation has been observed in the logs, so the tool reports resumption without attributing it. It shows the `origin.kind` field of the next prompt as written ([D-022](decisions.md)).

---

## Tech stack

- TypeScript on Node.js 24 LTS ([D-015](decisions.md))
- SQLite via `better-sqlite3` ([D-014](decisions.md))
- Tests, lint, and docstring rules run by one `npm run audit`, locally and in GitHub Actions ([D-016](decisions.md))

**Analysis logic lives in SQL, not in application code.** Views and queries do the work, not rows fetched and filtered in JS. This keeps the core portable if a Rust-backed desktop client ever happens (see below).

```
core/      schema (numbered SQL migrations), ingestion, pricing table, plan prices. No UI.
hooks/     status line collector script (POSIX sh).
viewer/    thin: formats the SQL views as the report, JSON, and explain output.
cli/       command wiring.
fixtures/  synthetic session logs with hand-computed expected results.
scripts/   audit runner, fixture generator, Python reference implementation, ccusage comparison.
tests/     unit, integration, and wording tests.
docs/      development standards, the audit, and the build history.
```

---

## Install and use

Install from a clone: Nilometer isn't published to npm yet. There's no GUI, installer, or auto-updater. Configuration was always the hard part, not packaging, and a desktop app writes to `settings.json` no better than a CLI does.

**Requirements:** Node.js 24 (the version in `.nvmrc`), git, and Claude Code signed in with a Pro or Max subscription. Running `npm run audit` also needs Python 3, gitleaks, and shellcheck.

On Node 24 before 24.15, `npm ci` prints `EBADENGINE` warnings for three lint plugins that ask for a newer Node. They're development dependencies, they don't affect Nilometer, and the install still succeeds.

- **macOS:** tested.
- **Linux:** the test suite passes in CI.
- **Windows:** tested with **Git for Windows** installed ([D-049](decisions.md)). Claude Code runs the status line through Git Bash when Git for Windows is present, so the shell hook works unchanged; without it, Claude Code uses PowerShell and the hook can't run. Run the commands below in Git Bash. On Windows the hook adds roughly 110 ms per reply at p95, against about 35 ms on macOS (2026-09-17).

```sh
git clone https://github.com/MVFarinas/Nilometer.git nilometer
cd nilometer
npm ci
npm run build
npm link          # optional: puts the `nilometer` command on your PATH
nilometer init    # or, without npm link: npm start -- init
```

`init` registers the status line hook in `~/.claude/settings.json`. If you already have a status line, it keeps running unchanged. It backs up the settings file, then backfills from every session log still on disk.

| Command | What it does |
|---|---|
| `nilometer init` | Install the hook (wrapping any existing status line), then backfill from session logs |
| `nilometer ingest` | Read new session log lines and status line readings into the database. `--full` rereads everything; `--json` prints the outcome as JSON |
| `nilometer report` | Print what was observed, then projections in a separate section. `--json` prints unrounded rows and every label. `--save` also writes a dated copy (`report_YYYY-MM-DD_HHMMSS.txt` and `.json`) to `~/.local/share/nilometer/reports/` |
| `nilometer explain <metric>` | List the events behind a number in the report, with the file, line, and byte each came from, and add them back up. Metrics: `limit-hits`, `mid-task`, `lockout`, `not-resumed`, `headroom`, `peak`, `unattributed`, `by-model`, `by-repo`, `burn-rate`, `api-list-price` |
| `nilometer plan-price set <YYYY-MM> <usd> --name <plan>` | Record your plan's USD list price per month from that month on, shown beside API list price. `plan-price list` shows what's entered |
| `nilometer uninstall` | Remove the hook and restore the status line setting it replaced. Recorded data is kept |

**Removing it:** `nilometer uninstall` restores your previous status line and keeps the recorded data. To delete the data too, remove the data directory below. It may hold session history that Claude Code has already deleted, so that history is then gone for good.

**Where data lives:**
- **Database and status line readings:** `~/.local/share/nilometer`. Override it with `NILOMETER_HOME` or `--data-dir`. Everything there is readable only by your account, since the database holds copies of your session logs ([D-043](decisions.md)). On Windows, file modes don't exist: the folder, under your user profile, relies on that profile's permissions instead ([D-049](decisions.md)).
- **Session logs:** read from `~/.claude`, or from every entry of `CLAUDE_CONFIG_DIR`.

### Privacy

- **Everything stays on your computer.** Nilometer reads Claude Code's session logs and status line payload, and copies them into a local SQLite database. It makes no network requests when it runs, and it sends no telemetry.
- **The database holds copies of your session logs:** prompts, code, and file paths. That's why the data directory is readable only by your account.
- **Reports contain spend figures and project names.** Think before sharing one. `nilometer explain` output also names session files and IDs.

### Keeping it current

Status line readings are recorded on every terminal turn, whether or not you ingest, so nothing is lost between runs. The one deadline is Claude Code deleting session logs after 30 days by default. **Ingest at least weekly,** or schedule it. With cron, every 6 hours:

```sh
crontab -e
# add, with your own paths:
0 */6 * * * <node 24 binary> <nilometer checkout>/dist/cli/main.cli.js ingest >/dev/null 2>&1
```

cron doesn't load your shell's Node version manager, so give the full path to a Node 24 binary. With fnm, that's `~/.local/share/fnm/node-versions/v24.<x>/installation/bin/node`, and it changes when you install a new Node 24 release. `nilometer` on your PATH may resolve to a different Node inside cron.

Run `nilometer ingest` before `nilometer report` to include the latest turns. Status line metrics start filling in once Claude Code has run a few turns **in a terminal** with the hook installed; the VS Code extension doesn't run the status line. Ingest at least every few weeks, since Claude Code deletes session logs after 30 days by default.

### Sample output

From the synthetic test fixture (`tests/unit/viewer/fixture.ts`), not real usage:

```text
Claude subscription usage
Times are in America/Chicago. Last ingest: 2026-09-12 19:00. Database: ~/.local/share/nilometer/usage.db

OBSERVED

Interruptions
  Covers: session logs 2026-08-20 10:00 to 2026-09-02 15:00 (America/Chicago); status line 2026-09-02 09:00–14:00 (America/Chicago)
  Rate-limit interruptions: 2
    5-hour window: 1 · weekly window: 1 · window unknown: 0
    From the session logs: 2 · seen only in the status line: 0
  Mid-task interruptions (the stopped request was answering a tool result): 1
    At the start of a turn: 1 · position unknown: 0
  Elapsed lockout time (limit hit to reset, overlapping hits counted once): 1 h 59 m across 1 lockout
    Hits with an unknown reset time, not included: 1
    2026-09-01 09:00 to 2026-09-01 11:00: 1 h 59 m, 1 hit; reset to next Claude Code request: 30 m 5 s
  Sessions with no further request after a limit hit: 1 of 2 sessions with a hit
    Reset came after the logs end: 0 · reset time unknown: 1
    A session that continued after its reset may have been resumed automatically; these counts are requests, not who made them.

Usage windows
  Covers: status line 2026-09-02 09:00–14:00 (America/Chicago). Readings start when the collector is installed.
  Window  Resets            Last observed usage  Reading at         Peak  Readings  Status
  ------  ----------------  -------------------  ----------------  -----  --------  ------
  weekly  2026-09-06 19:00                  15%  2026-09-02 14:00    15%         3  open
  5-hour  2026-09-02 17:00                  40%  2026-09-02 13:00    40%         1  open
  5-hour  2026-09-02 12:00                35.5%  2026-09-02 10:00  35.5%         2  reset
  Last observed usage is a lower bound: usage after the last Claude Code turn isn't seen.

…

PROJECTED: estimates derived from the observations above, not observations

Burn rate
  Covers: status line 2026-09-02 09:00–14:00 (America/Chicago)
  Premise: each window's usage started at 0% when it began, and its average rate since then continues.
  weekly window resetting 2026-09-06 19:00: 15% at 2026-09-02 14:00; projected 0.2 percentage points per hour; limit projected for 2026-09-18 09:40, after the reset.
  5-hour window resetting 2026-09-02 17:00: 40% at 2026-09-02 13:00; projected 40 percentage points per hour; limit projected for 2026-09-02 14:30, before the reset.

Observed tokens at API list price, by month
  Months in America/Chicago. Covers Claude Code only: web, mobile, and Claude Design usage leaves no token records.
  Month    At API list price  Plan price entered               Priced requests  Unpriced requests  Covers
  -------  -----------------  -------------------------------  ---------------  -----------------  ------------------------------------
  2026-08    less than $0.01  none entered                                   1                  0  2026-08-20 10:00 to 2026-08-20 10:00
  2026-09              $0.22  Example plan, $100.00 per month                2                  1  2026-09-01 09:00 to 2026-09-02 10:00
  Rates were read from Anthropic's pricing page on 2026-09-13; 3 requests dated before that are priced at those rates.
  Requests with cache writes of unrecorded duration, priced at the 5-minute rate (their cost is a lower bound): 1
  Unpriced requests have no verified rate and are left out of the amounts, not counted as $0.
```

---

## Prior art

Token and cost tracking for Claude Code is well covered. This tool exists for what those tools don't do.

| Tool | Covers |
|---|---|
| [ccusage](https://github.com/ccusage/ccusage) | API-equivalent cost from session logs by day, session, and 5-hour window; per-model and per-project breakdowns. Keeps no history of its own |
| [claude-usage](https://github.com/phuryn/claude-usage) | Local SQLite dashboard of tokens and API-equivalent cost by model and project |
| [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | Live burn rate, limit-hit detection, forecasts; optional history that outlives the 30-day cleanup |
| [claude-usage-tracker](https://github.com/jimdawdy-hub/claude-usage-tracker) | Plan-vs-API cost comparison; reads usage % from claude.ai via browser cookies |
| [claude-usage-tracker](https://github.com/haasonsaas/claude-usage-tracker) (haasonsaas) | Usage and cost tracking with plan limits estimated from hour ranges, model suggestions, and efficiency scores |

**What's different here:**

- **Interruption history:** lockout durations, mid-task interruptions, sessions not resumed.
- **Headroom:** how much of each window you actually use, as the downgrade signal.
- **Unattributed usage:** budget spent outside Claude Code.
- **The measurement principles:** observed and projected numbers kept separate, and every number traceable to its events.

ccusage is the reference implementation for cost math. This tool's numbers should match it, apart from documented differences such as dated prices ([D-011](decisions.md)).

What these tools got wrong is recorded in [`decisions.md`](decisions.md), so it isn't repeated here.

---

## Roadmap

Nothing here is a commitment to a date. Each item needs its own decision record and an audit before
it ships, and some of these will be answered with "no" — the scope stays retrospective, one screen,
no daemon.

**v1: the one screen.** Status line collector, session log ingestion with backfill, SQLite store,
repository and model attribution, the observed metrics, burn-rate and API-equivalent-cost
projections. *Built and audited 2026-09-13, and in daily use since.* Windows followed on 2026-09-17
([D-049](decisions.md)), and a security and privacy review on 2026-09-18 ([D-050](decisions.md)).

**Next:**

- **Logs and status line readings counted separately in the ingest summary.** "This run: 2 files"
  counts the spool of status line readings as one of the files, which reads as a miscount when you
  have a single session log.
- **Install without cloning.** Installing means cloning this repository today. Publishing to npm is
  planned, not scheduled; the data directory, database schema, and hook marker stay compatible
  either way, so an existing install keeps its history.
- **Repository aliases**, so a project that was renamed or moved counts as one instead of two.
  Nothing in the logs links an old path to a new one ([D-028](decisions.md)), so the alias has to
  come from you.
- **Linux beyond CI.** The test suite passes on Linux in CI, but nobody has yet run the hook on a
  Linux desktop for a week and compared the result.
- **A limit hit on another account.** Every interruption number — the count, the elapsed lockout
  time, the reset wording — was built from session logs and one subscription that has not hit a
  limit yet. What those metrics need next is evidence from a plan that hits limits regularly, not
  more code. If you run into limits and try this, the ingest summary counts and the report headings
  are the useful thing to share; the reports themselves are yours and stay local.

**Under review once v1 has a month of real use:**

- **Whether the unattributed-usage metric earns its place.** On real status line data it can't be
  nonzero, because every fresh reading follows a request in its own session
  ([D-044](decisions.md)). It may be relabeled, or dropped.
- **Time-of-day interruption patterns**, and **notifications** — both only if a month of real
  readings shows they'd answer something the one screen doesn't.
- **How the database grows** over a year of daily use, and whether it needs a size ceiling or
  pruning. Nothing is deleted today, on purpose: session logs Claude Code has since removed survive
  only in it.

**Considered and on hold (2026-09-13):** live usage in the status bar, a `watch` view, a tray app,
and multi-device sync. The scope stays retrospective until real use shows what to change
([D-031](decisions.md)).

**v2: Tauri, if and only if the tray icon justifies it.** The one feature a CLI genuinely cannot
offer is a menu-bar item showing live 5-hour usage. That, and nothing else, is the case for a
desktop client. With the schema settled and the queries already written in SQL, porting to
`rusqlite` is mechanical.

---

## License

[MIT](LICENSE). Why that one, and what was rejected: [D-053](decisions.md).

---

## Non-goals

This is not Grafana for Claude, and it is not a productivity score. It reports what happened. Conclusions about plans, workflows, and habits are yours to draw.

---

## Development

The standards every change meets, the audit that checks them (`npm run audit`), and the build history are in [`docs/development.md`](docs/development.md). Why things are built the way they are, with the options rejected, is in [`decisions.md`](decisions.md).
