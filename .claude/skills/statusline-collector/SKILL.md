---
name: statusline-collector
description: Build or change the status line hook script and the `init` command that registers it in Claude Code's settings.json. Use when touching payload capture, the spool file, wrapping an existing statusLine, settings backup, idempotent install/uninstall, or rate_limits validation.
---

# Status line collector and `init`

Decisions: D-008 (spool file, never fail), D-009 (payload is the only source of subscription state), D-004 (limit hits also come from logs). Payload field reference: https://code.claude.com/docs/en/statusline. Re-check it before relying on a field, since the payload is not a stable API.

## The hook: what runs every turn

Claude Code runs the `statusLine.command` after each assistant turn, with JSON on stdin. The hook has one job, and a failure must never break the user's status bar.

**Payload facts seen in real data (2026-09-13 to 15, D-024, D-044):**
- **Values:** `used_percentage` comes in whole-number steps (sometimes float noise like `7.000000000000001`), and `resets_at` is stable within a window.
- **`rate_limits` are the numbers from the session's last API response.** Re-renders (a `refreshInterval` timer, a window reset, `/compact`) repeat them unchanged. An idle session with a 60 s refresh recorded identical readings for hours while other sessions made over a hundred requests, and after a reset it showed no 5-hour window at all until its next request.
- **So a reading is dated by the API response behind it, not by capture** (D-044, D-045). That response is the latest request line in its session inside the window, identified by its D-001 key and dated by its first streaming line. Readings of one response collapse to one observation in `window_readings`, including readings captured while the response was still streaming. A refresh timer can't make an idle terminal record other sessions' usage.

**Only the terminal client runs it** (D-029). *Observed (2026-09-13, 2.1.269–2.1.270):* the VS Code extension never ran the hook. When checking that the collector works, use a terminal `claude` session. An empty spool after extension-only use is expected, not a hook failure.

**The hook is a POSIX `sh` script, not Node** (D-018). Minimal Node added 118 ms per turn at p95; the shell version adds 39 ms, and it doesn't depend on which `node` is on Claude Code's PATH.

1. **Copy stdin to a temp file:** `mktemp`, then `cat > "$tmp"`, with `trap 'rm -f "$tmp"' EXIT`. Don't use `$(cat)`: command substitution strips trailing newlines, so the payload would no longer be byte-exact.
2. **If a wrapped command is configured,** run `sh -c "<command>" < "$tmp"`. Its stdout, stderr, and exit code pass through **unchanged**. This happens first, so a slow append can't delay the status bar.
3. **Append one line to the spool:** `{"captured_at_s":<epoch seconds>,"hook_version":N,"payload_b64":"<base64 of the exact stdin bytes>"}`.
   - **Base64** means no JSON escaping in shell, and invalid or binary stdin is still recorded exactly. Ingest decodes it and reports anything that isn't JSON.
   - **Redirect the whole append block's stderr,** including the `>>` itself. A failing redirection writes to stderr otherwise (P0.3a spike).
4. **Never fail.** Exit with the wrapped command's code, or 0 when there's none. An append failure changes neither stdout nor the exit code.

**Owner-only (D-043):** the hook sets `umask 077`, so the temp file, data directory, spool, and error log are private. It refuses to append through a symlinked spool or error log. Code paths create the database 0600 before SQLite opens it (SQLite copies that mode to `-wal` and `-shm`), and existing installs are tightened on the next `ingest`, `report`, `explain`, or `plan-price`.

What the hook does *not* do: parse `rate_limits`, validate, touch SQLite, use the network, or print anything of its own when wrapping.

**Implementation:** `hooks/statusline.sh <data-dir>`. The data directory holds:

| File | Written by | Purpose |
|---|---|---|
| `wrapped-command` | `init` | the user's original `statusLine.command`, run as `/bin/sh -c` |
| `statusline.spool.jsonl` | hook | one line per turn |
| `hook-errors.log` | hook | `<epoch s> append-failed` or `<epoch s> spool-symlink-refused`, one line per failed or refused append; audits count these |

With no `wrapped-command`, the hook prints the payload's `model.display_name`, or nothing. With no temp file available, it `exec`s the wrapped command on stdin and records nothing, because the status bar wins.

- **Spool path:** under the tool's data directory, never inside `~/.claude`.
- **Writes:** one line per turn, ending in a single `\n`. Under concurrent sessions a long line may interleave; ingest reports it as malformed and never repairs it.
- **Portability:** only POSIX `sh`, `mktemp`, `cat`, `date +%s`, `base64`, and `tr`. `base64` wraps lines on Linux and not on macOS, so always pipe through `tr -d '\n'`. `shellcheck` runs in the audit.
- **Windows (D-049):** Git for Windows supplies all of these, and Claude Code runs the command through Git Bash, where `/bin/sh` resolves. Node can't spawn `/bin/sh` there, so tests spawn `sh` from PATH. Single-quoted backslash paths in the command pass through intact. File modes don't exist, so the hook's `umask` has no effect.
- **Timestamps** are whole seconds (BSD `date` has no sub-second format). Readings within one second are ordered by spool line order.

## Ingesting the spool (validation happens here, not in the hook)

The spool uses the ingest pipeline's offset rules (see `ingest-session-logs`). For each reading:

| Check | On failure |
|---|---|
| spool line parses as JSON with `captured_at_s`, `hook_version`, `payload_b64` | line stored raw, `malformed` in ingest report (includes interleaved lines) |
| `payload_b64` decodes | stored raw, `malformed_payload_encoding` in ingest report |
| decoded payload parses as JSON | reading stored raw, `malformed` in ingest report |
| `rate_limits` absent | normal: Pro/Max only, and only after the session's first API response. Stored as "no window data", **never** as 0 |
| a window (`five_hour`, `seven_day`) absent | that window **reset** or isn't reported (README). Don't carry the previous value forward |
| `used_percentage` finite and 0–100 | store raw, flag `invalid`. Don't clamp (Monitor clamps ≤101 to 100) |
| `used_percentage` looks like an epoch (> 1e9) | flag `invalid_epoch_in_percentage` (Claude Code bug #52326, reported via Monitor) |
| `resets_at` is a plausible epoch | store raw, flag |
| `spend_limit` window present | store; not used for personal plans |

- **Keep `session_id` and `transcript_path`** on every reading. They link a reading to its session log, and Monitor throws them away.
- **Keep `cost.total_cost_usd`** as a cross-check column only. CLAUDE.md: never a source.
- **Never overwrite.** Every reading is a row; "current state" is a query (Monitor's single `latest.json` has no history).
- **Identical lines collapse.** Spool lines follow raw-line identity (D-002): two byte-identical readings, meaning the same payload captured in the same second, are stored once. They carry identical information, so no metric changes. Don't count raw spool lines as "turns".

## `init`: registering the hook without clobbering

`settings.json` belongs to the user. Every write is reversible and repeatable.

1. **Locate the settings file.** Use user settings (`~/.claude/settings.json`) unless a flag says otherwise. Don't create project-level settings.
2. **Back up first.** Copy to `settings.json.bak-<timestamp>` before any write, and print the backup path.
3. **Parse, don't regex.** If the file isn't valid JSON, stop and report it. Never "fix" it.
4. **Decide from the existing `statusLine`:**
   - **Absent:** install our hook with the minimal default status output.
   - **Present and not ours:** record its exact `command` (and `padding` etc.) in the tool's config as the wrapped command, then point `statusLine.command` at our hook.
   - **Already ours:** do nothing and say so. Detect this by an explicit marker, e.g. the command path resolving to our hook binary. **Running `init` twice must not wrap the wrapper.**
5. **Write atomically:** write a temp file in the same directory, then rename. Preserve key order and 2-space formatting where the JSON library allows, so the diff shows only `statusLine`.
6. **Backfill:** run a full log ingest (see `ingest-session-logs`). It's safe to repeat.
7. **Print what changed:** the old command, the new command, and the backup path.

**`uninstall`** restores the wrapped command exactly, or removes `statusLine` if there was none. It doesn't delete the database or the spool.

## Tests

- `init` on: no settings file · settings without `statusLine` · settings with a custom `statusLine` · settings already wrapped · invalid JSON. Assert the resulting file and the backup exist.
- `init` → `init` → `uninstall` leaves `settings.json` byte-identical to the original, apart from formatting the JSON library can't preserve (document that exception in the test).
- The wrapped command's stdout passes through byte for byte, including ANSI escapes and multiple lines.
- The hook with invalid stdin, an unwritable spool, or a wrapped command that exits 1: the status bar output and exit code match the wrapped command, and the hook itself never throws.
- Ingesting a spool line for each validation row above gives the listed outcome.
