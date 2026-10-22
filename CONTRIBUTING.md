# Contributing

Thanks for looking at Nilometer. It's small and opinionated about measurement, so a short read first saves a round of review.

## Before you start

- **[`README.md`](README.md) is the specification.** Its **Measurement Principles** decide whether a metric may exist at all: observed and projected numbers stay separate, nothing is a counterfactual, and every number traces back to its events.
- **[`decisions.md`](decisions.md) records why things are built the way they are**, with the options that were rejected. Check it before proposing a change to something it covers. A new judgment call gets a new entry.
- **[`docs/development.md`](docs/development.md) holds the standards every change meets:** TSDoc on every function, comments that explain *why*, a source comment on every schema column, 100% function coverage, and an audit.
- **Build checklists** for each area are in `.claude/skills/`. They're written for Claude Code, but they're plain Markdown and just as useful to read.

## Setup

Node.js 24 (the version in `.nvmrc`; 26 is tested too) and git. On Windows, use Git for Windows and run commands in Git Bash. [`docs/requirements.md`](docs/requirements.md) says how to check and install each one.

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

## Releasing (maintainer)

Releases are published to npm by `.github/workflows/publish.yml` when a GitHub release is published. npm trusts that workflow by name, so no token is stored anywhere, and each version carries a provenance attestation.

1. **Changelog:** move what's under *Unreleased* in `CHANGELOG.md` to a heading for the new version and today's date.
2. **Version:** `npm version <patch|minor|major> --no-git-tag-version` updates `package.json` and the lockfile.
3. **Commit and push,** and wait for CI to pass. CI installs the packed package in an empty home on Linux, macOS and Windows.
4. **Publish a GitHub release** whose tag is `v` plus the version, such as `v0.1.1`. The workflow checks that the tag matches `package.json`, builds from an empty `dist/`, runs the tests, checks the package contents (A23), rehearses the install, and publishes that same tarball. A version with a pre-release part, such as `0.2.0-beta.1`, goes to npm's `next` tag, so `npm install -g nilometer` doesn't pick it up.

**When API list prices change,** a release is the only way users get them: an npm install can't edit `core/pricing/prices.json`. Add the dated rows as the `pricing-table` checklist in `.claude/skills/` describes, then release a patch version. The report names the date its rates were read.

