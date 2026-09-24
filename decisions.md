# Decisions

**This file is an ADR log:** numbered, dated decisions, each with the options that were rejected. Entries are never edited to reverse them. A later entry supersedes an earlier one, in writing.

[`README.md`](README.md) remains the specification. Where a decision here changes something the README says, the entry's **Consequences** line names the change.

Most entries below come from studying five existing Claude usage tools (2026-09-12): [ccusage](https://github.com/ccusage/ccusage), [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor), [phuryn/claude-usage](https://github.com/phuryn/claude-usage), [jimdawdy-hub/claude-usage-tracker](https://github.com/jimdawdy-hub/claude-usage-tracker), and [haasonsaas/claude-usage-tracker](https://github.com/haasonsaas/claude-usage-tracker). References like `ccusage#888` are issue or PR numbers in those repos.

**Observations** in this file describe outside state that can change, such as a log format or a tool's behavior. Each carries an as-of date. Re-verify them before relying on them.

**Numbering:** D-032 to D-042 were reserved for decisions a plan for live usage display needed. That plan is on hold (D-031), so those numbers are unused. Entries are in the order they were written, which isn't always numeric.

---

## D-001: Dedup key is `(sessionId, message.id)`, and the largest record wins (2026-09-12)

- **Status:** accepted. Supersedes the "deduplicate by `requestId`" wording in the README and CLAUDE.md.
- **Context:** Claude Code writes one API response as several JSONL lines. The lines are cumulative streaming snapshots that share `message.id` and `requestId`; the last one carries the final `output_tokens`. *Observed on a real log set (2026-09-12):* 70% of response keys span multiple lines. With no dedup, output tokens came out 2.5× too high. Keeping the first line undercounted by 1.4%. Separately, `/btw` sidechain replays reuse a `message.id` under a new `requestId` (ccusage#913), and gateways reuse message IDs across sessions (ccusage#1635).
- **Options:**
  - (a) No dedup, as haasonsaas does. Rejected: 2.5× overcount.
  - (b) Key on `requestId` alone. Rejected: `/btw` replays get counted twice.
  - (c) Key on `message.id` alone, first insert wins, as phuryn and jimdawdy do. Rejected: it locks in a partial snapshot when a scan lands mid-stream (phuryn#86, Monitor#158).
  - (d) Last line read wins. Rejected: read order isn't write order once a session spans files.
  - (e) Key on `(sessionId, message.id)`, where the winner has the largest `output_tokens`, then the non-sidechain copy, then the latest line.
- **Decision:** (e).
  - When `message.id` is missing, fall back to `(sessionId, requestId)`.
  - When both are missing, the row is **unkeyed**: counted as-is, and reported in the ingest report. Never invent a key (haasonsaas used `Date.now()`).
  - The winner is chosen in a SQL view over the raw lines (D-002), not at insert time.
- **Consequences:**
  - The README's "How it works" and CLAUDE.md's ingestion rule are updated to this key.
  - Test fixtures must include streamed snapshots with different output counts, a `/btw` replay, a missing `message.id`, and a missing `requestId`.
  - *Observed (2026-09-12):* subagent transcripts under `<session>/subagents/` carry the parent's `sessionId` and `isSidechain: true`, so session scoping keeps them together.

## D-002: Store every raw line; derive everything else in views (2026-09-12)

- **Status:** accepted
- **Context:** Every studied tool keeps only parsed fields. A parsing mistake then stays in the data forever, and a format change can't be re-ingested. ccusage re-reads the logs on each run instead, but Claude Code deletes them after 30 days.
- **Options:**
  - (a) Keep parsed columns only, as phuryn and jimdawdy do.
  - (b) Upsert a winning row at insert time, as Monitor PR #237 does.
  - (c) Keep no store and re-read the logs each run, as ccusage does.
  - (d) An append-only `raw_lines` table holding the exact bytes, source path, byte offset, and content hash. Parsed columns and dedup winners are views, or tables rebuilt entirely from `raw_lines`.
- **Decision:** (d). A rebuild never deletes the database (phuryn#138 wiped a user's history this way). It drops and re-derives the tables built from `raw_lines`.
- **Consequences:**
  - The database is larger than the parsed data alone.
  - Re-runnability can be proven by fingerprinting the derived tables before and after a rebuild.
  - Lines unique on `(source_path, content_hash)` make a repeated ingest a no-op.

## D-003: Incremental ingest by byte offset of the last complete line (2026-09-12)

- **Status:** accepted
- **Context:** phuryn records a *line count* per file. A half-written last line fails to parse, still gets counted, and is then skipped forever once it's complete. That turn is lost with no trace. Full re-reads are simple but slow on multi-GB log directories (ccusage#821), and single files can exceed V8's max string length (ccusage#1151).
- **Options:**
  - (a) Re-read everything each run.
  - (b) Line count plus mtime, as phuryn does.
  - (c) Byte offset of the last `\n`, plus file size and inode.
- **Decision:** (c).
  - Read line by line from the stored offset. A trailing fragment with no newline is left for the next run.
  - If a file shrank or its inode changed, re-read it from byte 0; D-002 makes that safe.
  - A `--full` rescan exists for proving idempotency.
- **Consequences:** a file rewritten in place to the same size and inode goes unnoticed until a `--full` run. That's accepted.

## D-004: Limit hits come from structured log fields, not message text (2026-09-12)

- **Status:** accepted
- **Context:** The README assumed interruptions only exist from `init` onward, via `used_percentage` reaching 100. But Claude Code also writes a synthetic assistant line into the session log when a limit stops a turn. *Observed (2026-09-12, Claude Code 2.1.214):* the line has `model: "<synthetic>"`, `isApiErrorMessage: true`, `error: "rate_limit"`, `apiErrorStatus: 429`, zero usage, and text like "You've hit your session limit · resets 6:10am (<timezone>)". Monitor matches the older wording "5-hour limit reached" and substrings like "rate"/"limit", which misses the current wording and misclassifies other messages (Monitor#151). The same log set had ten other `<synthetic>` error lines (overloaded, network, sleep), all with `error: "server_error"`.
- **Options:**
  - (a) Status line `used_percentage >= 100` only. This delays the metric until `init`.
  - (b) Substring match on message text, as Monitor does.
  - (c) The structured `error == "rate_limit"` field as the event, with `used_percentage >= 100` as a second source from `init` on.
- **Decision:** (c).
  - **Window type and reset time** (5-hour vs weekly, "resets 6:10am") exist only in the text. They are parsed best-effort. A line whose text doesn't parse still counts as a limit hit, with window and reset recorded as **unknown**.
  - **Other `<synthetic>` lines** are kept as events but aren't API requests. They are excluded from token sums and from the "Claude Code made a request" signal used by unattributed usage.
- **Consequences:**
  - Rate-limit interruptions, mid-task interruptions, and sessions not resumed can be backfilled from existing logs. Elapsed lockout time is backfillable only where the reset time parsed.
  - The README's History section and interruptions row are updated.
  - Headroom, peak usage, and unattributed usage still start at `init`.
  - The `error` field's values are an observation. Fixtures pin them, and an unrecognized `error` value goes to the ingest report.

## D-005: Pricing is a dated, hand-verified table in the repo; unknown models are unpriced (2026-09-12)

- **Status:** accepted
- **Context:** Every studied tool has been mispriced in public.
  - **Wrong or stale rates:** Opus at 3× the current rate (jimdawdy 2497b8c, Monitor#182, Monitor#241).
  - **Fuzzy matching:** 5× overcharges (ccusage#934). A new model priced as its family's previous one (phuryn#175).
  - **Cache writes:** 1h writes priced as 5m (phuryn#162 measured a 49% undercount of cache-write cost).
  - **Unpriced models:** silently shown as $0 (haasonsaas, phuryn#21).
  - **No history:** none of them has effective-dated Claude prices. ccusage fetches LiteLLM's current rates, so old requests get today's prices.
- **Options:**
  - (a) Fetch LiteLLM at runtime, as ccusage does. Not re-runnable, no dates.
  - (b) Embed a LiteLLM snapshot. No history.
  - (c) Hardcoded dicts, as phuryn does. They drifted across four copies.
  - (d) One table re-priced retroactively on each version bump, as jimdawdy does. Breaks "price at the rate in effect on the request's date".
  - (e) A committed table of rows keyed by `(model_id, effective_from)`. Each row has an explicit rate per token type, a source URL, and a `verified_on` date.
- **Decision:** (e).
  - **Token types:** input, output, 5-minute cache write, 1-hour cache write, and cache read are separate columns, not derived from multipliers.
  - **Models:** matched on the exact model ID only.
  - **Unknown models:** a request with no matching row is **unpriced**. It is excluded from cost totals, and the output shows the unpriced token count. It is never $0 and never a family fallback.
  - **Premium pricing:** long-context and `usage.speed == "fast"` pricing are applied only when a verified row defines them.
- **Consequences:**
  - Adding a model is a manual, sourced step (see the `pricing-table` skill).
  - Our historical costs will differ from ccusage wherever prices changed, which is expected. Verification (D-011) compares within a single price period.

## D-006: Cost is computed at query time, never stored at ingest (2026-09-12)

- **Status:** accepted
- **Context:** jimdawdy's sync agent stored costs computed with stale prices, and the one-time repricing never reached them. phuryn computes cost in browser JS, apart from its SQL.
- **Options:**
  - (a) Store a cost column at ingest.
  - (b) A SQL view joining deduplicated requests to the price row in effect on each request's timestamp.
- **Decision:** (b). Correcting a price row corrects every number that depends on it.
- **Consequences:** all cost logic lives in one view, which the verification suite tests directly.

## D-007: Model and time are per request, never per session (2026-09-12)

- **Status:** accepted
- **Context:** jimdawdy and phuryn label each session with one model (its most frequent, or its first) and bucket the whole session at its start time. Mixed-model sessions are then misattributed (phuryn#160, #165, #173), and sessions spanning midnight or a month boundary land in the wrong bucket. Timezone handling broke in every tool: UTC days compared against local bounds (phuryn#151), local days beside UTC hours (haasonsaas), and invalid timezones silently falling back (ccusage).
- **Options:**
  - (a) Session-level labels.
  - (b) Per-request model and timestamp. Timestamps are stored in UTC and bucketed in SQL with the machine's local timezone, whose name is printed in the output.
- **Decision:** (b). A timestamp that doesn't parse is stored raw and reported, never dropped (ccusage drops non-standard lengths).
- **Consequences:** SQLite's `localtime` only knows the machine's zone. Choosing a different display zone needs an ADR.

## D-008: The status line hook appends to a spool file and never fails (2026-09-12)

- **Status:** accepted
- **Context:** Monitor overwrites one `latest.json`, so it has no history. It writes `null` over good data when `rate_limits` is absent, and discards `session_id`, `transcript_path`, and `cost`. Its hook also replaces the user's status line; installation is manual, with no backup and no wrapping. Payload quirks it has hit:
  - `used_percentage` sometimes carries the `resets_at` epoch (Claude Code bug #52326, per Monitor)
  - NaN/Infinity values
  - a stale capture displayed as current

  The hook runs on every turn, possibly in several sessions at once.
- **Options:**
  - (a) Overwrite a latest-state file, as Monitor does.
  - (b) Write to SQLite directly from the hook. That contends for locks across concurrent sessions, and a hook failure would break the status line.
  - (c) Append one line per payload to a spool JSONL file, and ingest the spool into SQLite with the logs.
- **Decision:** (c).
  - **Line contents:** the full raw payload plus a capture timestamp.
  - **Order of work:** pass through the wrapped command's output first, then append.
  - **Errors:** catch everything and exit 0.
  - **Validation happens at ingest.** Out-of-range or non-finite values are stored raw and flagged invalid, not clamped. Monitor clamps values up to 101 down to 100.
- **Consequences:**
  - Status line readings reach the database at the next ingest, not instantly. The README has no live updating, so this costs nothing.
  - The spool is append-only; ingest records its byte offset like any log (D-003).

## D-009: Subscription state comes only from the status line payload (2026-09-12)

- **Status:** accepted
- **Context:** Other tools get limits without the payload, and each method fails the Measurement Principles.
  - **Plan presets and P90 estimates** (Monitor): circular, since a block counts as a "hit" at 95% of any preset. Advertised as "95% accuracy", but that's just the threshold constant. Users saw 50% where Claude showed 98% (Monitor#212).
  - **Invented hours-per-week limits** (haasonsaas).
  - **A token-based estimate** that showed 100% against a real 58% (phuryn#149).
  - **Browser-cookie extraction** with TLS impersonation to call claude.ai's internal usage endpoint (jimdawdy).
  - **The OAuth usage endpoint** (phuryn PR #149).
- **Options:**
  - (a) Infer limits from tokens.
  - (b) Read the undocumented claude.ai or OAuth usage endpoints.
  - (c) Status line payload only.
- **Decision:** (c).
  - (a) produces guesses presented as observations, breaking principles 1 and 2.
  - (b) reads credentials, depends on an undocumented API, and needs the network.
- **Consequences:**
  - No headroom or percentage metrics before `init`.
  - We don't get what the claude.ai endpoint exposes and the payload doesn't. *Observed via jimdawdy's parser (2026-09-12):* per-model weekly windows (`seven_day_opus`, `seven_day_sonnet`) and extra-usage credits. That loss is accepted.

## D-010: Repository attribution uses `cwd` resolved through git (2026-09-12)

- **Status:** accepted (records the options behind the existing CLAUDE.md rule)
- **Context:**
  - ccusage decodes the project directory name, which is lossy and treats worktrees as separate projects.
  - phuryn and jimdawdy take the last two path segments of `cwd`.
  - haasonsaas hardcodes its author's home path.
  - phuryn has two open PRs just to fold worktrees back into their repo (#154, #179).
- **Options:**
  - (a) Encoded directory name.
  - (b) Path segments.
  - (c) Per-line `cwd` → `git -C <cwd> rev-parse --git-common-dir`, cached per distinct `cwd`, with a path fallback labeled "not a git repo" or "path no longer exists".
- **Decision:** (c). Attribution is per request, since `cwd` can change within a session.
- **Consequences:** ingest shells out to git once per distinct `cwd`, not once per line.

## D-011: Verify cost math against pinned ccusage on synthetic fixtures (2026-09-12)

- **Status:** accepted
- **Context:** The README names ccusage as the reference implementation. But ccusage has known divergences from Anthropic billing: it prices each token type above 200K separately, lacks `fallback_message` iterations (ccusage#1552), and has no dated prices. Its production CLI was rewritten in Rust (ccusage PR #977). The last TypeScript loader is at commit `a2ca34a5^`, in `apps/ccusage/src/adapter/claude/data-loader.ts`.
- **Options:**
  - (a) Match ccusage exactly, including its errors.
  - (b) Compare against ccusage within a single price period on synthetic fixtures, pinned and offline, with every known divergence listed as an expected delta.
- **Decision:** (b). Command shape, run against a fixture directory and never real logs:
  `CLAUDE_CONFIG_DIR=<fixtures> npx ccusage@20.0.20 claude daily --json --mode calculate --offline -z UTC --breakdown`
- **Consequences:** a mismatch means one of three things: a bug in our code, a new entry in the known-deltas list, or an ADR. It never means silently adjusting our numbers to match.

## D-012: No savings, verdicts, recommendations, or scores, even derived from real data (2026-09-12)

- **Status:** accepted
- **Context:** Features found in the studied tools:
  - **jimdawdy:** "Plan Savings", "API cheaper by", "Saving $X/mo", with the sign inverted between views (commit effabfe).
  - **haasonsaas:** "switch 30% of Opus to save", `efficiencyScore`, `successScore`, a model advisor, and budget alerts.
  - **Monitor:** a plan recommendation computed from session reconstruction that doesn't respect the 5-hour cap.

  All of them are counterfactuals or judgments.
- **Options:**
  - (a) Offer them clearly labeled.
  - (b) Don't build them. Show plan price and "observed tokens at API list price" side by side, and let the reader subtract.
- **Decision:** (b). Principle 3, and the README's non-goals.
- **Consequences:** the banned-phrase test (CLAUDE.md) adds *savings*, *cheaper by*, *verdict*, *recommend*, and *score* to its list.

## D-013: The project is named Nilometer (2026-09-13)

- **Status:** accepted. Resolves the open naming entry that step P7.3 was waiting on.
- **Context:** the name becomes the npm package, the command, the data directory, the environment variable, and the hook's ownership marker. Until now code and docs used the working name `ai-usage-analyzer`. The name shouldn't contain "Claude": the tool is third-party and may be published. It also shouldn't imply a judgment ("planfit", "saver"), which D-012 rules out for the output.
- **Options** (npm availability checked 2026-09-13):
  - (a) **Tidemark:** the line where water reached. Available, and the clearest.
  - (b) **Highwater:** a familiar image, but `highwater` is taken on npm.
  - (c) **Polevault:** a bar as the limit. It frames going over the limit as the goal, which leans toward judgment.
  - (d) **Meterline, Quotalog, Tapmeter:** descriptive, but without the vertical-marker image.
  - (e) **Nilometer:** ancient Egyptian columns that recorded the Nile's height each year, which was used to set that year's taxes. It records how high the level actually rose and uses the record to judge a cost, which is close to what this tool does.
- **Decision:** (e), chosen by the maintainer.
- **Consequences:**
  - **Package and command:** `nilometer`; `npm link` installs the command from a clone.
  - **Data directory:** `~/.local/share/nilometer`, overridden by `NILOMETER_HOME`. The cache is `~/.cache/nilometer`.
  - **Hook marker:** `# nilometer-hook`. No compatibility code reads the old marker or directory: the only install, on the maintainer's machine, was uninstalled with the old code, its data directory moved, and the hook installed again.
  - **Repository:** renamed to `Nilometer` by the maintainer the same day.

## D-014: SQLite library is `better-sqlite3` (2026-09-12)

- **Status:** accepted
- **Context:** The analysis lives in `.sql` files, so the Node database layer is thin: open, run migrations, prepare, iterate. The status line hook never touches the database (D-008), so library load time doesn't matter per turn.
- **Options:**
  - (a) `better-sqlite3`: mature, synchronous, prebuilt native binaries.
  - (b) Built-in `node:sqlite`: no dependency. On Node 22.11 it needs `--experimental-sqlite` and prints a warning (observed 2026-09-12). It's unflagged from Node 22.13/23.4, but only reached release candidate in Node 25.7 (as of 2026-09-12, per Node docs), so its API may still change.
  - (c) `sql.js` (WASM): no native build, but an in-memory database that must be written back to disk by hand.
- **Decision:** (a).
- **Consequences:**
  - One native dependency. Installs depend on a prebuilt binary for the platform, or a working build toolchain.
  - Revisit (b) once `node:sqlite` is stable on the pinned Node version (D-015). Because of the thin layer, switching touches only `core/db/`.

## D-015: Pin Node.js 24 LTS (2026-09-12)

- **Status:** accepted
- **Context:** The dev machine has Node 22.11 (observed 2026-09-12). Node 22 is maintenance LTS, ending April 2027, which is inside this project's likely lifetime. Node 24 is the Active LTS. Node 26 is Current and becomes LTS in October 2026.
- **Options:**
  - (a) Stay on 22: no install, but a forced upgrade mid-project.
  - (b) 24 LTS.
  - (c) 26: newest, but not yet LTS.
- **Decision:** (b). Pinned in `.nvmrc` and in `package.json` `engines` as `>=24 <25`.
- **Consequences:**
  - Install Node 24 before P0.2.
  - CI uses the same major (D-016).
  - The hook-latency spike (P0.3a) is measured on Node 24, not 22.

## D-016: Tooling and CI (2026-09-12)

- **Status:** accepted
- **Context:** The Standards (docs/development.md) require docstrings on every function, 100% function coverage, formatting, and an `npm run audit` that runs every check.
- **Options:**
  - **Tests:** vitest or `node:test`.
  - **CLI:** commander or `node:util` `parseArgs`.
  - **CI:** local only, or GitHub Actions plus local.
- **Decision:**
  - TypeScript strict.
  - vitest with `@vitest/coverage-v8` (thresholds built in).
  - eslint with typescript-eslint and eslint-plugin-jsdoc (enforces the docstring rules).
  - prettier.
  - commander for the CLI; the hook entry point imports none of these.
  - `tsx` for development.
  - **GitHub Actions runs `npm run audit` on every push**, in addition to local runs.
- **Consequences:**
  - The workflow is required in P0.2 (no longer optional), and its Node version comes from `.nvmrc`.
  - CI minutes are limited, so the audit must stay fast. If it grows past a few minutes, split slow suites into a nightly job via an ADR.
  - CI never has real session logs, so real-log checks stay local (docs/development.md § Testing).

## D-017: The independent reference implementation is Python standard library (2026-09-12)

- **Status:** accepted
- **Context:** The fidelity suite (`verify-against-ccusage` skill) needs a second implementation of the D-001 and D-004 rules that can't share code or mistakes with the TypeScript loader.
- **Options:**
  - (a) TypeScript in a separate folder, kept independent by a lint rule banning imports from `core/`.
  - (b) Python 3 standard library.
- **Decision:** (b). A different language makes accidental reuse impossible rather than merely forbidden, and needs no dependencies.
- **Consequences:**
  - CI installs Python 3.
  - A rule change in `decisions.md` must be implemented twice, once in each language. The suite fails until both agree, which is the point.

## D-018: The status line hook is a POSIX shell script (2026-09-12)

- **Status:** accepted. Refines D-008, which is unchanged in intent: spool append, never fail, validate at ingest.
- **Context:** The hook runs after every assistant turn. Spike P0.3a timed it against a wrapped command that reads stdin and prints one ANSI line: 50 interleaved runs with a realistic 1 KB payload, Node 24.21.0, on the dev Mac (observed 2026-09-12). The pre-set gate was *use Node if it adds ≤ 100 ms at p95*.

  | Variant | Added p50 | Added p95 |
  |---|---|---|
  | Node, importing only `fs` and `child_process` | 107 ms | 118 ms |
  | Node, also importing commander and better-sqlite3 | 130 ms | 140 ms |
  | POSIX `sh`, payload via `$(cat)` | 24 ms | 25 ms |
  | POSIX `sh`, payload via temp file (exact bytes) | 38 ms | 39 ms |

  Separately, Claude Code may run the hook without the user's shell profile. A `node` resolved from PATH could then be a different version than the pinned one (docs/development.md P0.3). A shell hook has no Node dependency.
- **Options:**
  - (a) Node entry point. Fails the gate, and depends on which `node` is on PATH.
  - (b) Node with V8 compile cache or a startup snapshot. Rejected untested: the measured cost is process boot, not script compilation.
  - (c) `sh` with `$(cat)`. Command substitution strips trailing newlines, so the stored payload isn't byte-exact.
  - (d) `sh` with a temp file: `mktemp`, `cat >` it, run the wrapped command from it, and append `{"captured_at_s":<epoch s>,"hook_version":N,"payload_b64":"<base64>"}`.
- **Decision:** (d).
  - **Base64** avoids JSON escaping in shell and preserves any bytes. The spike verified exact round-trips for trailing newlines, invalid JSON, multi-line Unicode, empty input, and bytes 1–255.
  - **The wrapped command** runs as `sh -c "<command>"`, because `statusLine.command` is a shell string.
  - **The temp file** is removed by an `EXIT` trap.
- **Consequences:**
  - **Capture timestamps are whole seconds** (BSD `date` has no sub-second format). Within one second, order comes from spool line order.
  - **No coverage tooling for the hook.** It's tested black-box from vitest by spawning it, and linted with `shellcheck`, a new audit check added in P1.1.
  - **stderr must stay silent even when the spool path isn't writable.** The spike showed a redirection failure still writes to stderr, so P1.1 must redirect the whole append block.
  - **Concurrent appends:** a long line may interleave under concurrent sessions. Ingestion reports such lines as malformed (D-008, report-don't-fix) rather than repairing them.
  - **Testing P1.1:** the hook is tested with black-box shell cases instead of TypeScript unit tests.

## D-019: `system`/`api_error` lines are retry notices, a class of their own (2026-09-12)

- **Status:** accepted. Extends D-004's classification.
- **Context:** *Observed (2026-09-12, Claude Code 2.1.196–2.1.269):* 159 lines with `type: "system"`, `subtype: "api_error"`, `source: "request_retry"`, `retryAttempt`, `maxRetries`, `retryInMs`, and an `error` object with `message`, `formatted`, `connection`, `status`, `isNetworkDown`, and `rateLimits`. `rateLimits` was null in every observed line. These are Claude Code retrying a failed request, not a limit stopping a turn. D-004's classification would have filed them under `ignored_type`.
- **Options:**
  - (a) Leave them as `ignored_type`.
  - (b) Treat them as limit hits when `error.status` is 429.
  - (c) A `retry_notice` class, stored as events with their scalar fields, never counted as limit hits or requests.
- **Decision:** (c).
  - Retries are observable interruptions of a different kind; dropping them to "ignored" loses them.
  - Promoting a 429 retry to a limit hit would double-count the synthetic `rate_limit` line D-004 already uses.
  - A non-null `error.rateLimits` goes to the ingest report until its shape has been observed and an ADR decides how to use it.
- **Consequences:** the `ingest-session-logs` skill's classification table and fixture list gain the class.

## D-020: Price rows are verified snapshots; unverifiable history is labeled, not guessed (2026-09-13)

- **Status:** accepted. Refines D-005 and D-006.
- **Context:** Anthropic's pricing page (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-09-13) publishes today's per-type rates, fast mode rates for Opus 5 and 4.8, a 1.1× multiplier for US-only inference (`inference_geo: "us"`, Claude 4.6 and later), and "Claude 4.6 and later models … include the full 1M token context window at standard pricing". It publishes no price history except that Sonnet 5's launch price of $2/$10 became standard. The models overview gives no release dates. D-005 wants each request priced at the rate in effect on its date, but no page states the rate before 2026-09-13.
- **Options:**
  - (a) Price only requests on or after `verified_on`, leaving all history unpriced. Honest, but useless for the backfilled 30 days.
  - (b) Invent release dates or past prices from memory. Violates D-005's "sourced, never recalled".
  - (c) A first row per model with `effective_from` `0000-01-01`, meaning "in effect since release as far as can be verified", carrying `verified_on`. Cost output for requests dated before `verified_on` states that they were priced at a rate verified later.
- **Decision:** (c).
  - **Price file:** rows live in `core/pricing/prices.json` (committed and reviewable), synced into the `prices` table on every ingest, so a correction applies without a migration.
  - **A price change** adds a row with a real `effective_from`, taken from the announcement that states it.
  - **Priced request:** each deduplicated request is priced in SQL (the `request_costs` view) from its exact `model` and its UTC day.
  - **Unpriced request:** one with a reason: `unparsed_timestamp`, `no_price_row`, `fast_rate_unknown` (`speed: "fast"` on a model without published fast rates), `service_tier_not_standard` (priority tier rates aren't in the file), or `long_context_rate_unverified` (total input above a row's `standard_rate_max_input_tokens`, set only for pre-4.6 models, where the page doesn't state the rule).
  - **`inference_geo: "us"`** multiplies every token type by 1.1. Any other value is standard.
  - **Cache writes without the 5m/1h split** are priced at the 5-minute rate and flagged as a lower bound.
- **Consequences:**
  - Migration 007 adds `service_tier` and `inference_geo` to derived requests; parser version 3.
  - Viewer output (Phase 7) must show `verified_on` next to any cost that includes requests dated before it.
  - Only model IDs seen in logs or verifiable on the overview page get rows (as of 2026-09-13: Fable 5.1 and 5, Opus 5, 4.8, 4.7, 4.6, Sonnet 5 and 4.6, Haiku 4.5 by alias and dated ID). Anything else is reported as `no_price_row`. **Extended 2026-09-24:** every model on the pricing page now has a row, whether or not it has appeared in a log, so no one running a listed model sees `no_price_row` for it. Added that day: Opus 5.5, then Opus 4.5, 4.1 and 4, Sonnet 4.5 and 4, Haiku 3.5, and Mythos 5 and 5.1, by alias and dated ID where both exist. Haiku 3, Sonnet 3.7 and 3.5, and Opus 3 aren't on the page and stay unpriced.

## D-021: "Mid-task" is decided by what the stopped request was answering (2026-09-13)

- **Status:** accepted
- **Context:** The README counts mid-task interruptions: a limit that stopped the model inside an agentic loop rather than at a turn boundary. *Observed (2026-09-13, Claude Code 2.1.196–2.1.269):* every log line carries `uuid` and `parentUuid`. A synthetic error line's parent is the message the failed request was answering. Of the 11 `isApiErrorMessage` lines on disk, the one `rate_limit` line and 2 `server_error` lines had a parent `user` line whose content was a `tool_result` block. 7 had a parent prompt (text content). 1 had an assistant parent. User prompt lines carry `origin.kind` (`human`, `task-notification`, or `coordinator`); tool results carry no `origin`.
- **Options:**
  - (a) The previous line in the file ended in `tool_use`. Line order interleaves subagents and metadata lines, so the previous line is often unrelated.
  - (b) Time since the last prompt above a threshold. That's a guess with a tunable constant.
  - (c) The limit-hit line's parent, found by `parentUuid` in the same session. A parent `user` line whose content includes a `tool_result` block means the model was continuing its own loop.
- **Decision:** (c).
  - **`mid_task`:** the parent is a user line with a `tool_result` block.
  - **`turn_start`:** the parent is a user line without one that isn't `isMeta`.
  - **`unknown`:** everything else. That covers no `parentUuid`, a parent not on disk, a meta line, or a parent of another type. Unknown is shown as its own count, never folded into either side.
  - **Hits seen only in the status line** have no parent, so they're `unknown`.
- **Consequences:** `parsed_lines` gains `uuid`, `parent_uuid`, `origin_kind`, `user_content`, and `is_meta` (parser version 4).

## D-022: Resumption is reported as activity; auto-resume is not inferred (2026-09-13)

- **Status:** accepted, provisional. Revisit at the first limit hit logged after the hook is installed. **Re-inspected 2026-09-18** and unchanged: the only hit on record is still the 2.1.214 one described below, and the source log has since been deleted by Claude Code's 30-day cleanup, so it survives only because ingestion copies raw lines into the database. Inspecting it again needed no file. Structure, for the next reader: `type: "assistant"`, `isApiErrorMessage: true`, `error: "rate_limit"`, no `rate_limits` on the retry; the window reset 2.8 hours after the hit, and the session's next line came about seven hours after that reset, from a `user` line with `origin.kind: "human"` preceded by two `queue-operation` lines (classified `ignored_type`, not reported as unknown).
- **Context:** Claude Code resumes automatically after a reset since 2.1.234 (README, Auto-resume). The only logged limit hit on disk (2.1.214) predates that, so how an automatic continuation is logged hasn't been observed. The user line after that hit had `origin.kind: "human"`. Step P6.1 asked for this ADR after inspecting a post-install hit; that hit hasn't happened, and waiting would block the metric.
- **Options:**
  - (a) Wait for a post-install hit before building the metric.
  - (b) Guess a marker (a non-human `origin.kind`, a short gap after the reset) and label resumptions as automatic.
  - (c) Report the observed fields only: the next request in the session and the `origin.kind` of the next prompt line, as written. Nothing is labeled automatic.
- **Decision:** (c).
  - **The event view carries `origin.kind` as written.** The viewer prints it under its own name, not as "automatic" or "manual".
  - **"Sessions not resumed"** means no later request in that session. A hit whose reset time is after the end of log coverage is counted separately, because resumption wasn't possible yet.
- **Consequences:** when a post-install hit shows a structured marker, a new ADR may map it to a label. The metric's data doesn't change.

## D-023: Lockout is hit → reset, merged across hits; reset → next request is separate (2026-09-13)

- **Status:** accepted
- **Context:** The README defines elapsed lockout time as "`resets_at` → next observed activity". That span is the time between the reset and the user's return, not the time spent locked out. Both are observable, so both are reported under names that say what they measure.
  - **Several hits can share one lockout.** Retries while limited each write a limit-hit line, and a 5-hour lock can sit inside a weekly one, so summing per-hit spans overcounts.
  - **The reset time in the log is text:** "resets 6:10am (<zone>)", with an IANA zone name in the parentheses (D-004).
  - **The status line gives `resets_at` exactly,** from `init` on.
- **Options for the span:**
  - (a) Keep the README's `resets_at` → next activity as "lockout".
  - (b) Hit → reset as **elapsed lockout time**, and reset → next Claude Code request as a second observed column, **reset to next request**.
- **Options for merging:**
  - (a) Sum per-hit spans.
  - (b) Take the union of `[hit, reset]` intervals, so overlapping hits count once.
- **Decision:** (b) for the span and (b) for merging.
  - **Reset time from text:** a time of day with am/pm and an IANA zone in parentheses. It resolves to the first UTC minute at or after the hit's minute whose wall-clock time in that zone matches, searched up to 48 hours ahead. A DST-repeated time resolves to its first occurrence; a DST-skipped time resolves to the next day. Any other wording, or an unknown zone, leaves the reset unknown, and those hits are counted separately.
  - **Status line hits:** readings with a valid `used_percentage >= 100` group by `(window, resets_at)`, one hit per group, starting at the group's first reading.
  - **Merging hits:** a status line group and a logged hit are the same lockout when the logged hit's time is in `(resets_at − window length, resets_at]` and the windows match. A logged hit with an unknown window matches either. Merged hits keep the logged line and take `resets_at` from the payload, which is exact.
  - **Duplicate limit-hit lines:** copies of one line (same session and `uuid`) count once, keeping the first in source order.
- **Consequences:** the README's elapsed-lockout row is reworded to hit → reset, with reset → next request beside it.

## D-024: A window instance is `(window, resets_at)`; headroom is its last reading before the reset (2026-09-13)

- **Status:** accepted, provisional. Revisit with the first real spool data (P1.3 live check).
- **Context:** Headroom and peak usage are read per window: each 5-hour and 7-day period, from the first status line reading on (D-009). No real spool data exists yet, so how stable `resets_at` is across readings of one window hasn't been observed. The README calls headroom a lower bound, because usage after the last Claude Code turn isn't seen.
- **Options for identifying a window:**
  - (a) Exact `(window, resets_at)`.
  - (b) `resets_at` rounded to the minute or hour, which absorbs jitter nobody has seen.
  - (c) Consecutive readings until the percentage drops.
- **Options for which readings count:**
  - (a) All of them.
  - (b) Only those captured at or before `resets_at`. A reading after the reset belongs to no usable window and is counted apart.
- **Decision:** exact `(window, resets_at)`, and readings at or before the reset.
  - Rounding would merge windows on an unobserved assumption, and (c) breaks on the first out-of-order capture.
  - **Scope:** only `five_hour` and `seven_day` count, with `validity = 'valid'`.
  - **Headroom** is the last reading's `used_percentage` and its capture time. Ties go to the later line.
  - **Peak** is the highest reading, the earliest if tied.
  - **A window whose `resets_at` is after the last status line reading** is marked open. Its last reading isn't final yet.
  - **The views report percentages as written.** They don't subtract from 100, so the viewer states "last observed usage" rather than a computed amount left unused.
- **Consequences:** if real spool data shows `resets_at` jittering within one window, a new ADR supersedes the identity rule. The ingest report's invalid-window count still covers readings excluded for validity.
- *Observed (2026-09-13, first real spool, Claude Code 2.1.232 in a terminal, 50 readings over 15 minutes):*
  - **`resets_at` was stable within each window:** one value across 49 weekly readings, and two 5-hour values for a real rollover. The new 5-hour window reset exactly 5 hours after the previous reset, which matches D-026's window-start premise.
  - **The payload lags a reset.** For about 2 minutes after the 5-hour reset, 3 readings still carried the old window at its old percentage. Excluding readings captured after `resets_at` was needed.
  - **`used_percentage` was a whole number** in every reading, and the first reading of the session had no `rate_limits`, as the README describes.

## D-025: Unattributed usage counts increases between readings with no Claude Code request in between (2026-09-13)

- **Status:** accepted, provisional. The falsifier below runs on the first real spool data (the P1.3 live check, then weeks of real use).
- **Context:** `rate_limits` is account-wide, so the web app, mobile, and Claude Design consume the same budget. They leave nothing on disk. The status line is only captured when Claude Code runs, and how quickly a payload's percentage reflects the request just made isn't observed yet. Tokens can't be converted to percentage points without inferring limits (D-009).
- **Options:**
  - (a) Percentage change minus the Claude Code tokens in between, converted to percent. That infers limits; rejected by D-009.
  - (b) Every increase between consecutive readings of one window with **no logged Claude Code request** in between.
  - (c) Don't build it until spool data shows the payload's timing.
- **Decision:** (b), labeled a lower bound.
  - **Pairs:** consecutive valid readings of one window instance (D-024), ordered by capture time, then line.
  - **No request in between:** no deduplicated request timestamp in `[previous capture, capture + 1 s)`. Captures are whole seconds, so the interval is widened at the end, and it includes the previous capture's second. The widening only removes pairs from the count, which keeps the number a lower bound.
  - **Counted:** only positive changes. Decreases are counted apart as pairs, never subtracted.
  - **Missed usage:** usage elsewhere that coincides with Claude Code requests isn't separable and isn't counted.
- **Consequences:**
  - **Falsifier:** during a stretch of Claude Code-only use, the metric must stay at 0. A positive value then means the payload lags its requests, and this ADR is superseded.
  - Requests from Claude Code on another machine also count as unattributed, since their logs aren't here. The viewer states this next to the number.
- *Falsifier, first run (2026-09-13, 15 minutes of terminal-only use):* 0 percentage points of rise across 40 reading pairs with no request in between, so no lag was detected. The run was short and percentages are whole numbers, so it runs again during weeks of real use.

## D-026: Burn rate is the window's average rate since it began, from status line percentages (2026-09-13)

- **Status:** accepted
- **Context:** The README's burn rate projects when the current window's limit would be reached. It's a projection, so it lives in a `proj_` view and carries the word "projected".
- **Options:**
  - (a) ccusage: tokens per minute across a 5-hour block, from its first to its last entry. Tokens don't convert to percentage without inferring limits (D-009).
  - (b) Monitor: the last 60 minutes of tokens against plan presets. Same inference, and a short span swings with each burst.
  - (c) The change between a window's first and last observed readings. Undefined with one reading, and the first reading depends on when the collector was installed or the session started.
  - (d) The last reading's `used_percentage` divided by the time since the window began, with the window start at `resets_at` minus the window length (5 hours or 7 days).
- **Decision:** (d).
  - **Rate:** `used ÷ (last reading − window start)`, in percentage points per hour.
  - **Projected limit time:** `window start + elapsed × 100 ÷ used`.
  - **Projected before reset:** compares that time with `resets_at`.
  - **Unknown:** no reading, a reading at 0%, or a reading at or before the computed window start leaves the projection unknown, and it's never shown as "never".
  - **Premise, stated beside the number:** the window's usage started at 0% at `resets_at` minus its length, and the average rate since then continues.
- **Consequences:** a window at 100% at its last reading is flagged as reached, not projected. If real spool data shows windows of another length, the premise and this ADR change.

## D-027: API list price is bucketed by local calendar month, beside a user-entered monthly plan price (2026-09-13)

- **Status:** accepted
- **Context:** The README shows observed tokens at API list price beside what the plan cost over the same period, in USD. Nothing on disk records the plan or its price, so the user enters it. D-012 forbids subtracting one from the other.
- **Options for the period:**
  - (a) UTC days, summed by the viewer.
  - (b) Calendar months in the machine's local timezone (D-007), matching monthly billing.
  - (c) Billing cycles from a user-entered renewal day.
- **Options for entry:**
  - (a) A config file.
  - (b) A `plan-price` command writing a `plan_prices` table: one row per month from which a price applies. A later month adds a row, and re-entering a month replaces that month's row.
- **Decision:** (b) for the period and (b) for entry.
  - Renewal days would add a setting that affects every number, and a day in the middle of a month is rarely what a plan price is quoted by.
  - **Plan price:** a month takes the row with the latest `effective_month` at or before it.
  - **Cost:** only priced requests contribute, and the view counts unpriced requests beside them.
  - **Lower-bound requests** are also counted.
  - **Priced before verified:** requests dated before their price row's `verified_on` (D-020) are counted.
  - **Unpriced month:** a month with no priced request has an unknown cost, not $0.
- **Consequences:** `plan_prices` is user data. Rebuilds never touch it, and it's never committed. The viewer prints the timezone name with each month.

## D-028: Repository attribution is re-checked when paths disappear, and missing paths inherit a repository (2026-09-13)

- **Status:** accepted. Refines D-010.
- **Context:** D-010 resolves each working directory once and caches the result. The first real report after the rename (2026-09-13) showed two problems:
  - **Stale entries:** a folder resolved while it existed stays labeled "git repository" after it's renamed or deleted, because cached entries are never re-checked. This contradicts CLAUDE.md: "a `cwd` that no longer exists on disk stays attributable by path and is labeled as such."
  - **Orphaned subfolders:** subfolders of a repository that still exists appeared as their own "directory no longer exists" rows. They were deleted before their first ingest, and git can't run inside a folder that's gone. *Observed (counts only):* 7 such working directories, 5 of them inside repositories still on disk.
- **Options for stale entries:**
  - (a) Keep the cache forever. That's the current bug.
  - (b) Re-resolve every working directory on every ingest, running git about 70 times per run.
  - (c) On every ingest, check only whether each cached working directory and its repository root still exist, which is cheap. Re-resolve through git only when that changed.
- **Options for a missing working directory:**
  - (a) Attribute it to its own path, as before.
  - (b) If it was resolved while it existed, keep that last-known repository root.
  - (c) Otherwise, run git on its nearest existing parent folder and take that repository.
  - (d) Match its path against repository roots already in the cache, without git.
- **Decision:** (c) for stale entries; (b), then (c), then (a) for missing directories.
  - A last-known root was verified by git, so it outranks any guess.
  - The parent-folder lookup uses git rather than path matching (d), because a parent can be inside a repository whose root was never cached.
  - **A repository row is labeled "git repository"** when its root still exists. It's labeled "directory no longer exists" when the root is gone too. So a deleted subfolder joins its repository's row, while a renamed repository keeps its old path, labeled missing.
  - **Risk accepted:** a deleted repository nested inside another repository, resolved only after its deletion, is attributed to the outer one. The row says how it was resolved (`resolved_via`).
- **Consequences:** migration 013 rebuilds `repositories` with `root_exists` and `resolved_via`, and recreates the views that read it. Existing entries are re-checked on the next ingest. Renamed projects still split across two paths; merging them needs a user-entered alias, not built yet.

## D-029: Status line readings come only from Claude Code running in a terminal (2026-09-13)

- **Status:** accepted (records an observed limit on D-008 and D-009)
- **Context:** *Observed (2026-09-13, Claude Code 2.1.269–2.1.270):* after the hook was installed, hundreds of assistant turns ran through the VS Code extension (`entrypoint: "claude-vscode"`), and the hook recorded no readings. The extension doesn't run the `statusLine` command. Session logs are written either way, so token, cost, and limit-hit metrics are unaffected.
- **Options:**
  - (a) Read usage percentages from another source for extension sessions. D-009 rules that out: undocumented endpoints or credentials.
  - (b) State the limit wherever readings are missing: `init`'s output, the report's "no readings" lines, and the README.
- **Decision:** (b).
- **Consequences:**
  - Headroom, peak, unattributed usage, and burn rate cover terminal sessions only. Unattributed usage also counts extension turns made between two terminal readings, since the extension leaves no reading but does write logs. Its request check still sees those requests, so they aren't miscounted as usage outside Claude Code.
  - Re-verify when a Claude Code release changes the extension's status line support.

## D-030: `report --save` writes a dated text and JSON copy to the data directory (2026-09-13)

- **Status:** accepted
- **Context:** `report` recomputes everything from the database and saves nothing. The maintainer wanted dated copies to compare over time, starting with a month of real use. A saved copy also records what the screen said at the time, while prices, views, and repository attribution can all change later (D-020, D-028). Reports contain personal usage and spend figures.
- **Options:**
  - (a) Leave it to shell redirection.
  - (b) An opt-in `--save` flag that writes both a `.txt` and a `.json` copy to `<data dir>/reports/`.
  - (c) Save every report automatically.
  - (d) Store report snapshots in a SQLite table.
- **Decision:** (b).
  - Automatic copies (c) clutter the folder with runs nobody meant to keep.
  - A table (d) duplicates data the database can already recompute, and a copy the reader can't open without the tool is no use for comparing weeks by eye.
  - **Two files per save:** the text is exactly what was printed, and the JSON has the unrounded rows and every label for later comparison.
  - **Name:** `report_YYYY-MM-DD_HHMMSS` in the machine's local time, so file names sort by date. The zone is named inside both files.
  - **Location:** the data directory, never the working directory, so a copy can't land inside a repository that may be published.
  - **Permissions:** the folder is created readable only by the user (0700), and each file too (0600).
  - **No overwriting:** a name that already exists gets `-2`, `-3`, and so on.
- **Consequences:** where the saved files went is printed after the report. With `--json`, that note goes to stderr so stdout stays pure JSON.

## D-043: Everything Nilometer stores is owner-only (2026-09-13)

- **Status:** accepted.
- **Context:** *Observed (2026-09-13, the maintainer's machine):* the data directory was `drwxr-xr-x`, and `usage.db` and `statusline.spool.jsonl` were `-rw-r--r--`. Any other account on the computer could read them. The database holds copies of session log lines (prompts, code, file paths), while Claude Code keeps the originals owner-only (`~/.claude` is `drwx------`, transcripts `-rw-------`). Nilometer's copies were therefore easier to read than the source. `settings.json` backups copied the source's mode, and settings can hold secrets (API keys in `env`).
- **Options:**
  - (a) Document it and leave permissions to the user's umask.
  - (b) Set a process-wide `umask 077` in the CLI entry point only. That's untestable through `runCli`, and misses files created before it runs and libraries' own files.
  - (c) Create every path owner-only explicitly and tighten existing installs on next open, in the hook (`umask 077`) and in code (explicit modes plus chmod).
- **Decision:** (c).
  - **New paths:** directories 0700, files 0600.
  - **The database file is created 0600 before SQLite opens it,** because SQLite gives its `-wal` and `-shm` files the database file's mode.
  - **`ingest`, `report`, `explain`, and `plan-price` tighten an existing data directory and its known files** (never loosening), and say so once, on stdout for `ingest` and on stderr otherwise.
  - **A directory is tightened only if it already holds a Nilometer file,** so a `--data-dir` pointed at a shared folder by mistake keeps that folder's permissions.
  - **Symbolic links are never followed by chmod.** The hook refuses to append through a symlinked spool or error log, and records `spool-symlink-refused`.
  - **`settings.json`:** backups are 0600, and a new settings file is 0600. An existing settings file keeps its mode, because it's the user's.
- **Consequences:** Windows is handled separately (D-049). Hook error log lines now have two kinds, `append-failed` and `spool-symlink-refused`, and ingest still counts lines.

## D-031: The scope stays retrospective; live updating stays out until weeks of real use are reviewed (2026-09-13)

- **Status:** accepted for now. Revisit after several weeks of real use.
- **Context:** Usage that updates in real time ("95% remaining; resets in 1h") across devices was requested on 2026-09-13, and a plan was drafted: a status bar display, `nilometer watch`, a tray app, a background agent, and multi-device sync. Reconsidered the same day: does that fit the tool this set out to be? The README's purpose is the plan-fit question in both directions (interruptions, headroom, where usage goes), answered from evidence gathered over weeks. It sets "one screen, no daemon, no desktop app, no live updating; every metric is retrospective."
- **Options:**
  - (a) Build that plan now.
  - (b) Build only the status bar display.
  - (c) Keep v1's scope, use it for a month, and decide on changes from real use.
- **Decision:** (c).
  - **Live usage is already shown by Claude itself** (`/usage`, claude.ai), fresher than Nilometer can manage without undocumented endpoints (D-009). Rebuilding it doesn't serve a monthly plan decision.
  - **Readings are never lost between ingests.** The hook records every turn, so freshness only matters for the report you're looking at. The one real deadline is Claude Code deleting session logs after 30 days.
  - **Periodic ingest is documented as a scheduled command** (README § Keeping it current). No daemon or agent is built.
- **Consequences:**
  - The live-display plan stays on hold; only its owner-only storage part was built (D-043).
  - Its pending decisions (D-032–D-042) aren't made; their numbers stay unused.
  - Multi-device sync stays parked, to be justified by real use or dropped. (A public release of v1's scope went ahead; see D-047 and D-048.)

## D-044: A reading is observed at its session's last API response, not at capture (2026-09-15)

- **Status:** accepted. Refines D-024 and D-025.
- **Context:** *Observed (2026-09-14 to 15, Claude Code 2.1.270, `statusLine.refreshInterval: 60`):* an idle terminal session re-ran the status line every minute for hours, while other sessions made over a hundred requests.
  - **Its percentages never changed,** through about a hundred requests elsewhere.
  - **After that window reset, the idle session reported no 5-hour window for hours,** although other sessions had started a new one.
  - **`rate_limits` in a payload are therefore the numbers from that session's last API response.** Re-running the status line (a timer, a reset event, `/compact`) repeats them.

  Views that dated a reading by its capture time made stale numbers look fresh: a reading shown with a recent capture time could come from a response hours earlier. That puts a wrong time on headroom's last reading and understates burn rate. D-024's "readings captured after reset" were likely the same effect. The payload also carried `used_percentage: 7.000000000000001`, a computed value rather than a strict integer.
- **Options:**
  - (a) Keep capture time, and document the caveat.
  - (b) Date each reading by the latest request line in the same session at or before the capture (+1 s, since captures are whole seconds), restricted to the window the reading reports. Fall back to capture time when there's none.
  - (c) Drop readings that repeat the previous reading's values.
- **Decision:** (b).
  - **Restriction:** the request must fall within `(resets_at − window length, capture + 1 s]`. A request from before the window started can't have produced numbers for it.
  - **One observation per response:** readings sharing window, reset, session, and observed time collapse to one, keeping the latest capture. A capture-time fallback is never merged.
  - **Observed time is what counts:** after-reset exclusion, ordering, headroom's reading time, peak, window reading counts, reading pairs, status line limit groups, and status line coverage.
  - **Why not (c):** a genuinely unchanged value observed after a new request is still a new observation.
  - **Unchanged:** `window_open` still uses capture time, because it's about time having passed, not what was observed.
- **Consequences:**
  - Migration 014 recreates the status-line views. Row counts called "readings" in the report now count observations.
  - **D-025 falsified by design:** under this model, every fresh observation follows a Claude Code request in its own session, so no pair of distinct observations lacks a request in between. Unattributed usage as defined can't detect usage outside Claude Code from status line data alone; before this, it only ever saw re-rendered duplicates. The metric stays, labeled, pending a decision after weeks of real use.
  - **The refresh experiment's result:** a `refreshInterval` with an idle terminal doesn't produce readings of other sessions' usage. Only a new turn in that session does. (A probe that starts such a turn on purpose is on hold under D-031.)

## D-045: A status line observation is one API response, dated by its first log line (2026-09-15)

- **Status:** accepted. Refines D-044.
- **Context:** D-044 dated each reading by the latest request *line* in its session. But one API response is written as several streaming snapshot lines, each with its own timestamp (D-001). *Observed on real data (2026-09-15, counts and structure only):* readings captured 1–7 s apart while one response was still streaming matched different snapshot lines of the same `message.id`, with identical token counts. They became separate "observations" of a single response. D-044's reading-pair request count also used the dedup winner's timestamp, the response's *last* line. A response whose last line landed after the next observation's `+1 s` bound wasn't counted, which is why real data still showed reading pairs with no request.
- **Options:**
  - (a) Key observations by the snapshot line, as in D-044.
  - (b) Key them by the response: the D-001 dedup key of the latest request line at or before capture, dated by that response's first line (when its numbers first existed). Count requests between observations as distinct responses with any line in the interval.
- **Decision:** (b).
  - **Unkeyed request lines** (neither `message.id` nor `requestId`) are their own response.
  - **The window bound and capture fallback** from D-044 are unchanged.
- **Consequences:** migration 015 recreates `window_readings` and `window_reading_pairs`; dependent views keep their columns.

## D-046: The checkout keeps every file's committed bytes on every platform (2026-09-17)

- **Status:** accepted.
- **Context:** Nilometer was being tested on a Windows PC. Git for Windows installs with `core.autocrlf=true` by default, which rewrites text files to CRLF on checkout. The status line hook is a POSIX `sh` script, and `sh` fails on CRLF lines (`$'\r': command not found`). Test fixtures are also byte-exact data (`.prettierignore` already exempts them from formatting). A clone made in VS Code or GitHub Desktop can't pass a `-c core.autocrlf=false` flag.
- **Options:**
  - (a) Document the clone flag. Rejected: easy to miss, and the failure is silent until the hook runs.
  - (b) `* text=auto eol=lf`: normalize text files to LF. Rejected: it would also rewrite any fixture that deliberately contains CRLF bytes.
  - (c) `* -text`: no line-ending conversion for any file.
- **Decision:** (c), in `.gitattributes`.
- **Consequences:** a Windows checkout matches the repository byte for byte, whatever the local `core.autocrlf`. Every tracked file is LF today (checked 2026-09-17), so nothing changes on macOS.

## D-047: The public repository is `MVFarinas/Nilometer`, with fresh history (2026-09-17)

- **Status:** accepted.
- **Context:** Nilometer was built in a private working copy. Its history includes personal notes and observations from the maintainer's own logs, which can't be removed from history reliably. Publishing needed a repository without that history, under the project's name.
- **Options:**
  - (a) Make the working copy public. Rejected: its history would go with it.
  - (b) A new repository under the project's name, starting from one commit built from an allowlist of the working copy's files, and checked for private references and terms before publishing.
  - (c) A new repository under a different name or a new organization.
- **Decision:** (b), chosen by the maintainer.
- **Consequences:**
  - **History starts at the first public commit.** The decision log and the build history ([docs/development.md](docs/development.md)) carry the reasoning; the audit records of the private build aren't published.
  - **An existing install keeps working:** the data directory, schema, and hook marker are unchanged. Moving a checkout folder re-points the status line hook when `init` runs again, with a settings backup. The report then lists the project under two paths, the old one labeled as a directory that no longer exists, until repository aliases exist (D-028).

## D-048: Development continues in the public repository (2026-09-17)

- **Status:** accepted.
- **Context:** after publishing, work could continue in the public repository, or in the private working copy with each release exported again.
- **Options:**
  - (a) Develop in the public repository.
  - (b) Keep developing privately and export each release. Rejected: two copies drift, every release repeats the export and its checks, and fixes made in public have to be carried back by hand.
- **Decision:** (a), chosen by the maintainer.
- **Consequences:**
  - **Data carries over:** an existing install's data directory, schema, and hook marker are unchanged, so its history stays. Nothing deletes the data directory.
  - **Personal material stays out of the repository:** real-log check results are printed as counts, and never committed.

## D-049: Windows is supported with Git for Windows; paths are written one way, and file modes are skipped (2026-09-17)

- **Status:** accepted. Nilometer needed to work on Windows as well as macOS.
- **Context:** *Observed on a Windows 11 PC (2026-09-17, Claude Code 2.1.273–2.1.274, Git for Windows 2.52, Node 24.12; two rounds of integration tests, counts only):*
  - **What already works:**
    - Claude Code runs the status line command through Git Bash when Git for Windows is installed, even when started from PowerShell. The POSIX hook ran unchanged, and single-quoted backslash paths (with spaces, accents, and apostrophes) arrived intact.
    - `init` wraps an existing shell or PowerShell status line, and `uninstall` restores the file byte for byte.
    - 20 concurrent hooks wrote 20 intact lines, three times.
    - Tokens and cost matched ccusage exactly (10 day/model rows).
    - Node's zone and SQLite's local time agreed.
    - The hook adds about 114 ms at p95 (macOS: about 33 ms).
  - **What didn't:**
    - **False owner-only note:** Node's `chmod` on Windows only toggles read-only, so modes read back as 666, and "Made Nilometer's data owner-only" printed on every command. It was never true.
    - **Backslashes in stored paths:** discovery joined log paths with `\`, so stored paths, `explain` locations, and fixture comparisons differed from every other platform.
    - **Duplicate repository rows:** Claude Code logged one folder with both `C:` and `c:`, and git returns roots with `/`. A deleted folder appeared as two repositories.
    - **Username in report paths:** no path shortened to `~` in reports, because the comparison assumed `/`.
    - **Test suite:** 105 of 814 tests failed, from `/bin/sh` spawns, POSIX modes, symbolic links (which need Developer Mode), `TZ` set at runtime, `/` expectations, and a temp cleanup that only set TMPDIR (336 folders left behind).
- **Options and decisions:**
  - **Supported setup:** (a) Windows with Git for Windows; (b) also without it, through a PowerShell or compiled hook; (c) WSL only. **Decision: (a).** (b) is a second hook to build and test, and Claude Code recommends Git for Windows anyway. (c) would exclude the native setup that already works.
  - **Owner-only storage on Windows:** (a) set owner-only ACLs with `icacls`; (b) skip mode changes on Windows and never report them; (c) keep calling `chmod`. **Decision: (b).** The data lives under the user profile, whose permissions already limit it to the user, SYSTEM, and administrators by default. (a) is more code that could lock out backup or admin tools, and it's untested. (c) prints a false statement.
  - **Stored log paths:** (a) the platform separator; (b) `/` on every platform, rewriting a Windows database's existing `\` paths once at the start of each ingest. **Decision: (b).** It gives one database format, and `explain` locations and fixtures match everywhere. The rewrite runs only on Windows, where `\` can't be part of a file name, and it keeps files from being read twice.
  - **Repository names:** (a) normalize the stored `cwd`/`repo_root`; (b) normalize only the attributed repository in `request_repositories`: uppercase drive letter, `/` separators; (c) fold the whole path's case. **Decision: (b)** (migration 016). The source columns keep their spelling, and no POSIX value can match a leading drive letter. (c) goes beyond what was observed; only the drive letter's case varied.
  - **Home shortening:** `displayPath` treats a Windows home as matching with either separator and either drive-letter case.
- **Consequences:**
  - **Tests adapt or skip, with the reason stated** (`tests/setup/platform.ts`):
    - the shell is `sh` from PATH;
    - mode tests skip without POSIX modes, and symbolic link tests skip when links can't be created;
    - the two fixed-zone month tests skip on Windows;
    - child processes get `USERPROFILE`, so a test never touches the real profile;
    - the test temp root sets TEMP and TMP as well as TMPDIR.
  - **CI:** Ubuntu first. Windows runners cost double in private-repository minutes, so a Windows PC was the Windows check until the public repository, whose CI adds macOS and Windows runners.
  - **Hook speed on Windows** stays as measured. Reducing process starts is possible later if it proves noticeable.

## D-050: A security and privacy review before the public repository: paths are absolute, files Nilometer didn't write aren't followed, and text from the logs is escaped before printing (2026-09-17)

- **Status:** accepted. Publishing turns "what could a mistake on this machine do?" into "what could a hostile input do on someone else's machine?", so the code was reviewed as if the person supplying its inputs were not the person running it.
- **Context:** Nilometer reads three things it doesn't control: Claude Code's status line payload, Claude Code's session logs, and the paths a user passes it. All three carry text from elsewhere — repository and branch names, model names, file paths, session IDs — and none of it is Nilometer's own. The review looked for what that text, or a file planted in the data directory, could make Nilometer do. Findings were fixed here; what was checked and deliberately left alone is listed under Consequences.
- **Options and decisions:**
  - **A relative `--data-dir` or `NILOMETER_HOME`:** (a) keep it relative; (b) resolve it to an absolute path when it's read, and refuse a relative path when building the status line command. **Decision: (b)** (`core/install/locations.ts`, `core/settings/statusline.ts`). `init` writes the data directory into the status line command, and Claude Code runs that command in whatever project is open. A relative path would resolve against each project in turn, so a folder committed to a repository — `./nilometer-data/wrapped-command` — would decide what the hook executes. The refusal is a second check in the one function that builds the command, so no future caller can reintroduce it.
  - **A symbolic link at `wrapped-command`:** (a) follow it; (b) refuse it and record the refusal. **Decision: (b)** (`hooks/statusline.sh`). The file's contents are executed, so following a link runs a command from a file Nilometer never wrote. `init` only ever writes a regular file, so a link there is not a setup to preserve. The refusal is logged as `wrapped-command-symlink-refused` and the status line still prints, matching how a symlinked spool and error log were already handled.
  - **A symbolic link at the install record:** (a) follow it; (b) refuse it. **Decision: (b)** (`core/install/record.ts`). The record decides what `uninstall` writes back into `settings.json`; a planted one could restore any command. `uninstall` now also prints the command it restored, so the change is visible rather than only recorded.
  - **A symbolic link at `settings.json`:** (a) let the atomic rename replace it; (b) write through it, and refuse a link whose target doesn't exist. **Decision: (b)** (`core/settings/settings-file.ts`). Linking `~/.claude/settings.json` into a dotfiles repository is a normal setup, and a rename would quietly detach it; writing through the link keeps both the link and the atomic write. A *dangling* link is refused instead, because "the file isn't there" would otherwise make `init` create the link's target, wherever on the machine it points.
  - **`uninstall` run without the `--data-dir` the install used:** (a) report that no record was found and remove the `statusLine` entry; (b) recover the data directory from the hook command being removed, and restore from the record there. **Decision: (b)** (`dataDirFromHookCommand` in `core/settings/statusline.ts`, used by `runUninstall`). (a) was the behaviour, and it deleted the user's own status line — the one thing the project promises never to do — because the record it needed was sitting in a directory it hadn't been told about. The command being removed is the one other place `init` writes that path down.
  - **Text from the logs printed to a terminal:** (a) print it as stored; (b) write control characters as escapes at the display boundary. **Decision: (b)** (`printable` in `viewer/format.ts`, applied in `renderTable` and `explain`). A directory or branch name can contain a newline or an escape sequence; printed raw, a newline forges an extra table row and an escape sequence can recolor, move, or erase what the reader is looking at — a report that lies about its own numbers. Escaping at display keeps the stored value exact (principle 4 still resolves it back to its events), and column widths are measured after escaping, so the table stays aligned.
  - **A log file or folder that can't be read mid-run:** (a) fail the run; (b) skip it, count it, and say so. **Decision: (b)** (`core/ingest/ingest.ts`, `core/ingest/discover.ts`). Claude Code deletes logs on its own schedule, so a file vanishing between listing and reading is ordinary, not an error; one unreadable folder shouldn't cost a whole ingest. Only errors carrying a filesystem `code` are counted — a bug still throws, rather than being absorbed as an unreadable file. The count is printed with the run ("N files or folders that couldn't be read this run (skipped)"), because a silent skip is a silent gap in the data (report, don't fix).
- **Consequences:**
  - **Every fix has a test that was watched to fail without it.** Reverting each change in turn failed exactly the test written for it (absolute paths, the command builder's refusal, both symlink refusals, the settings link, the escaping, the unreadable file and the unreadable folder). A guard that has never failed isn't known to work.
  - **Found by running the commands, not by reading them:** the `uninstall` data loss appeared in an end-to-end run of `init --data-dir ./reldata` followed by a plain `uninstall`, after the code review was finished. Reviewing the source found the input-handling faults; only running it found the one that needed two commands and a flag to appear.
  - **Checked and left as they are:**
    - `report --save` creates with `wx` (exclusive create), which fails on an existing path including a symbolic link, so a report can't be written through a link.
    - No SQL is assembled from log text: values are always bound parameters, and the five statements that interpolate anything interpolate a table or view name from a fixed `as const` list, or a name read from `sqlite_master` with its quotes doubled.
    - The hook never interpolates payload text into a command: the payload goes to a temp file, reaches the wrapped command on stdin, and is base64-encoded into the spool line. The only thing executed is the status line command the user already had, which Claude Code runs as a shell string anyway.
    - `init` makes the data directory owner-only and says so. A directory the user pointed at that was deliberately shared becomes owner-only too — for usage data that is the right default, and it's reported rather than silent.
  - **Not changed, and why:** the settings backups aren't pruned (they're small, and deleting a user's backups is worse than keeping them); the database has no size ceiling (growth is measured in Phase 8 first); there's no lock around ingest (one user, one machine, and the spool is append-only).

## D-051: The audit runs on Windows, and a path test states what `resolve` returns there (2026-09-18)

- **Status:** accepted. Found by re-running D-050's changes on the Windows PC.
- **Context:** *Observed on the Windows 11 PC (2026-09-18, Node 24.12, Git for Windows):*
  - **An integration test timed out** at 6.9 s against Vitest's 5-second default, on macOS, under coverage — a flake, not a defect, but one that would recur on slower CI runners.
  - **`npx` failed the same way** in `scripts/compare/ccusage.ts` (check A7), which is why both spawn sites now go through one module rather than each solving it again.
  - **`npm run audit` failed all 14 checks without running any of them.** Eleven exited 127 and two exited 9009. The runner spawns `tsc`, `eslint`, `prettier`, `vitest`, and `tsx` by name; npm installs them on Windows as `.cmd` shims, and Node refuses to spawn a `.cmd` without a shell. `python3` on that machine is the Windows Store stub, which exits 9009 instead of running Python; the real interpreter is `python`. `gitleaks` and `shellcheck` aren't installed there at all.
  - **Four tests failed** on correct values: D-050 resolves the data directory, and `path.resolve("/flag-data")` on Windows returns `C:\flag-data`. The tests compared against the POSIX spelling.
  - Everything D-050 changed behaved correctly in use, including a data directory named `Ana María O'Brien\data dir`, which round-tripped through the status line command, the hook, and an `uninstall` run without `--data-dir`.
- **Options and decisions:**
  - **Starting the audit's tools on Windows:** (a) `shell: true` with the command and arguments as they are; (b) `shell: true` with the whole command line quoted here and passed as one string; (c) resolve each `.cmd` path explicitly; (d) spawn each tool's JavaScript entry point through `node`. **Decision: (b)**, in `core/util/commands.ts` (`scripts/util/` until D-064 moved it into shipped code). (a) was tried first and was wrong: Node concatenates arguments without escaping them under a shell (DEP0190), so `C:\Program Files\nodejs\node.exe` is split at the space and the command fails — the audit's own checks all use bare names and relative paths, but `defaultDeps().run` is exported and would have been a trap for the next caller. Quoting here also silences that deprecation, because no arguments are passed for Node to concatenate. (c) can't work: Node refuses to spawn a `.cmd` at all without a shell. (d) needs a name-to-package map for five tools and breaks when a package moves its entry point. POSIX keeps spawning directly, with no shell.
  - **Telling "not installed" from "failed":** (a) read it off the exit code; (b) look the command up before running it. **Decision: (b)** (`commandFound`), at **every** spawn site: the audit runner and the ccusage comparison's `runCommand`, which was missed on the first pass and kept reporting a missing command as exit 1 on Windows. (a) was tried first and doesn't work there: through `cmd.exe` a command that isn't there exits 1, exactly like a tool that ran and found something. `where.exe` is a real executable, so it spawns without a shell. On POSIX nothing is looked up, because a missing command already reports itself as ENOENT — so the two platforms word it differently ("ENOENT" against "was not found") and the test accepts either.
  - **`python3` that isn't Python:** (a) require `python3` on PATH; (b) try `python3`, then `python` on Windows. **Decision: (b).** The stub is on PATH by default on Windows and can't be removed without the user's involvement. If `python` were Python 2, the reference tests would fail loudly rather than quietly skipping.
  - **A tool that isn't installed:** (a) print its exit code; (b) print "not installed" and still fail. **Decision: (b).** The summary is pasted into an audit record, where `FAIL (exit 9009)` reads as a check that ran and found something. A check whose tool is missing hasn't run, and an unrun secret scan is never a pass, so it still fails.
  - **Integration tests timing out on a loaded machine:** (a) leave Vitest's 5-second default; (b) raise the timeout for the two integration files only. **Decision: (b)** (`vi.setConfig({ testTimeout: 60_000 })`, proven by setting it to 1 ms and watching all seven fail). Each of those tests starts several real CLI processes, and Node plus tsx plus coverage instrumentation costs a second or two per start; one run of the full audit timed out at 6.9 s while nothing was wrong. The unit tests keep the 5-second default, where a timeout still means a hang.
  - **POSIX path expectations:** (a) keep the POSIX spelling and skip those tests on Windows; (b) state the expectation as `resolve` returns it on the platform running the test (`absolute()` in `tests/setup/platform.ts`). **Decision: (b).** The behaviour under test — a relative path is made absolute, a flag wins over the environment — is the same on both platforms; only the spelling of an absolute path differs. Skipping would leave D-050's own guarantee untested on Windows.
- **Consequences:**
  - **CI is unchanged:** the full audit still runs on Linux, where Python, gitleaks, and shellcheck are installed; the macOS and Windows jobs run the test suite. The Windows job was the one D-050 would have broken.
  - **`commandFound` reflects the PATH it runs under.** Without `node_modules/.bin` on PATH, `where.exe` doesn't find `tsc`, `eslint`, `prettier`, `vitest`, or `tsx` — but neither would the spawn, so the report is accurate rather than pessimistic. `npm run` puts that directory on PATH, and every audit entry point is an npm script.
  - **Found by re-running on Windows, three times.** Each round found faults in the round before it, and none of them could have been seen from macOS. The first fix ran the checks but split a command path containing a space and still read a missing tool as an ordinary failure; the second fixed both but left one spawn site — the ccusage comparison's own `runCommand` — consulting nothing. Only re-running on the machine found each one.
  - **Windows without gitleaks and shellcheck** reports those three checks as `FAIL (not installed)`. That's accurate: on that machine the audit is incomplete, and the Linux CI run is what clears them.
  - **Symbolic-link tests skip on Windows without Developer Mode** (5 of them after D-050, 32 skipped in total), as D-049 established.

## D-052: The coverage thresholds are a POSIX gate; Windows runs the tests without them (2026-09-18)

- **Status:** accepted. Found when the PC re-ran the audit after D-051 fixed the runner.
- **Context:** With the audit finally running on Windows, check A4 still failed there — not on a test, but on the threshold: **832 passed, 32 skipped, functions 98.74%**. The skips are the tests Windows can't run (symbolic links need Developer Mode; `chmod` only toggles the read-only attribute, D-049), and the gap is exactly the code they cover: `core/install/private-files.ts` at 85.71% of functions, `viewer/report.ts` at 66.66%, and a branch in `runCommand` that Windows returns from before reaching. The same suite reaches 100% on macOS and in CI. No amount of test-writing closes this while those tests skip, because the functions can't be executed on the platform at all.
- **Options:**
  - (a) Lower the thresholds, or make them platform-aware. Rejected: it weakens the gate on the platforms where the whole suite does run, and creates a second, quieter definition of "the audit passed".
  - (b) Exclude the affected files from the threshold on Windows. Rejected: the exclusion list would have to grow with every platform-specific test, and a file excluded for one platform is excluded from everyone's attention.
  - (c) Rewrite the skipped tests to run everywhere by injecting a fake filesystem. Rejected for now: those tests exist to check what real `chmod` and real symbolic links do (D-043, D-050). A test that only exercises injected doubles would stop being the test that caught anything.
  - (d) **Run the tests on Windows without the coverage thresholds, and say so.** **Chosen.**
- **Decision:** (d). `checksFor(platform)` in `scripts/audit/run.ts` drops `--coverage` from A4 on Windows and renames it `Unit tests (coverage is a POSIX gate)`. The name is in the summary table, so an audit record pasted from Windows shows on its face which gate didn't run. The thresholds are untouched where the whole suite runs.
- **Consequences:**
  - **Nothing is lowered.** macOS and the Linux CI job still enforce 100% of functions; a function without a test still fails the audit there.
  - **Windows still proves the code works there**, which is what that machine is for: 864 tests, 832 run, 0 failed.
  - **CI already agreed with this:** the Windows job runs `npx vitest run`, without coverage. This makes the local audit match what CI does.
  - **A full audit on Windows also needs gitleaks and shellcheck**, which aren't installed there; those three checks report `FAIL (not installed)`. The complete audit is the Linux CI run and a macOS run, and that is now written down rather than assumed.

## D-053: MIT, with the copyright in the maintainer's legal name (2026-09-18)

- **Status:** accepted. Written down on 2026-09-18, after the choice had already been made and shipped (`LICENSE`, `package.json`, and the README's license line), because a decision this cheap to change now and expensive to change later shouldn't live only in a file header.
- **Context:** The public repository needs a license before it's public: without one, nobody may legally use, copy, or modify the code, whatever the README invites them to do. Three facts shaped the choice:
  - **The point of publishing is that other people run it.** The tool answers a question about a subscription someone already pays for; a license that makes it awkward to adopt defeats that.
  - **Nothing in the runtime forces a license.** The whole shipped dependency closure is three packages — `better-sqlite3`, `node-addon-api`, and `commander` — and all three are MIT (checked 2026-09-18). No copyleft anywhere, so every option below was genuinely open.
  - **There is one copyright holder and no outside contributors yet.** Relicensing today means editing three files. After other people's commits are merged it needs every contributor's agreement, or a contributor licence agreement set up in advance.
- **Options:**
  - (a) **MIT.** Chosen.
  - (b) **Apache-2.0.** Rejected: its additions over MIT are an explicit patent grant and a requirement to state changes. There are no patents here and no corporate contributors to defend against, so it buys length rather than protection for a project this size.
  - (c) **GPL-3.0.** Rejected: copyleft would stop a closed fork, but it also rules the tool out at many workplaces, which is where a subscription's headroom question actually gets asked. The cost falls on the people meant to use it.
  - (d) **AGPL-3.0.** Rejected for (c)'s reasons and because its distinguishing clause covers use over a network. Nothing here is hosted: the tool reads local files and writes to a local database.
  - (e) **Source-available (PolyForm, BUSL).** Rejected: it isn't open source, it conflicts with the norms of the package registry the roadmap points at, and it deters the contributions that a tool depending on an undocumented log format needs.
- **Decision:** (a), chosen by the maintainer, with the copyright notice in a legal name rather than a platform username. A copyright notice identifies a person who can hold copyright; an account name can be renamed or transferred, and the notice would then point at nothing.
- **Consequences:**
  - **Anyone may ship a closed-source or commercial derivative**, provided the notice travels with it. That is the accepted price of (a), not an oversight.
  - **The "AS IS" disclaimer earns its place here.** `init` edits a file Claude Code owns and the tool reads session logs; the disclaimer is the only thing standing between a bug and a claim.
  - **Three places state the license** — `LICENSE`, `package.json`, and the README — and they have to stay in step. A change means all three.
  - **Revisit before the first outside contribution is merged**, if it's going to be revisited at all. That is the last moment it stays a three-file edit.

## D-054: The private working copy keeps the personal material; it is not a staging copy of the code (2026-09-18)

- **Status:** accepted. Refines [D-048](#d-048-development-continues-in-the-public-repository-2026-09-17) and replaces the plan to freeze the private working copy.
- **Context:** D-048 settled where code is developed, but not what becomes of the private working copy afterwards. The plan said to archive it. Two things were then noticed:
  - **Some material can never be public and never stops being produced:** real-log check results, and personal planning. Archiving the only place they live means they either stop or move somewhere with no history.
  - **The export's gates would stop running.** A21 and A22 — no references to private documents, no private terms — only ever inspected files the export produced. With nothing exported, the checks that kept personal material out of the public tree simply wouldn't run any more, exactly when commits start going straight there.
- **Options:**
  - (a) **Archive the private copy and develop only in public.** Rejected: it loses the place the personal material lives, and the gates with it.
  - (b) **Develop privately and export every release, so the public repository only ever receives reviewed exports.** Rejected, for D-048's reasons and one more that decides it: the export overwrites the target, so a contribution made in the public repository is destroyed by the next export, or has to be replayed by hand under the wrong author. An export-based repository is hostile to the contributors this one invites.
  - (c) **Develop in public; the private copy keeps only what can't be public, and the gates move to a pre-push hook on the public clone.** Chosen.
- **Decision:** (c). The private working copy stops holding a second copy of the code and keeps the personal material, so it stays in use rather than frozen. `scanMain` (`scripts/export/scan.cli.ts`) runs A21 and A22 against a live repository's **tracked** files — only those get pushed — and `release/public-pre-push-scan.sh` runs it as the public clone's `pre-push` hook.
- **Consequences:**
  - **The gate runs at the last moment anything can be stopped**, on every push, rather than once per export. Proven by committing a denylist term to the public clone and watching the push be refused; the output named the term's source, never the term.
  - **It fails closed.** A missing scanner, denylist, database, or folder refuses the push. A gate that passes because it couldn't check is worse than no gate, because it is trusted.
  - **The hook is local and uncommitted**, like the push guard in private clones, so no machine-specific path is ever committed. It has to be installed per clone, which the script's own header documents.
  - **One copy of the code.** Contributions land in public and stay there, with their author's name on them.
  - **The export stays** for as long as the two repositories both exist, and becomes unnecessary once the public one is the only place code lives.

## D-055: The test run's temporary root is canonicalized, because Windows shortens long user names (2026-09-18)

- **Status:** accepted. Found by the public repository's Windows CI job, which failed while the same commit passed on the Windows PC.
- **Context:** Five `attribution.test.ts` tests failed on the GitHub Windows runner, comparing two spellings of the same directory. The runner's account name is longer than eight characters, so `TEMP` holds its 8.3 short form (a truncation ending in `~1`) while git reports the name in full. Every failing assertion was a temp path that differed only in that one segment. The tests already called `realpathSync` for the macOS case of exactly this problem (`/var` → `/private/var`), but plain `realpathSync` on Windows resolves links without expanding a short name; only `realpathSync.native` does.
- **Why the PC didn't see it:** its user name is eight characters or fewer, so nothing is shortened there. The two Windows machines disagreed, and only CI had the long name.
- **Options:**
  - (a) Use `realpathSync.native` at the three call sites that failed. Rejected: it fixes the instances, and the next test to compare a built path against a tool's output starts the same way.
  - (b) **Canonicalize the run's temporary root once, before any test derives a path from it.** Chosen. Everything downstream — every worker, every child process, every `mkdtempSync(join(tmpdir(), …))` — then spells the root the way the filesystem does.
- **Decision:** (b), in `tests/setup/temp-root.ts`.
- **Consequences:**
  - **The per-test `realpathSync` calls stay** and are now redundant for the root, which is harmless: canonicalizing an already-canonical path returns it unchanged.
  - **Not a product defect, but a real product limit.** In use, `cwd` comes from Claude Code and `repo_root` from git. If a `cwd` ever arrived with a short name, the two would disagree and one repository would be recorded as two — the same shape as the `C:`/`c:` duplicate that [D-049](decisions.md) fixed. That one was fixable in a migration because a drive letter's case can be normalized from the string alone; a short name can't, since expanding it needs the directory to still exist, and missing directories stay attributable by path (D-028). It isn't normalized, and nothing has been seen in real data. Recorded here so a duplicate repository row on Windows has a first place to look.
  - **A second Windows machine earns its place.** The PC and the CI runner disagree about user names, temp paths, and symbolic-link permissions, and each has now caught something the other couldn't.

## D-056: `init` installs the hook into the data directory, so no upgrade can move it (2026-09-18)

- **Status:** accepted. Closes R2.2, the item that blocked publishing to a package registry.
- **Context:** `init` wrote the path of `hooks/statusline.sh` *inside the package* into Claude Code's `statusLine.command`. That path is only as stable as the package's location, and it isn't stable:
  - **A global install lives under the Node version in use.** On the machine this was found on, `npm root -g` is under `node-versions/v24.21.0/`. Upgrading Node leaves the command naming a file that no longer exists.
  - **A clone can move.** Observed the same day: switching between two checkouts made `init` print "the hook's location had changed", and it was only corrected because `init` happened to run.
  - **The failure is silent.** The shell reports "No such file or directory" into a status line nobody reads, exits non-zero, and Claude Code shows nothing unusual. Readings simply stop. A gap in the data that announces itself as nothing is the failure this project exists to prevent.
- **Options:**
  - (a) Keep naming the package, and tell people to re-run `init` after every upgrade. Rejected: it makes a silent data gap the user's responsibility, and nothing reminds them.
  - (b) Resolve the hook through the `nilometer` command at run time. Rejected: it puts Node in the status line's critical path on every reply, where today there's only `sh`.
  - (c) **Copy the hook into the data directory and name that copy.** Chosen. The data directory is chosen by the user, holds the database and the spool, and never moves on its own.
- **Decision:** (c). `init` writes `<data dir>/statusline.sh` on every run (`installHook`), and `resolveTargets` builds the command from it. The copy is written to a temporary file and renamed, so a hook running during an upgrade never reads half a script; it is owner-only; and a symbolic link in that place is refused rather than written through, like every other file `init` owns (D-050).
- **Consequences:**
  - **Proven, both ways.** With the package deleted outright, the status line command still ran the user's wrapped command and recorded a reading. The command `init` would have written before this change fails with exit 127 on the same setup, recording nothing.
  - **A stale copy is possible, and is reported.** Pulling a new version leaves the settings command correct but the installed copy old, so `init` compares the two and says when it refreshed one. That's why `init` copies on every run, including when it changes nothing else.
  - **Existing installs move across by running `init` again**, which updates the command in place and keeps the install record. Nothing needs to be uninstalled first.
  - **The data directory now holds an executable script**, listed in `DATA_DIR_FILES` so it is made owner-only with everything else. It sits beside `wrapped-command`, which was already executed and already protected.
  - **Publishing to a registry is no longer blocked by this.** It stays unscheduled for its own reasons (an account, a name that can't be unpublished quietly, and a release workflow).

## D-057: Node 24 with `better-sqlite3` stays; `node:sqlite` is measured and kept in reserve (2026-09-18)

- **Status:** accepted. Closes R2.3, which had been "decide from the spike" since the release plan was written.
- **Context:** The runtime is what the tool asks of someone else's machine. `better-sqlite3` is a native module: it needs a prebuilt binary for the platform or a compiler, and it is compiled against one Node major version — a mismatch doesn't degrade, it crashes. That was observed on the development machine, where the shell's older Node segfaults on the module built for Node 24. Node's built-in `node:sqlite` would remove the native dependency entirely. The question was whether it produces the same numbers, which is the only thing that matters here.
- **The spike (2026-09-18), both drivers against the same real database, read-only:**

  | | `better-sqlite3` | `node:sqlite` |
  |---|---|---|
  | Every report view and three aggregates, compared row for row | reference | **0 mismatches** |
  | Integer columns (token sums) | `number` | `number`, equal |
  | BLOB columns (`raw_lines.bytes`) | `Buffer` | `Uint8Array` |
  | Reading every report query | 19.1 s | 21.5 s (about 12% slower) |
  | Experimental warning on Node 24.21 | — | none |

- **What a port would cost:** eight `db.transaction()` call sites become explicit `BEGIN`/`COMMIT`, three `db.pragma()` calls become `exec("PRAGMA …")`, and the one `.raw()` maps to `setReturnArrays()`. The BLOB difference is the only trap: ingestion calls `Buffer` methods on `raw_lines.bytes`, and a `Uint8Array` has no `toString("utf8")` or `equals`. It fails as a `TypeError` rather than a wrong number, which is the right way for it to fail.
- **Options:**
  - (a) **Keep Node 24 with `better-sqlite3`.** Chosen.
  - (b) Port to `node:sqlite` now. Rejected for now: the prize is losing the native build, which nobody has yet been unable to install, while the port touches every write path and has to be re-verified against the fidelity checks and ccusage. It also makes reads about 12% slower, on a report that is already too slow for a different reason.
  - (c) Support a wider range of Node versions. Rejected: every major needs its own `better-sqlite3` build and its own CI job, and a version mismatch is exactly the crash this project already hit once.
- **Decision:** (a). `.nvmrc` and `engines` stay at Node 24.
- **Consequences:**
  - **`node:sqlite` is now a measured option, not a guess.** If someone can't install the native module, or if publishing to a registry makes prebuilt binaries a support burden, the port is known to produce identical results and the work is known to be contained.
  - **Revisit when there's a reason**, not on a schedule: a platform without a prebuilt binary, or a Node release that breaks the module.
  - **The spike found something else.** Reading every report view takes about 16 seconds on a real database, and `obs_unattributed_usage` is about 55% of that while returning one row per window. That is a separate problem from the driver, and the faster driver is the one already in use.

## D-058: A response is dated by its final streaming snapshot, and a fixture now pins that (2026-09-18)

- **Status:** accepted. Writes down behaviour that was already there but never chosen on purpose.
- **Context:** One API response is written as several cumulative snapshots. Deduplication keeps the one with the largest `output_tokens` ([D-001](decisions.md)), which is the last snapshot written, so a request carries **that** line's timestamp — the moment the response finished, not the moment it started. Nothing said so, and nothing tested it: case 07 covers day boundaries but gives every response a single line, so no fixture exercised a response whose snapshots fall on either side of midnight. The choice was an accident of a tie-break made for a different reason.
- **What it actually moves:** the gap between a response's first and last snapshot is a few seconds — a median of about 3.4 s and at most a few minutes on a real log set — so the two choices differ only for a response that straddles a boundary. Across a real log set, one response crossed a UTC day boundary and seven crossed a clock hour. It changes a day's totals, and which five-hour window a request is attributed to, for that handful.
- **Options:**
  - (a) **Date a response by its final snapshot** (when it finished). Chosen.
  - (b) Date it by its first snapshot (when it started). Rejected: see below — the reference implementation does not do this, and adopting it would trade a matching number for a permanent documented difference, for no gain in accuracy.
- **Decision:** (a), now tested rather than assumed. Fixture `18-streaming-across-midnight` writes one response as two snapshots five seconds apart, straddling UTC midnight, and the ccusage comparison reports **MATCH** on it: the reference implementation counts it on the finishing day too. **Narrowed by [D-065](decisions.md):** that fixture has growing counts, so the largest-output rule picks the final line on its own. Where every line carries the same counts the rule picks nothing, the two tools disagreed, and the earliest line wins instead.
- **Consequences:**
  - **The fixture is the guard.** Changing the tie-break in D-001 now moves this fixture's day totals and fails both the loader check and the ccusage comparison, instead of quietly moving a number.
  - **It is defensible on its own terms**, not only by agreement: the final snapshot is the one carrying the response's full output count, so dating a request by it dates it by the line the tokens actually come from.
  - **Choosing (b) later means declaring a delta.** It would move this fixture out of MATCH and into the known-deltas list, which is the honest way to do it, and a reason would have to be better than "it feels earlier".

## D-059: The report reads twice as fast, and the index that does it is partial on purpose (2026-09-18)

- **Status:** accepted. Plan item M7.
- **Context:** `nilometer report` took about 16.5 seconds on a real database, and one view was 55% of it: `obs_unattributed_usage` spent about 8.9 seconds returning one row per window. The cause is `window_reading_pairs`, which counts the distinct responses between two status line readings with a subquery run once per pair. That subquery filters `parsed_lines` by class and a timestamp range with no session, and every index led with `session_id`, so each of hundreds of pairs scanned the whole table.
- **What was tried, and measured, as medians of three runs on a real database:**

  | | no index | index on `(class, timestamp_utc)` | partial index |
  |---|---|---|---|
  | `obs_unattributed_usage` | 9347 ms | 1794 ms | **1236 ms** |
  | `obs_lockout_time` | 2296 ms | 3391 ms | 2313 ms |
  | `obs_sessions_not_resumed` | 1157 ms | 1740 ms | 1167 ms |
  | every report view | 17281 ms | 13633 ms | **9285 ms** |

- **Two things were wrong on the way here, and both were found by measuring rather than reasoning:**
  - **The first diagnosis was wrong.** The obvious fault was that `obs_unattributed_usage` asked `window_reading_pairs` four correlated questions per window, so the first fix computed the pairs once and grouped them (migration 017). On its own that made the view **worse** — 9.0 s to 15.8 s — because the outer repetition was never the cost; the per-pair subquery was, and grouping forced it for every pair instead of letting the planner skip it.
  - **A plain index fixed the wrong thing too.** It cut the slow view to 1.8 s but made eight other views slower by 270–1070 ms each, because the planner started reaching for it in the window views, which filter by session and time. A partial index can only be used by a query carrying the same `WHERE` clause, so it serves this subquery and is invisible to everything else.
- **Decision:** keep both changes together — the grouped view (017) and the **partial** index `parsed_lines_request_time ON parsed_lines (timestamp_utc) WHERE class = 'request'` (018). The grouped view is a pessimisation alone and nearly doubles the gain once the index exists.
- **Consequences:**
  - **Not one number moved.** `report --json` on a real database is byte-identical before and after, and that was checked after every step, not once at the end. End to end the command went from about 16.5 s to about 7.7 s.
  - **A test now asserts the indexes exist**, and that this one is partial. Removing the migration fails it. Nothing in the suite measures time, so without that test a later migration could drop the index and only a person would notice, months later.
  - **Ingest writes are slightly slower**, by one small index. A line is written once and these views are read on every report.
  - **This does not decide the metric's future.** `obs_unattributed_usage` still can't be nonzero on real status line data ([D-044](decisions.md)) and may be relabeled or dropped at the review of a month's use. Making it fast doesn't argue for keeping it; if it goes, this work goes with it.

## D-060: A first run says what to do next, and deleting the data is explicit and itemized (2026-09-18)

- **Status:** accepted. Closes R2.5, the last item before other people use this.
- **Context:** Two moments were never designed, only inherited — the first five minutes and the last.
  - **The first run printed forty lines of nothing.** Every section correctly said "no data yet" and none of them said what produces data, that the two sources arrive separately, or that usage percentages need a terminal. A new user read a page of zeros to learn that nothing had happened.
  - **There was no way to remove the data.** `uninstall` restores the settings file and keeps everything recorded, which is right by default and a dead end for someone who tried the tool and wants it gone. The README didn't say where the data was or how to delete it either.
- **Options and decisions:**
  - **The first run:** (a) leave the empty sections; (b) add a line at the top of them; (c) replace them until there is something to report. **Decision: (c).** A first run has no coverage to state, so there is no number the sections are protecting. `--json` is untouched, so anything reading the report programmatically still sees every key.
  - **Deleting data:** (a) document a manual `rm`; (b) `uninstall --delete-data`. **Decision: (b).** A documented `rm -rf` on a path the user has to assemble is how the wrong directory gets deleted. The flag is opt-in and never implied: plain `uninstall` keeps everything and now names the flag, so it can be found without the README.
  - **What gets deleted:** (a) the data directory; (b) only the files Nilometer writes, then the directory if nothing else is left. **Decision: (b).** A `--data-dir` can point at a folder holding other things, and deleting a directory because of its name would take those with it ([D-043](decisions.md) already refuses to touch shared folders). What was left behind is named in the output.
  - **What it prints:** the files removed, how many requests and readings they held, the span those requests covered, and that it can't be undone. The database holds copies of session logs Claude Code deleted under its own 30-day cleanup, so **that output is the only remaining record of what was there.**
- **Consequences:**
  - **Both are guarded by tests that were watched to fail**: removing the first-run branch, and removing the "only what Nilometer wrote" filter.
  - **A real bug came out of writing those tests.** Removing the emptied directory used `rm` without recursion, which refuses a directory; the end-to-end run had missed it because a foreign file was present, so the directory was never removed. It is `rmdir` now, which fails rather than succeeds if anything appeared since the check.
  - **`summarizeStoredData` returns null rather than throwing** when there is no database, because `--delete-data` runs on installs that never recorded anything.
  - **The README documents removal** beside privacy, including that only Nilometer's own files go.

## D-061: A removal is reported from the filesystem, not from the call returning (2026-09-18)

- **Status:** accepted. Found on a Windows machine during the public repository's first verification pass.
- **Context:** `uninstall --delete-data` printed that it had deleted four files, then printed the same four files under "left alone", and all four were still on disk. The self-contradiction was the clue: the code appended each name to `removed` as soon as `rmSync` returned, then listed whatever `readdirSync` still found.
  - **The cause is below Nilometer.** On Windows, `fs.rmSync` on a single path removes nothing when any component of that path holds a non-ASCII character. It throws nothing, and `force: true` hides that it did nothing. Reproduced with no Nilometer code involved on Node 24.12, win32; **not reproducible on macOS Node 24.21**, so a newer Node may fix it. `unlinkSync`, `rmdirSync`, and `writeFileSync` + `renameSync` all work on those same paths.
  - **Who it reaches:** anyone on Windows whose account name isn't ASCII, because the data directory defaults under the home directory. The same call sat in three more places:
    - `uninstall` reported *"Removed settings.json: init had created it"* while the file survived **with the hook still registered**, so the hook kept running and kept recording after a reported uninstall. That is the worst of them: a tool that says it is gone and isn't.
    - the install record and wrapped command survived `uninstall`.
    - a failed settings write would leave its temporary file behind.
- **Options:**
  - (a) Swap `rmSync` for `unlinkSync` and `rmdirSync`, which work on the affected paths. Necessary, and not sufficient: it fixes one diagnosed platform bug and leaves the next one silent.
  - (b) **Remove, then check the filesystem, and report what survived.** Chosen, with (a) inside it.
- **Decision:** (b). `removePath` walks a tree apart with `unlinkSync` and `rmdirSync`, swallows whatever the call throws, and returns `!existsSync(path)` — the answer comes from the disk, not from the API. Every caller reports only what is confirmed gone: `deleteDataFiles` splits `removed` from `failed`, `uninstall` carries `notRemoved` and **exits 1** when a file it meant to remove is still there.
- **Consequences:**
  - **The claim is now falsifiable, and false claims cost an exit code.** "Deleted" means checked. A file Nilometer wrote, tried to remove, and could not, is printed as still there, with a line saying nothing above claims it is gone.
  - **The guard is proven where it can be.** The Windows fault cannot be reproduced on macOS, so a test forces the same shape with a read-only parent directory: the unlink fails, the file survives, and the report has to say so. Reverting the check to `return true` fails that test. Without it, nothing on a POSIX machine exercised the failed path at all.
  - **Non-ASCII paths are now tested**, which nothing did before — a data directory under `données de test` is deleted and verified.
  - **This cannot be confirmed fixed from the machine that fixed it.** The verification belongs to the Windows machine that found it.
  - **A test can be wrong in a platform-specific way too:** the same pass found an assertion that slashed raw JSON text, where every backslash is escaped, so it only failed on Windows. Compare parsed values, not file text.

## D-062: `--delete-data` reports the deletion in every branch, including the ones that change nothing (2026-09-18)

- **Status:** accepted. Found on the Windows machine while verifying [D-061](decisions.md), and reproduced on macOS: not a platform fault.
- **Context:** `uninstall --delete-data` deletes the data before `describeUninstall` chooses its wording, and two of that function's four branches returned without ever mentioning it. So:
  - `uninstall --delete-data` on an install whose hook was already removed printed **"Nothing was changed."** and exited 0, with the data directory gone.
  - The same after a user replaced `statusLine` by hand printed **"It was left unchanged."**, with the data directory gone.
  - It also lost the request and reading counts and their span — which D-060 exists to print, because they are the only remaining record once the database holding logs Claude Code already deleted is gone.
- **This is D-061 pointing the other way.** One said a deletion happened that hadn't; this said nothing happened while it had. Both are the same fault: output written from what the code intended rather than from what occurred.
- **Options:**
  - (a) Refuse `--delete-data` when the hook isn't ours to remove. Rejected: someone who already uninstalled and now wants their data gone has a legitimate reason to run it, and refusing sends them to a hand-assembled `rm -rf`, which is exactly what D-060 avoided.
  - (b) **Report the deletion in every branch.** Chosen.
- **Decision:** (b). The two branches that leave the settings file alone now append the same deletion summary the others print, and "Nothing was changed" is only said when nothing was — the sentence becomes "the settings file was not changed" once data has gone.
- **Consequences:**
  - **Every path that deletes says so, with the counts.** Proven by a test over both branches that fails when the lines are dropped.
  - **The rule this leaves behind:** a message is assembled from what happened, not from which branch produced it. Both defects came from a branch describing its own intent while another part of the command did something it never mentioned.
  - **Verification found a second defect by doing the work, not by reading it.** D-061 was fixed and verified, and the verification pass then walked the neighbouring paths and found this. Checking a fix is worth more than checking the code that was changed.

## D-063: Everything the viewer prints is ASCII, and a test keeps it that way (2026-09-18)

- **Status:** accepted. Both beta testers are on Windows, which decided it.
- **Context:** A Windows console on a legacy code page decodes UTF-8 as CP437 or CP850, so the output's own punctuation arrived as mojibake. Observed on a supported platform: a coverage line read `02:27ΓÇô02:29`, and the middle dot used as a field separator throughout the report and `explain` garbles the same way. It is not a font, and it is not the user's setting to fix: the program chose characters its supported platform cannot render by default.
- **Options:**
  - (a) Keep the typography and tell Windows users to run `chcp 65001`. Rejected: that is handing the user a problem the tool created, in a README they read once, to fix output they see every day.
  - (b) Detect the console and degrade. Rejected: a second rendering path to test, on a platform already carrying the most platform-specific code.
  - (c) **Stay inside ASCII.** Chosen. `·` becomes `|` and the same-day coverage dash becomes `to`, which also made two adjacent lines say the same thing the same way.
- **Decision:** (c), with a test rather than a habit: `tests/wording/ascii-output.test.ts` renders the report, its JSON, and every `explain` view over an empty database and the report fixture, and fails on any character above U+007F. The test checks itself first, asserting it can see a middle dot and an en dash before it asserts there are none.
- **Consequences:**
  - **Only Nilometer's own wording is covered.** Repository names, model names and file paths come from the user's logs and may hold anything; the fixtures this renders over are ASCII, so a non-ASCII character in that output is the tool's own. `printable` still passes user text through unchanged, and a test asserts it.
  - **Claude Code's text is not ours to change.** Its limit message contains a middle dot, and the parser tests carry it verbatim. A blanket replace across the tests hit those too and was reverted: the same character means different things on either side of the boundary, and only the side this project writes is in scope.
  - **The guard is why this is a decision and not a tidy-up.** Without it the next ornamental character arrives with the next feature, and the person who finds it is on Windows.

## D-064: `nilometer verify` checks a user's own numbers against ccusage, and says nothing about their data (2026-09-18)

- **Status:** accepted. Built because a beta made the gap obvious.
- **Context:** The audit compares this tool against ccusage on committed fixtures (check A7), which proves the reading rules on data everyone can see. Nothing proved them on anyone's real logs. Testers are asked not to send reports — they hold prompts, file paths and project names — so a beta could report that the tool installs and runs, and nothing at all about whether its numbers are right. "Tell me if it breaks" is a thin use of somebody's week.
- **Decision:** a command that runs the same comparison where the logs are, and prints a result that can be sent to someone without sending the data: days compared, and any day, model and field where the two disagree. No path, repository name, session id or prompt text, asserted by a test.
- **What it compares, and why not more:**
  - **Tokens, not cost.** Cost needs both tools' price tables to agree, which is a different question from whether the logs were read the same way. A model with no price row here would otherwise report a "difference" that is [D-020](decisions.md) working.
  - **Only days both sides can see.** Ingestion keeps raw lines after Claude Code deletes a log ([D-002](decisions.md)); ccusage reads what is on disk now.
  - **A response counts if *any* copy of it survives, not the copy dedup kept.** This was found by running it: the first version excluded a response when the largest-output line's file was gone, and on a real machine that was 802 responses, making this tool look a third of a day short. One response is written to several lines and sometimes several files, and ccusage reads whichever survives.
- **The comparison rules moved into shipped code** (`core/verify/compare.ts`), shared by the audit and the command. Two implementations of "do these agree" would be free to drift, and the value of a reference implementation is that the comparison itself is trustworthy. A7 passing unchanged after the move is the evidence it changed nothing.
- **Consequences:**
  - **It uses the network**, by fetching a pinned ccusage through `npx` — the first thing in the installed tool that does. `SECURITY.md` said there was no runtime network access at all; it now names this command, what it reads, and that nothing is uploaded.
  - **Every failure path is testable offline.** The lookup and the spawn are injected, so "npx is missing" and "ccusage failed" are covered without a download, and the spawn plumbing is proven against a local process instead.
  - **It found something on the first real run**, which is the point: a handful of responses attributed to different days than ccusage puts them, conserved exactly across the boundary — the same magnitude missing from one day and present on the next. Nothing lost, an attribution question, and a fixture does not cover it.

## D-065: When the dedup rule cannot choose, the earliest line wins (2026-09-18)

- **Status:** accepted. Corrects a consequence claimed in [D-058](decisions.md), and found by `nilometer verify` on its first real run.
- **Context:** One API response is written as several lines and the largest `output_tokens` wins ([D-001](decisions.md)). When every line carries the **same** counts, that rule selects nothing, and the tie-breaks behind it ended on `line_number DESC` — the last line. Which line wins normally decides nothing, because the numbers are identical. At a day boundary it decides which day the response counts on.
  - *Observed on a real log set:* one response written three times across `23:59:57` to `00:00:01`, counted on the later day here and the earlier one by ccusage. It moved 4,680 output tokens and 590,251 cache reads between two days — conserved exactly, so nothing was lost and nothing was double-counted, but two days were wrong.
  - **D-058 overstated its evidence.** It said the reference implementation "counts it on the finishing day too", proven by a fixture. That fixture has *growing* counts, where the largest-output rule picks the last line on its own and both tools agree. It says nothing about the tied case, which is the only case where the tie-break matters. A fixture proves the shape it contains.
- **Options:**
  - (a) Keep the last line. Rejected: the reason D-058 gives for the final snapshot — "the line the tokens actually come from" — is satisfied by every tied line equally, so it picks none of them. The rule was doing unprincipled work.
  - (b) **The earliest of the tied lines.** Chosen.
  - (c) Match ccusage. Rejected as a reason, though it is the same answer: agreeing with the reference implementation is corroboration, not a principle.
- **Decision:** (b), migration 019. Among lines tied on `output_tokens` and sidechain status, the earliest timestamp wins; a line whose timestamp did not parse never wins on that alone. This is the rule this project already states for the same problem: [D-045](decisions.md) collapses duplicate readings and dates each by its response's first line, "when its numbers first existed".
- **Consequences:**
  - **Nothing changes where the counts grow.** The largest output still wins before this is reached, so case 18 and every ordinary streamed response are untouched.
  - **Fixture 19 pins the tied shape**, and the ccusage comparison reports MATCH on it. The independent Python reference implements the same tie-break, so the two agree by construction rather than by import.
  - **On real logs, this was the last disagreement.** `verify` went from 12 differences to 0 across 33 days.
  - **What it corrects in D-058:** not the decision, which stands, but the claim that the fixture proved agreement in general. It proved it for one shape.

## D-066: Nilometer checks the Node.js version first, stops below 24, and warns above it (2026-09-24)

- **Status:** accepted. Refines [D-057](decisions.md), which it leaves standing: Node 24 is still the one supported version.
- **Context:** A beta tester tried to install without Node.js at all, and the README gave one line of requirements. Getting it wrong is worse than it looks, because nothing on the install path stops a wrong version:
  - **`npm ci` only warns.** `engines` is `>=24 <25`, but npm doesn't enforce it unless told to.
  - **An older Node.js crashes without a word.** *Observed 2026-09-24 on Node 22.11.0:* `--help` works, then `ingest` and `report` both exit 139 (a segfault) the moment the database opens, with nothing printed. A user sees a crash, not "you need Node.js 24".
  - **A newer Node.js works.** *Observed the same day on Node 26.10.0:* `ingest` and `report` ran, and the whole suite passed (907 tests; two git-spawning tests timed out under load in the full run and passed when rerun alone, on 26 and on 24). This refines D-057's premise that "every major needs its own `better-sqlite3` build": the version in use ships one prebuilt binary per platform (`prebuilds/darwin-x64.node` and so on), not one per Node.js major. The crash runs in one direction only.
- **Options:**
  - (a) Documentation only. Rejected on its own: the people who most need the guide are the ones who skip it, and they still get a silent segfault.
  - (b) `engine-strict=true` in `.npmrc`, so `npm ci` refuses a wrong version. Rejected: it applies to every dependency's `engines`, and three development tools ask for `>=24.15.0`, so it would refuse the Node 24.12.0 the Windows test PC runs (the `EBADENGINE` warnings recorded in the README). It also checks only at install, not when an older Node.js runs an existing install.
  - (c) Refuse anything but 24. Rejected: it would stop a setup observed to work, and make someone downgrade for a failure nobody has seen.
  - (d) **Stop below 24 with a message; run above 24 with a one-line warning.** Chosen.
- **Decision:** (d). `checkNodeVersion` (`core/util/node-version.ts`) runs first in `cli/main.cli.ts`, which loads the rest of the program with a dynamic import only after it passes, because a static import would run before the check could. Below 24 it prints which version was found, that the database would crash, where the install guide is, and "Nothing was changed.", then exits 1. Above 24 it prints that newer versions aren't tested and runs. The messages go to stderr, so `--json` output is unaffected.
- **Consequences:**
  - **[`docs/requirements.md`](docs/requirements.md)** is the install guide both messages point to: how to check for Claude Code, Node.js 24, git, and Git for Windows, and how to install each, including how to get 24 rather than the newest release.
  - **The supported major is written in three places**, `.nvmrc`, `engines`, and `SUPPORTED_NODE_MAJOR`, and a test fails if they disagree. A test also fails if the entry point goes back to importing the program statically.
  - **Proven against real runtimes, not only in unit tests:** the built command under Node 22.11.0 prints the message and exits 1 where it used to exit 139, and under Node 26.10.0 it prints the warning and runs.
  - **Supporting newer Node.js is still a separate decision.** It would need a CI job per major, which D-057 declined. The warning keeps that honest in the meantime: newer versions are allowed, not claimed.
  - **The status line hook is unaffected.** It is a shell script and never starts Node.js ([D-056](decisions.md)).
