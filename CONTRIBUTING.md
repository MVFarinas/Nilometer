# Contributing

Thanks for looking at Nilometer. It's small and opinionated about measurement, so a short read first saves a round of review.

## Before you start

- **[`README.md`](README.md) is the specification.** Its **Measurement Principles** decide whether a metric may exist at all: observed and projected numbers stay separate, nothing is a counterfactual, and every number traces back to its events.
- **[`decisions.md`](decisions.md) records why things are built the way they are**, with the options that were rejected. Check it before proposing a change to something it covers. A new judgment call gets a new entry.
- **[`docs/development.md`](docs/development.md) holds the standards every change meets:** TSDoc on every function, comments that explain *why*, a source comment on every schema column, 100% function coverage, and an audit.
- **Build checklists** for each area are in `.claude/skills/`. They're written for Claude Code, but they're plain Markdown and just as useful to read.

## Setup

Node.js 24 (the version in `.nvmrc`) and git. On Windows, use Git for Windows and run commands in Git Bash. [`docs/requirements.md`](docs/requirements.md) says how to check and install each one.

```sh
npm ci
npx vitest run       # the test suite
npm run audit        # everything, as CI runs it
```

The full audit also needs Python 3, [gitleaks](https://github.com/gitleaks/gitleaks), and [shellcheck](https://www.shellcheck.net/), and downloads a pinned ccusage the first time.

## Rules that catch people out

- **No real data in the repository.** Fixtures are synthetic. Real session logs hold prompts, code, and file paths from other projects. The same goes for issues and pull requests: never attach logs, reports, databases, or `settings.json`.
- **Wording is part of correctness.** The viewer never says *time lost*, *wasted*, *would have spent*, *savings*, *cheaper by*, *verdict*, *recommend*, or *you should switch plans*, and never scores productivity or efficiency. A test fails if it does. Use the README's wording, such as *elapsed lockout time* and *your observed tokens at API list price*.
- **Analysis lives in SQL.** Metrics are views over the ingested data, not JavaScript that fetches rows and filters them.
- **Guards are proven.** A new check comes with a record that it failed once when the bug it guards against was injected.

## Pull requests

- One logical change per pull request, with tests.
- `npm run audit` passes.
- The description says which README section or decision the change touches, and why.
