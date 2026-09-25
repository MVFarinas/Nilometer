---
name: ingest-session-logs
description: Build or change ingestion of Claude Code session JSONL logs (and the status line spool) into SQLite. Use when touching file discovery, raw line storage, incremental offsets, record classification, dedup, sidechains, limit-hit events, or the ingest report.
---

# Ingesting session logs

The decisions behind every rule here are in `decisions.md`: D-001 to D-004, D-007, and D-010. Read the entries this change touches before writing code. If this skill and `decisions.md` disagree, `decisions.md` wins.

## Pipeline

```
discover files ─▶ read from stored byte offset ─▶ raw_lines (append-only, exact bytes)
                                                     │
                     parse + classify (views or rebuildable tables) ◀┘
                                                     │
          requests_dedup view · limit_events · ingest_report · repo_attribution
```

Nothing downstream of `raw_lines` is precious. A rebuild drops and re-derives it and never deletes the database (D-002).

## 1. Discovery

- **Roots, in order:**
  - If `CLAUDE_CONFIG_DIR` is set, use it only. It may be comma-separated, and it's an error if none of its paths contain `projects/`.
  - Otherwise use `$XDG_CONFIG_HOME/claude` and `~/.claude`.
  - Each root is scanned as `<root>/projects/**/*.jsonl`.
- **No depth cap.** Subagent transcripts live at `<project>/<session>/subagents/*.jsonl`. haasonsaas capped depth at 3 and missed deeper files.
- **Sort paths** so ingest order is deterministic.
- **The status line spool** is one more append-only JSONL source (D-008). It uses the same offset mechanism but gets a different classifier.

## 2. Reading (D-003)

- **Stream line by line.** Never read a whole file into one string: a 519 MB file broke V8 (ccusage#1151).
- **Per file, store** `byte_offset` (just past the last `\n` consumed), `size`, and `inode`.
  - **A trailing fragment with no `\n`** is not consumed; the next run picks it up once complete. Counting it is phuryn's lost-turn bug.
  - **`size < byte_offset` or a changed inode** means a rewrite: re-read from 0. Unique `(source_path, content_hash)` makes the repeat a no-op.
- **Store the exact bytes** in `raw_lines` with `source_path`, `byte_offset`, `content_hash`, and `ingested_at`.

## 3. Classification

Parse each raw line once. Every line lands in exactly one class, and every class is counted in the ingest report. **`fixtures/README.md` is the precise spec:** its classification order (error lines before the request test), identity, and ordering rules are what the fidelity suite checks. Where this table is looser, the README wins.

| Class | Test | Goes to |
|---|---|---|
| `malformed` | JSON parse fails | ingest report with raw bytes and location. Never dropped silently |
| `request` | `type == "assistant"`, has `message.usage`, `message.model != "<synthetic>"` | dedup view |
| `limit_hit` | `isApiErrorMessage == true` and `error == "rate_limit"` | `limit_events` (D-004) |
| `api_error` | `isApiErrorMessage == true`, any other `error` | events; not requests, not tokens |
| `synthetic_other` | `message.model == "<synthetic>"` otherwise | events; not requests |
| `retry_notice` | `type == "system"`, `subtype == "api_error"` | events with `retryAttempt`, `maxRetries`, `retryInMs`, `error.status`, `error.formatted`, `error.isNetworkDown`. Never a limit hit or a request. A non-null `error.rateLimits` → ingest report (D-019) |
| `ignored_type` | any other `type` (user, attachment, other system subtypes, file-history-snapshot, ...) | counted by `type` and `subtype`, nothing else |

- **An unrecognized `error` value** goes to the report as its own row, so a format change shows up as a new count, not as a silent change of class.
- **Don't reject a line over one bad field.** ccusage drops lines with null fields, a non-semver `version`, or unusual timestamp lengths. Store what parsed, and report each field that didn't.

## 4. Fields to extract from `request` lines

Every column mapping a log field carries a `-- source field` comment in the migration.

| Column | Source |
|---|---|
| `session_id` | `sessionId` |
| `message_id` | `message.id` |
| `request_id` | `requestId` |
| `ts_utc` | `timestamp` (store raw text too; unparsed → report, D-007) |
| `model` | `message.model` (exact string, never normalized) |
| `input_tokens` | `message.usage.input_tokens` |
| `output_tokens` | `message.usage.output_tokens` |
| `cache_read_tokens` | `message.usage.cache_read_input_tokens` |
| `cache_write_5m_tokens` | `message.usage.cache_creation.ephemeral_5m_input_tokens` |
| `cache_write_1h_tokens` | `message.usage.cache_creation.ephemeral_1h_input_tokens` |
| `cache_write_unsplit_tokens` | `message.usage.cache_creation_input_tokens`, only when the split object is absent (older logs) |
| `speed` | `message.usage.speed` |
| `is_sidechain` | `isSidechain` |
| `cwd`, `git_branch`, `cc_version` | `cwd`, `gitBranch`, `version` |

- **Keep the four token families separate.** Never store one "total": haasonsaas's total silently excluded cache tokens.
- **`message.usage.iterations[]`** can hold entries of other types (advisor, `fallback_message`) billed under a different model (ccusage#1423, ccusage#1552). Record any iteration whose `type != "message"` in the report until a decision covers pricing them.

## 5. Dedup (D-001)

A view over `request` rows, never an insert-time rule:

- **Key:** `(session_id, message_id)`; if `message_id` is null, `(session_id, request_id)`; if both are null, the row is **unkeyed**. It passes through as its own row and is counted in the report. Never invent a key.
- **Winner per key:** largest `output_tokens`, then `is_sidechain = 0`, then the highest `(source_path, byte_offset)`.
- **Sanity figure (as of 2026-09-12, one real log set):** summing all lines overcounts output tokens about 2.5× versus the winners. Keeping the first line undercounts by about 1.4%. A change that moves totals by amounts like these is a dedup change.

## 6. Limit events (D-004)

- **From each `limit_hit` line keep** `session_id`, `ts_utc`, `cwd`, the raw text, and best-effort parses of window type and reset time from the text.
- **An unparsed window or reset** is stored as NULL and labeled unknown. The event still counts.
- **Wording already differs across versions** ("5-hour limit reached" vs "You've hit your session limit · resets 6:10am (<tz>)"). Classify only on the structured `error` field; the text is for window and reset parsing only.
- **Reset time (D-023):** `events.reset_at_utc` resolves a `H[:MM]am|pm (<IANA zone>)` reset text against the hit's own timestamp (`core/ingest/reset-time.ts`). Any other wording stays NULL until its shape has been observed.
- **Structured fields first (D-067):** from Claude Code 2.1.281, a limit hit carries `quotaLimits.rateLimitType` and `quotaLimits.resetsAt`. They go to `events.quota_window` and `events.quota_resets_at_utc`; `logged_limit_hits` prefers them over the text and labels each value `log_field` or `log_text`. An unrecognized value is reported as `unusable_quota_field`, never mapped to a known window, and a field that disagrees with the text is reported (`quota_window_disagrees`, `quota_reset_disagrees`) while the field still wins.
- **Mid-task vs turn boundary (D-021):** decided by the hit's parent (`parentUuid` in the same session), not by line order. A parent tool result means mid-task, a non-meta prompt means turn start, and anything else is unknown. `parsed_lines` keeps `uuid`, `parent_uuid`, `origin_kind`, `user_content`, and `is_meta` for this. They aren't part of `expected.json`.
- **Resumption (D-022):** the next request in the session, plus the next prompt's `origin.kind` as written. Nothing is labeled automatic until a post-install hit shows how auto-resume is logged.

## 7. Repository attribution (D-010)

- **Resolve each distinct `cwd` once:** `git -C <cwd> rev-parse --git-common-dir`, then take its parent directory.
- **Fallback labels:** "not a git repo", or "path no longer exists" when the directory is gone. Keep the path either way.
- **Re-check every run (D-028):** a cached directory whose own existence, or its root's, has changed is resolved again. A missing directory takes its last git-verified root, else the repository of its nearest existing parent folder (`resolved_via` records which). A repository row counts as a repository while its root exists.
- **Attribute per request, not per session.**

## 8. The ingest report

It's a table, not console output. One row per `(run, class or problem, source_path)` with a count and a sample of raw bytes. The viewer shows the totals. Log messages go to stderr; stdout carries data only, because haasonsaas mixed the two and corrupted `--json`.

## Fixtures every ingest change must pass

Synthetic only, never copied from real logs (they contain prompts and paths). Each fixture has a hand-computed expected result.

1. One response streamed as 3 lines with rising `output_tokens` → one request, final output count.
2. The same response split across two ingest runs (stop mid-stream) → still the final count.
3. A trailing line with no newline, completed before the second run → counted once.
4. A `/btw` replay: same `message.id`, new `requestId`, `isSidechain: true` → one request.
5. Missing `message.id`; missing `requestId`; missing both → fallback, fallback, unkeyed plus reported.
6. A mixed-model session → tokens split per model.
7. A session crossing local midnight → tokens in two days.
8. A `<synthetic>` `rate_limit` line → one limit event, zero requests, zero tokens.
9. A `server_error` synthetic line → an api_error event, not a limit hit.
10. A malformed line → reported with raw bytes; its neighbors still ingest.
11. A subagent file under `subagents/` → included, `is_sidechain = 1`, same session.
12. A file truncated and rewritten → re-read, identical derived tables.
13. The same logs ingested twice → a byte-identical fingerprint of every derived table.
14. A worktree `cwd` and the main-clone `cwd` of one repo → one repository.
15. A `system`/`api_error` retry notice with `error.status` 429 → one retry_notice event, zero limit hits (D-019).
16. Limit hits with `quotaLimits` agreeing with the text, disagreeing with it, unusable, `null`, and absent → the field where recognized, the text otherwise, each problem reported (D-067; fixture case 20).
