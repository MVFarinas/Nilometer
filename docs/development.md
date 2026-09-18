# Development

**How Nilometer is built and how a change counts as done.** [`README.md`](../README.md) is the specification, and [`decisions.md`](../decisions.md) records why things are built the way they are, with the options that were rejected. This file holds the standards every change meets, the audit that checks them, and the history of the build steps that code and tests cite (`docs/development.md P4.5`).

Contents: [Standards](#standards) · [Audits](#audits) · [Build history](#build-history)

---

## Standards

### Code documentation

This project documents more than a default code style would. Tooling enforces it wherever it can, and the audit review checks the rest.

- **Every source file** opens with a header comment stating:
  - what the module is for
  - the README section it implements
  - the decision IDs that govern it, e.g. `Implements README § How it works; see D-001, D-003.`
- **Every function, method, class, interface, type alias, and exported constant has a TSDoc block**, exported or not, with:
  - a one-sentence summary of what it does
  - `@param` for every parameter, including units and nullability (e.g. `epoch seconds`, `null when the window is absent`)
  - `@returns`, describing the value and its edge cases
  - `@throws` for every error it can raise, or a statement that it never throws (the hook)
  - `@see D-00X` where a decision governs the behavior
  - `@example` for any function whose input format isn't obvious (log line and payload parsers)

  Enforced by `eslint-plugin-jsdoc` with `require-jsdoc` on all function kinds, plus `require-param`, `require-returns`, and `require-throws`.
- **Inline comments on every line or block that isn't self-evident.** They say *why*:
  - the invariant being protected
  - the log quirk being handled
  - the fixture case or upstream bug it prevents, e.g. `// Keep the largest snapshot: first-wins undercounts (D-001, fixture 2).`

  A comment that restates the syntax (`count++ // increment count`) fails review, because it drifts from the code and buries the comments that matter. The review asks: *could a reader who knows TypeScript but not this project understand why each non-trivial line exists?*
- **SQL files** carry:
  - a header naming what the file creates and why
  - a `-- source: <json path>` comment on **every** column that holds a log or payload field (the `ingest-session-logs` skill has the field table)
  - a comment on every view naming the metric, whether it's observed or projected, and the principles it satisfies

  A test parses the migration files and fails on any column without a comment.
- **Tests:** every test name states the behavior (`keeps the largest streaming snapshot when a scan lands mid-stream`). Tests built on a fixture cite the fixture number.
- **CLI help:** every command and flag has `--help` text, and a test snapshots it.

### Testing

- **Every function has unit tests.** Enforced by a coverage threshold of **100% of functions**, **≥ 95% of lines**, and **≥ 90% of branches** in `vitest --coverage`. Lowering a threshold needs an ADR. The thresholds are a **POSIX gate**: Windows skips the tests it can't run (symbolic links, file modes), so the functions those cover are never executed there and the threshold would be measuring the skips. On Windows `npm run audit` runs the tests without coverage and names the check `Unit tests (coverage is a POSIX gate)`, so a record pasted from that machine can't be read as a full audit (D-052).
- **Each unit test covers** the normal case, each edge case the TSDoc names, and each `@throws`.
- **SQL views are tested by running them** on an in-memory database seeded from fixtures, not by mocking the database.
- **No real session logs or payloads in the repository.** Fixtures are synthetic. Checks against real logs run locally, and only pass/fail and ratios are recorded.
- **Every guard is proven once.** When a change adds a check (a lint rule, a threshold, a fidelity comparison, the banned-phrase test), its audit injects the bug it guards against into a throwaway change, records that the check failed, and reverts.
- **Platforms (D-049):** tests that need POSIX file modes, symbolic links, or a time zone set while running skip where the platform can't provide them, through `tests/setup/platform.ts`, with the reason next to the skip. On macOS and Linux nothing skips.

### Commits

- One logical change per commit, prefixed with its step ID where it has one (`P4.2: byte-offset reader`).
- No co-author trailers.
- Nothing personal: no spend, plan details, real paths, or real log content.

---

## Audits

Every change ends with an audit. It's the change's definition of done.

### The standard audit: `npm run audit`

It runs everything, not just the current change's tests, so a later change can't silently break an earlier one.

| # | Check | Command | Added |
|---|---|---|---|
| A1 | Types | `tsc --noEmit` (strict) | P0.2 |
| A2 | Lint + documentation rules | `eslint .` (typescript-eslint + jsdoc) | P0.2 |
| A3 | Formatting | `prettier --check .` | P0.2 |
| A4 | Unit tests + coverage thresholds | `vitest run --coverage` (tests only on Windows, D-052) | P0.2 |
| A5 | Schema column comments | `tsx scripts/audit/schema-docs.cli.ts` | P3.1 |
| A6a | Fidelity: the Python reference's own unit tests | `python3 -m unittest discover -s scripts/fidelity` | P2.2 |
| A6b | Fidelity: the reference against every hand-computed `expected.json` | `npm run fidelity` | P2.2 |
| A6c | Fidelity: the TypeScript loader against `expected.json`, in two staging modes, with idempotency fingerprints | `npm run fidelity:loader` | P4.5 |
| A7 | ccusage comparison on fixtures, with known deltas | `npm run compare:ccusage` | P2.3 |
| A8 | Idempotency fingerprints | part of A6c | P4.3 |
| A9 | Banned-phrase test over rendered viewer output | `vitest run tests/wording` | P7.1 |
| A10a–c | Secret and personal-data scan | `gitleaks git` (history) · `gitleaks dir` (working tree) · `npm run scan:personal` | P0.2 |
| A11 | Shell hook lint | `shellcheck hooks/*.sh` (D-018) | P1.1 |

**Pass means every check passes, with zero skipped tests on macOS and Linux.** A `.only` test fails the audit everywhere. On Windows, only the platform skips named under [Testing](#testing) are allowed.

**Tools it needs:** Node.js 24, Python 3, [gitleaks](https://github.com/gitleaks/gitleaks), and [shellcheck](https://www.shellcheck.net/). A7 downloads a pinned ccusage through `npx` the first time.

### A change's audit

On top of the standard audit, each change records:

- **Functional checks:** its acceptance tests, exercising the feature the way a user would, e.g. running the real CLI command on a fixture directory.
- **Regression checks:** things that must still hold after the change, beyond the automated suites.
- **Guard proofs:** which new check was proven by injecting its bug.
- **Review checklist:** documentation completeness, comment quality, and README, decisions, and skills updated where the change altered behavior.

### The audit record

- **An audit record per change,** named by its step ID, contains:
  - the commit hash
  - date
  - the output summary of `npm run audit` (counts, coverage percentages)
  - each functional check with pass/fail
  - the guard proofs
  - the review checklist, ticked
- **A history file** is append-only, one line per audit: `date · step · commit · PASS/FAIL · tests N · coverage fn/line/branch`.
- **A failed audit is recorded too.** The fix lands as new commits followed by a new audit line, never by editing the failed record.
- **Records start with the first public release.** v1 was built and audited in a private working copy, and those records aren't published; the build history below and the decision log carry what they established.

---

## Build history

v1 was built in eight phases. Code and tests cite these step IDs; the decision log records every later change, with its date.

| Phase | Goal | Steps |
|---|---|---|
| 0 Foundations and falsifiers | A toolchain that enforces the standards, and evidence that the riskiest assumptions hold: the hook's per-turn cost, and the log facts behind D-001 and D-004 | P0.1 Decide the blocking choices · P0.2 Scaffold and the audit harness · P0.3 Spikes (throwaway code, findings recorded) |
| 1 Status line collector and `init` | Collect usage percentages as early as possible: they can't be backfilled | P1.1 The hook · P1.2 Settings file operations · P1.3 `init` and `uninstall` commands |
| 2 Fixtures and independent reference | Know the right answers before writing the loader | P2.1 Fixture generator · P2.2 Independent reference (Python) · P2.3 ccusage comparison harness |
| 3 Schema and storage | The database layer, with migrations, documented columns, and fingerprints | P3.1 Database access and migration runner · P3.2 Migration 001: ingestion tables · P3.3 Fingerprint utility |
| 4 Ingestion | Logs and spool in SQLite, agreeing with the reference on every fixture | P4.1 Discovery · P4.2 Byte-offset reader · P4.3 Raw line store · P4.4 Classification and parsed views · P4.5 Dedup view (D-001) · P4.6 Repository attribution · P4.7 Spool ingestion and validation (D-008) · P4.8 `ingest` command and `init` backfill |
| 5 Pricing and cost | Observed tokens at API list price, sourced and dated | P5.1 Pricing schema and seed rows · P5.2 Cost view (D-006) |
| 6 Metrics | The README's metrics as SQL views, each passing the `add-metric` checklist | P6.1 Interruption metrics (observed) · P6.2 Headroom metrics (observed) · P6.3 Attribution metrics (observed) · P6.4 Projections |
| 7 Viewer | The one screen: observed sections first, projections in a separate, labeled section | P7.1 Rendering · P7.2 Drill-down (principle 4) · P7.3 Name, packaging, docs |

**Why this order:**

1. **Collector before analysis.** Usage percentages can't be backfilled. Every day the hook isn't installed is headroom data that's gone for good. The hook needs no database, so it shipped first.
2. **Tests before the code they judge.** The fixtures, hand-computed expected values, and independent reference implementation existed before the loader, so the loader has to agree with something it didn't write.
3. **Falsifiers early.** Assumptions that could force a redesign were tested in Phase 0, not discovered in Phase 6.
