#!/bin/sh
# nilometer status line hook.
#
# Claude Code runs the configured statusLine command after every assistant turn and passes a JSON
# payload on stdin. This script is a passive tap on that hook (README § How it works, D-008, D-018):
#
#   1. Copy stdin to a temp file, so the exact bytes survive both uses below.
#   2. Run the user's original status line command, if `init` recorded one, on those bytes.
#      Its stdout, stderr, and exit code pass through unchanged. With no original command,
#      print a minimal default.
#   3. Append one spool line:
#        {"captured_at_s":<epoch seconds>,"hook_version":1,"payload_b64":"<base64 of stdin>"}
#
# Never parse or validate the payload (that happens at ingest), never touch SQLite, never use
# the network, and never let a failure of this script change what the status bar shows.
#
# Usage: statusline.sh <data-dir>
#   <data-dir>/wrapped-command          optional: the original statusLine command, written by `init`
#   <data-dir>/statusline.spool.jsonl   one line appended per run
#   <data-dir>/hook-errors.log          one line per failed or refused append (error kind only, no payload)
#
# Everything this script creates is owner-only (umask 077): the spool holds status line payloads,
# and Claude Code keeps its own transcripts owner-only too (D-043). It refuses to append through a
# symbolic link, so a link planted at the spool path can't redirect payloads elsewhere.
#
# POSIX sh only, plus mktemp, cat, date, base64, tr, sed, head (D-018, portability).

# Version of the spool line format. Bump it when the line shape changes, so ingest can tell.
HOOK_VERSION=1

# Files and directories created below (temp file, data dir, spool, error log) are owner-only (D-043).
umask 077

# The data directory is the only argument. Without it there is nowhere to record; still pass through.
data_dir=${1:-}

# Read the original command before touching stdin. $(cat) strips trailing newlines, harmless for a
# shell command string (unlike the payload).
#
# A symlink here is refused (D-050): this file's contents are executed, so following a link would run
# a command from a file Nilometer doesn't own. `init` only ever writes a regular file.
wrapped=""
if [ -n "$data_dir" ] && [ -L "$data_dir/wrapped-command" ]; then
  if [ ! -L "$data_dir/hook-errors.log" ]; then
    { printf '%s wrapped-command-symlink-refused\n' "$(date +%s)" >>"$data_dir/hook-errors.log"; } 2>/dev/null
  fi
elif [ -n "$data_dir" ] && [ -f "$data_dir/wrapped-command" ]; then
  wrapped=$(cat "$data_dir/wrapped-command" 2>/dev/null) || wrapped=""
fi

# The temp file lets one stdin feed both the wrapped command and the spool, byte-exact.
# Command substitution would strip trailing newlines from the payload (P0.3a spike).
tmp=$(mktemp "${TMPDIR:-/tmp}/nilometer-hook.XXXXXX" 2>/dev/null) || tmp=""
if [ -z "$tmp" ]; then
  # No temp file means no way to both pass the payload on and record it. The status bar wins.
  if [ -n "$wrapped" ]; then
    exec /bin/sh -c "$wrapped"
  fi
  exit 0
fi
# Remove the temp file however the script ends; a signal exits non-zero after cleanup.
trap 'rm -f "$tmp"' EXIT
trap 'rm -f "$tmp"; exit 1' HUP INT TERM

cat >"$tmp"

status=0
if [ -n "$wrapped" ]; then
  # statusLine.command is a shell string, so it runs under /bin/sh -c, as a shell-spawned command
  # would. Its output streams straight through; nothing here reads or alters it.
  /bin/sh -c "$wrapped" <"$tmp"
  status=$?
else
  # Minimal default: the model's display name, if present. Best-effort text extraction; printing
  # nothing is an acceptable result, and parsing JSON properly is ingest's job, not the hook's.
  sed -n 's/.*"display_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$tmp" 2>/dev/null | head -n 1
fi

if [ -n "$data_dir" ] && [ -L "$data_dir/statusline.spool.jsonl" ]; then
  # A symlinked spool could send payloads to a file Nilometer doesn't own: record the refusal, skip
  # the append, and leave the status bar untouched. Never log through a symlinked error log either.
  if [ ! -L "$data_dir/hook-errors.log" ]; then
    { printf '%s spool-symlink-refused\n' "$(date +%s)" >>"$data_dir/hook-errors.log"; } 2>/dev/null
  fi
elif [ -n "$data_dir" ]; then
  # Build the whole line first so it reaches the spool as one write: concurrent sessions append
  # to the same file, and a line written in pieces can interleave with another hook's line (D-069).
  line="{\"captured_at_s\":$(date +%s),\"hook_version\":$HOOK_VERSION,\"payload_b64\":\"$(base64 <"$tmp" | tr -d '\n')\"}"
  # printf writes a long line in 2048-byte pieces (bash 3.2 as /bin/sh on macOS, observed), and real
  # lines run 2.5 to 3.5 KB. cat copies a small file with one write, so the line goes into the temp
  # file first and cat appends it. The temp file is reused: the wrapped command has finished with
  # the payload and $line holds its base64, so there's no second temp file to create or clean up.
  # The outer 2>/dev/null must wrap the redirections: a failing `>>` reports its error before any
  # redirection written after it takes effect (P0.3a spike). mkdir runs only when the dir is missing.
  if ! { { [ -d "$data_dir" ] || mkdir -p "$data_dir"; } && printf '%s\n' "$line" >"$tmp" && cat "$tmp" >>"$data_dir/statusline.spool.jsonl"; } 2>/dev/null; then
    # Record the failure where the audit can count it. If even this fails, stay silent.
    if [ ! -L "$data_dir/hook-errors.log" ]; then
      { printf '%s append-failed\n' "$(date +%s)" >>"$data_dir/hook-errors.log"; } 2>/dev/null
    fi
  fi
fi

# The wrapped command's exit code is the hook's exit code; appending never changes it.
exit "$status"
