#!/usr/bin/env python3
"""Independent reference implementation of session-log ingestion rules.

This module computes, from a fixture case directory, the same result object
that a hand-written ``expected.json`` holds. It exists so the fidelity suite
can compare the TypeScript loader against a second implementation that cannot
share code or mistakes with it (D-017: Python 3.12, standard library only).

It implements the rules written in ``fixtures/README.md``, which restate:

- D-001: dedup key ``(sessionId, message.id)`` with a ``requestId`` fallback,
  unkeyed pass-through, and the largest-record winner rule.
- D-004: limit hits from the structured ``error`` field, with best-effort
  window and reset parsing from message text.
- D-017: this implementation's existence and independence.
- D-019: ``system``/``api_error`` lines as a ``retry_notice`` class.

Where the README is silent, the choice made is written next to the code that
makes it, so a disagreement with the loader can be traced to a rule.

Usage::

    python3 scripts/fidelity/reference.py <case-dir>
    python3 scripts/fidelity/reference.py --check <fixtures-root>
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, TextIO

# The seven classes, in the README's rule order. This order is also the key
# order of ``report.lines``.
CLASSES = (
    "malformed",
    "limit_hit",
    "api_error",
    "synthetic_other",
    "request",
    "retry_notice",
    "ignored_type",
)

# Classes that produce one event per line (README "Events": classes 2, 3, 4, 6).
EVENT_CLASSES = ("limit_hit", "api_error", "synthetic_other", "retry_notice")

# The three token fields that are reported when missing, as
# (output field, log field). The report names them by their log field.
REPORTED_TOKEN_FIELDS = (
    ("input_tokens", "input_tokens"),
    ("output_tokens", "output_tokens"),
    ("cache_read_tokens", "cache_read_input_tokens"),
)

# Fields summed in ``totals_by_model`` and ``totals_by_day_utc``, after the
# ``requests`` count.
TOTAL_TOKEN_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_5m_tokens",
    "cache_write_1h_tokens",
    "cache_write_unsplit_tokens",
)

# README: "YYYY-MM-DDTHH:MM:SS, an optional .fraction, then Z or ±HH:MM".
# [0-9] rather than \d, because \d also matches non-ASCII digits in Python.
TIMESTAMP_PATTERN = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})"
    r"T([0-9]{2}):([0-9]{2}):([0-9]{2})"
    r"(?:\.[0-9]+)?"
    r"(Z|[+-][0-9]{2}:[0-9]{2})"
)

# Written in place of an identity string that is absent or not a string.
MISSING = "<missing>"

# Directory names of multi-run states, e.g. ``run-1``.
RUN_DIR_PATTERN = re.compile(r"run-([0-9]+)")


@dataclass
class LogLine:
    """One distinct complete line, identified by ``(file, SHA-256 of bytes)``.

    Attributes:
        file: Path relative to the state directory, with ``/`` separators.
        run: 1-based index of the run in which the line was first seen.
        line: 1-based line number where the line was first seen.
        obj: The parsed JSON object, or None when the line is malformed.
        cls: The line's class, one of ``CLASSES``.
    """

    file: str
    run: int
    line: int
    obj: dict[str, Any] | None
    cls: str

    def order_key(self) -> tuple[str, int, int]:
        """Return the README ordering key ``(file, first run, line)``.

        Python compares ``str`` by code point, which is the same order as
        comparing UTF-8 bytes, so this is the README's byte-wise order.

        Returns:
            A tuple that sorts lines into README order.
        """
        return (self.file, self.run, self.line)


# ---------------------------------------------------------------------------
# Small value helpers
# ---------------------------------------------------------------------------


def is_number(value: Any) -> bool:
    """Tell whether a parsed JSON value is a JSON number.

    Args:
        value: Any value produced by ``json.loads``.

    Returns:
        True for int and float values. False for everything else, including
        booleans, which Python treats as ints but JSON does not.
    """
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_non_empty_string(value: Any) -> bool:
    """Tell whether a value is a string with at least one character.

    Args:
        value: Any parsed JSON value.

    Returns:
        True only for a non-empty ``str``.
    """
    return isinstance(value, str) and value != ""


def get_object(container: Any, key: str) -> dict[str, Any] | None:
    """Return ``container[key]`` when both are JSON objects.

    Args:
        container: A parsed JSON value, expected to be a dict.
        key: The member name to look up.

    Returns:
        The member when ``container`` is a dict and the member is a dict,
        otherwise None. Arrays and null are not objects.
    """
    if not isinstance(container, dict):
        return None
    value = container.get(key)
    return value if isinstance(value, dict) else None


def identity_string(value: Any) -> str:
    """Apply the README's "missing identity strings" rule.

    Used for ``sessionId``, ``message.model``, ``type``, and ``error`` (in
    ``unknown_error_values``) wherever they become a value, key, or label.

    Args:
        value: A parsed JSON value, or None for an absent member.

    Returns:
        The value itself when it is a string, otherwise ``"<missing>"``.
    """
    return value if isinstance(value, str) else MISSING


def contains_ignoring_case(text: str, phrase: str) -> int:
    """Find a phrase in text, ignoring ASCII letter case.

    Args:
        text: The text to search.
        phrase: The literal phrase to look for.

    Returns:
        The index just past the first match, or -1 when there is none.
    """
    # re.ASCII limits case folding to A-Z/a-z. Without it Python's re also
    # folds characters such as U+017F (long s) to "s", which a JavaScript
    # /.../i regex does not, and lowercasing the whole text could change its
    # length for some non-ASCII characters and shift the index.
    match = re.search(re.escape(phrase), text, re.IGNORECASE | re.ASCII)
    return match.end() if match else -1


# ---------------------------------------------------------------------------
# Reading
# ---------------------------------------------------------------------------


def list_jsonl_files(state_dir: str) -> list[str]:
    """List every ``*.jsonl`` file under ``<state_dir>/projects`` at any depth.

    Args:
        state_dir: The state directory (a case directory for single-state
            cases, or a ``run-N`` directory).

    Returns:
        Paths relative to ``state_dir`` with ``/`` separators, sorted
        byte-wise. A missing ``projects/`` yields an empty list.
    """
    found: list[str] = []
    projects_dir = os.path.join(state_dir, "projects")
    for dirpath, _dirnames, filenames in os.walk(projects_dir):
        for name in filenames:
            if not name.endswith(".jsonl"):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, state_dir)
            # Normalise separators so the same file has the same ``file``
            # value on every platform and in every run.
            found.append(rel.replace(os.sep, "/"))
    # Sorting the UTF-8 bytes of the whole path, not path components, puts
    # ``s11.jsonl`` ('.' is 0x2E) before ``s11/subagents/...`` ('/' is 0x2F).
    found.sort(key=lambda p: p.encode("utf-8"))
    return found


def split_complete_lines(data: bytes) -> list[bytes]:
    """Split file contents into complete, ``\\n``-terminated lines.

    Args:
        data: The raw bytes of a file.

    Returns:
        The bytes of each complete line without its terminating ``\\n``. A
        trailing fragment with no ``\\n`` is not yet complete and is dropped.
    """
    parts = data.split(b"\n")
    # The last element is whatever follows the final "\n": empty when the file
    # ends with a newline, or an incomplete fragment otherwise. Either way it
    # is not a complete line.
    return parts[:-1]


def reject_json_constant(name: str) -> Any:
    """Refuse ``NaN``, ``Infinity`` and ``-Infinity`` while parsing JSON.

    Python's ``json`` accepts these by default, but they are not JSON, and a
    JavaScript loader's ``JSON.parse`` rejects them.

    Args:
        name: The constant the parser found.

    Returns:
        Never returns.

    Raises:
        ValueError: always.
    """
    raise ValueError(f"non-standard JSON constant {name}")


def parse_json_object(raw: bytes) -> dict[str, Any] | None:
    """Parse one line as a JSON object.

    Args:
        raw: The line's bytes, without the terminating newline.

    Returns:
        The parsed object, or None when the bytes are not valid UTF-8, not
        valid JSON, or valid JSON that is not an object.
    """
    try:
        # Strict UTF-8: json.loads(bytes) would also guess UTF-16/32, and a
        # BOM stays in the text so it is rejected like JSON.parse would.
        text = raw.decode("utf-8")
        value = json.loads(text, parse_constant=reject_json_constant)
    except (UnicodeDecodeError, ValueError, RecursionError):
        # JSONDecodeError is a ValueError. RecursionError covers absurdly deep
        # nesting, which is still "not valid JSON" for our purposes.
        return None
    return value if isinstance(value, dict) else None


def classify(obj: dict[str, Any] | None) -> str:
    """Classify one line; the first matching README rule wins.

    Args:
        obj: The parsed line, or None when it did not parse as an object.

    Returns:
        One of ``CLASSES``.
    """
    if obj is None:
        return "malformed"
    # "=== true" means the JSON literal true only; `is True` excludes 1 and
    # the string "true".
    is_api_error = obj.get("isApiErrorMessage") is True
    if is_api_error and obj.get("error") == "rate_limit":
        return "limit_hit"
    if is_api_error:
        return "api_error"
    message = get_object(obj, "message")
    if message is not None and message.get("model") == "<synthetic>":
        return "synthetic_other"
    if obj.get("type") == "assistant" and get_object(message, "usage") is not None:
        return "request"
    if obj.get("type") == "system" and obj.get("subtype") == "api_error":
        return "retry_notice"
    return "ignored_type"


class LineStore:
    """The cumulative set of distinct lines seen across runs (D-002).

    Lines are append-only: once seen, a line stays, even if a later run's
    file no longer contains it.
    """

    def __init__(self) -> None:
        """Create an empty store."""
        # (file, sha256 hex) -> LogLine. The first sighting is kept.
        self.lines: dict[tuple[str, str], LogLine] = {}

    def ingest_state(self, state_dir: str, run: int) -> None:
        """Add every complete line under one state directory.

        Args:
            state_dir: The directory holding ``projects/``.
            run: The 1-based run index recorded for newly seen lines.

        Raises:
            OSError: when a file cannot be read.
        """
        for rel in list_jsonl_files(state_dir):
            with open(os.path.join(state_dir, rel), "rb") as handle:
                data = handle.read()
            for index, raw in enumerate(split_complete_lines(data)):
                identity = (rel, hashlib.sha256(raw).hexdigest())
                if identity in self.lines:
                    # Same bytes in the same file: one line, and it keeps the
                    # run and line number where it was first seen.
                    continue
                obj = parse_json_object(raw)
                self.lines[identity] = LogLine(
                    file=rel, run=run, line=index + 1, obj=obj, cls=classify(obj)
                )

    def sorted_lines(self) -> list[LogLine]:
        """Return every distinct line in README order.

        Returns:
            Lines sorted by ``(file, first run, line)``.
        """
        return sorted(self.lines.values(), key=LogLine.order_key)


# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------


def parse_utc_day(raw: Any) -> str | None:
    """Return the UTC calendar day of a timestamp, if it parses.

    Args:
        raw: The raw ``timestamp`` value from a line (any JSON value).

    Returns:
        ``YYYY-MM-DD`` in UTC, or None when the value is not a string, does
        not match the README pattern, or names an impossible date or time.
    """
    if not isinstance(raw, str):
        return None
    # fullmatch, because re's `$` would also accept a trailing "\n".
    match = TIMESTAMP_PATTERN.fullmatch(raw)
    if match is None:
        return None
    year, month, day, hour, minute, second = (int(g) for g in match.groups()[:6])
    zone = match.group(7)
    try:
        if zone == "Z":
            offset = timedelta(0)
        else:
            offset_hours, offset_minutes = int(zone[1:3]), int(zone[4:6])
            if offset_hours > 23 or offset_minutes > 59:
                # The pattern allows any two digits; the README requires
                # offset hour 00-23 and minute 00-59.
                return None
            offset = timedelta(hours=offset_hours, minutes=offset_minutes)
            if zone[0] == "-":
                offset = -offset
        # datetime enforces the README's other ranges: a real calendar date,
        # hour 00-23, minute and second 00-59 (so no leap second 60).
        local = datetime(
            year, month, day, hour, minute, second, tzinfo=timezone(offset)
        )
        return local.astimezone(timezone.utc).date().isoformat()
    except (ValueError, OverflowError):
        return None


def dedup_key(obj: dict[str, Any]) -> str | None:
    """Compute a request line's D-001 dedup key.

    Args:
        obj: A parsed ``request`` line.

    Returns:
        ``<sessionId>/m/<message.id>`` when ``message.id`` is a non-empty
        string, else ``<sessionId>/r/<requestId>`` when ``requestId`` is, else
        None (unkeyed).
    """
    message = get_object(obj, "message") or {}
    session = identity_string(obj.get("sessionId"))
    if is_non_empty_string(message.get("id")):
        return f"{session}/m/{message['id']}"
    if is_non_empty_string(obj.get("requestId")):
        return f"{session}/r/{obj['requestId']}"
    return None


def extract_request(line: LogLine) -> tuple[dict[str, Any], list[str]]:
    """Build the output record for one ``request`` line.

    Args:
        line: A line whose class is ``request``.

    Returns:
        A pair of the request record (keys in README order) and the log names
        of token fields that were missing or non-numeric and defaulted to 0.
    """
    obj = line.obj or {}
    message = get_object(obj, "message") or {}
    usage = get_object(message, "usage") or {}

    missing: list[str] = []
    tokens: dict[str, Any] = {}
    for out_name, log_name in REPORTED_TOKEN_FIELDS:
        value = usage.get(log_name)
        if is_number(value):
            tokens[out_name] = value
        else:
            tokens[out_name] = 0
            missing.append(log_name)

    cache_creation = get_object(usage, "cache_creation")
    if cache_creation is not None:
        # Split form: the object is authoritative and the unsplit total is
        # ignored, so the two forms are never added together.
        write_5m = cache_number(cache_creation.get("ephemeral_5m_input_tokens"))
        write_1h = cache_number(cache_creation.get("ephemeral_1h_input_tokens"))
        write_unsplit = None
    else:
        write_5m = None
        write_1h = None
        write_unsplit = cache_number(usage.get("cache_creation_input_tokens"))

    record = {
        "dedup_key": dedup_key(obj),
        "file": line.file,
        "line": line.line,
        # sessionId and message.model are identity strings: "<missing>" when
        # absent or not a string, so values match the keys built from them.
        "session_id": identity_string(obj.get("sessionId")),
        "message_id": message.get("id"),
        "request_id": obj.get("requestId"),
        "model": identity_string(message.get("model")),
        "timestamp": obj.get("timestamp"),
        "is_sidechain": obj.get("isSidechain") is True,
        "cwd": obj.get("cwd"),
        "input_tokens": tokens["input_tokens"],
        "output_tokens": tokens["output_tokens"],
        "cache_read_tokens": tokens["cache_read_tokens"],
        "cache_write_5m_tokens": write_5m,
        "cache_write_1h_tokens": write_1h,
        "cache_write_unsplit_tokens": write_unsplit,
    }
    return record, missing


def cache_number(value: Any) -> Any:
    """Default a cache-write token value to 0 silently.

    Args:
        value: The raw log value, possibly missing.

    Returns:
        The value when it is a JSON number, else 0. Booleans, strings, and
        null are non-numeric; unlike the three reported token fields, a
        cache-write field defaulted to 0 is not reported.
    """
    return value if is_number(value) else 0


def is_better_winner(
    candidate: tuple[dict[str, Any], LogLine],
    current: tuple[dict[str, Any], LogLine],
) -> bool:
    """Tell whether ``candidate`` beats ``current`` for the same dedup key.

    Args:
        candidate: A (request record, line) pair.
        current: The (request record, line) pair currently winning.

    Returns:
        True when the candidate has larger ``output_tokens``; or equal output
        and is the non-sidechain copy while current is a sidechain; or equal on
        both and carries the earlier timestamp; or equal on all three and comes
        later in ``(file, first run, line)`` order.
    """
    cand_rec, cand_line = candidate
    cur_rec, cur_line = current
    # Tokens were defaulted to 0 already, so they always compare.
    if cand_rec["output_tokens"] != cur_rec["output_tokens"]:
        return cand_rec["output_tokens"] > cur_rec["output_tokens"]
    if cand_rec["is_sidechain"] != cur_rec["is_sidechain"]:
        # "false before true": the non-sidechain copy wins.
        return not cand_rec["is_sidechain"]
    # Tied on tokens: the earliest line, when those numbers first existed (D-065).
    # A line whose timestamp did not parse never wins this on its own.
    cand_ts = cand_rec.get("timestamp")
    cur_ts = cur_rec.get("timestamp")
    if cand_ts != cur_ts:
        if cur_ts is None:
            return True
        if cand_ts is None:
            return False
        return cand_ts < cur_ts
    return cand_line.order_key() > cur_line.order_key()


def select_requests(
    request_lines: list[tuple[dict[str, Any], LogLine]],
) -> list[dict[str, Any]]:
    """Apply D-001 dedup to request records.

    Args:
        request_lines: Every (record, line) pair for ``request`` lines.

    Returns:
        The post-dedup requests: one winner per key plus every unkeyed
        request, sorted by ``(file, first run, line)``.
    """
    winners: dict[str, tuple[dict[str, Any], LogLine]] = {}
    kept: list[tuple[dict[str, Any], LogLine]] = []
    for pair in request_lines:
        key = pair[0]["dedup_key"]
        if key is None:
            # Unkeyed: never invent a key, pass through as its own request.
            kept.append(pair)
        elif key not in winners or is_better_winner(pair, winners[key]):
            winners[key] = pair
    kept.extend(winners.values())
    kept.sort(key=lambda pair: pair[1].order_key())
    return [record for record, _line in kept]


def empty_totals() -> dict[str, Any]:
    """Create a zeroed totals bucket.

    Returns:
        A dict with ``requests`` and every token field set to 0.
    """
    bucket: dict[str, Any] = {"requests": 0}
    for field in TOTAL_TOKEN_FIELDS:
        bucket[field] = 0
    return bucket


def add_to_totals(bucket: dict[str, Any], record: dict[str, Any]) -> None:
    """Add one request to a totals bucket, counting null fields as 0.

    Args:
        bucket: A bucket from ``empty_totals``, updated in place.
        record: A post-dedup request record.
    """
    bucket["requests"] += 1
    for field in TOTAL_TOKEN_FIELDS:
        value = record[field]
        bucket[field] += value if value is not None else 0


def compute_totals(
    requests: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Sum post-dedup requests by model and by UTC day then model.

    Args:
        requests: The post-dedup request records.

    Returns:
        ``(totals_by_model, totals_by_day_utc)``, with keys sorted. Requests
        whose timestamp does not parse are left out of the day totals only.
    """
    by_model: dict[str, Any] = {}
    by_day: dict[str, dict[str, Any]] = {}
    for record in requests:
        # Already "<missing>" for an absent or non-string model.
        model = record["model"]
        add_to_totals(by_model.setdefault(model, empty_totals()), record)
        day = parse_utc_day(record["timestamp"])
        if day is not None:
            day_models = by_day.setdefault(day, {})
            add_to_totals(day_models.setdefault(model, empty_totals()), record)
    # Sorted keys only make the printed output stable; comparison ignores it.
    sorted_by_model = {k: by_model[k] for k in sorted(by_model)}
    sorted_by_day = {
        day: {k: by_day[day][k] for k in sorted(by_day[day])} for day in sorted(by_day)
    }
    return sorted_by_model, sorted_by_day


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


def message_text(obj: dict[str, Any]) -> str:
    """Return the text of a line's ``message.content``.

    Args:
        obj: A parsed line.

    Returns:
        When ``content`` is a list, every string ``content[].text`` joined
        with no separator (entries that are not objects, or whose ``text`` is
        not a string, contribute nothing). When ``content`` is a string, that
        string. Otherwise the empty string.
    """
    message = get_object(obj, "message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for entry in content:
        if isinstance(entry, dict) and isinstance(entry.get("text"), str):
            parts.append(entry["text"])
    return "".join(parts)


def parse_limit_text(text: str) -> tuple[str | None, str | None]:
    """Parse the window and reset text of a limit-hit message (D-004).

    Args:
        text: The concatenated message text.

    Returns:
        ``(window, reset_text)``. ``window`` is ``five_hour`` when the text
        contains "session limit" or "5-hour limit", else ``seven_day`` when it
        contains "weekly limit", else None. ``reset_text`` is everything after
        the first ``resets `` to the end of the text, trimmed, or None when
        ``resets `` does not occur or nothing follows it. All matching ignores
        case.
    """
    # Checked in README order, so text naming both windows is five_hour.
    if (
        contains_ignoring_case(text, "session limit") != -1
        or contains_ignoring_case(text, "5-hour limit") != -1
    ):
        window = "five_hour"
    elif contains_ignoring_case(text, "weekly limit") != -1:
        window = "seven_day"
    else:
        window = None

    reset_text = None
    after_marker = contains_ignoring_case(text, "resets ")
    if after_marker != -1:
        # str.strip() with no argument trims all Unicode whitespace, like
        # JavaScript's String.prototype.trim.
        # An empty remainder is "nothing follows it", which is null too.
        reset_text = text[after_marker:].strip() or None
    return window, reset_text


def build_event(line: LogLine) -> dict[str, Any]:
    """Build the event record for a line of an event class.

    Args:
        line: A line whose class is in ``EVENT_CLASSES``.

    Returns:
        The event with ``class``, ``session_id``, ``timestamp``, ``file``,
        ``line``, ``error``, ``api_error_status``, ``window``, ``reset_text``.
    """
    obj = line.obj or {}
    error = obj.get("error")

    status = obj.get("apiErrorStatus")
    if is_number(status):
        # Checked first for every class, retry notices included.
        api_error_status = status
    elif line.cls == "retry_notice" and isinstance(error, dict) and is_number(
        error.get("status")
    ):
        # Retry notices carry the HTTP status inside the error object (D-019).
        api_error_status = error["status"]
    else:
        api_error_status = None

    if line.cls == "limit_hit":
        window, reset_text = parse_limit_text(message_text(obj))
    else:
        window, reset_text = None, None

    return {
        "class": line.cls,
        "session_id": identity_string(obj.get("sessionId")),
        "timestamp": obj.get("timestamp"),
        "file": line.file,
        "line": line.line,
        # For retry notices error is an object, so this is null.
        "error": error if isinstance(error, str) else None,
        "api_error_status": api_error_status,
        "window": window,
        "reset_text": reset_text,
    }


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def ignored_type_key(obj: dict[str, Any] | None) -> str:
    """Return the ``ignored_types`` key for an ignored line.

    Args:
        obj: A parsed ``ignored_type`` line.

    Returns:
        ``type``, or ``type/subtype`` when ``subtype`` is a string. An absent
        or non-string ``type`` is ``"<missing>"``.
    """
    obj = obj or {}
    base = identity_string(obj.get("type"))
    subtype = obj.get("subtype")
    # A non-string subtype is not part of the label at all, so it never needs
    # the "<missing>" placeholder.
    if isinstance(subtype, str):
        return f"{base}/{subtype}"
    return base


def unknown_error_key(obj: dict[str, Any] | None) -> str | None:
    """Return the ``unknown_error_values`` key for an ``api_error`` line.

    Args:
        obj: A parsed ``api_error`` line.

    Returns:
        None when ``error`` is ``"server_error"`` (a known value); the string
        itself for any other string; ``"<missing>"`` when ``error`` is absent
        or not a string, explicit null included.
    """
    obj = obj or {}
    error = obj.get("error")
    if error == "server_error":
        return None
    return identity_string(error)


def has_retry_rate_limits(obj: dict[str, Any] | None) -> bool:
    """Tell whether a retry notice carries a non-null ``error.rateLimits``.

    Args:
        obj: A parsed ``retry_notice`` line.

    Returns:
        True only when ``error`` is an object that has a ``rateLimits`` member
        whose value is not null. Any non-null value counts, ``{}`` included;
        an absent member does not.
    """
    error = get_object(obj, "error")
    return error is not None and "rateLimits" in error and error["rateLimits"] is not None


def sorted_counts(counts: dict[str, int]) -> dict[str, int]:
    """Return a count dict with keys in sorted order for stable printing.

    Args:
        counts: Any str-keyed dict.

    Returns:
        A new dict with the same items, keys sorted.
    """
    return {key: counts[key] for key in sorted(counts)}


# ---------------------------------------------------------------------------
# Building a state result
# ---------------------------------------------------------------------------


def build_result(lines: list[LogLine]) -> dict[str, Any]:
    """Compute one state's result object from its distinct lines.

    Args:
        lines: Every distinct line in ``(file, first run, line)`` order.

    Returns:
        A dict with ``requests``, ``totals_by_model``, ``totals_by_day_utc``,
        ``events`` and ``report``, in the README's shape and key order.
    """
    line_counts = {cls: 0 for cls in CLASSES}
    malformed: list[dict[str, Any]] = []
    ignored_types: dict[str, int] = {}
    unknown_errors: dict[str, int] = {}
    missing_fields: list[dict[str, Any]] = []
    unparsed_timestamps: list[dict[str, Any]] = []
    non_message_iterations: list[dict[str, Any]] = []
    retry_rate_limits = 0
    unkeyed = 0
    request_lines: list[tuple[dict[str, Any], LogLine]] = []
    events: list[dict[str, Any]] = []

    # Lines are already in README order, so every list built by appending in
    # this loop is sorted too.
    for line in lines:
        line_counts[line.cls] += 1
        where = {"file": line.file, "line": line.line}

        if line.cls == "malformed":
            malformed.append(dict(where))
        elif line.cls == "ignored_type":
            key = ignored_type_key(line.obj)
            ignored_types[key] = ignored_types.get(key, 0) + 1
        elif line.cls == "request":
            record, missing = extract_request(line)
            request_lines.append((record, line))
            if record["dedup_key"] is None:
                unkeyed += 1
            # Per-line problems are reported for every request line, before
            # dedup, since the README attaches them to "request lines".
            for field in missing:
                missing_fields.append({**where, "field": field})
            if parse_utc_day(record["timestamp"]) is None:
                unparsed_timestamps.append({**where, "raw": record["timestamp"]})
            non_message_iterations.extend(iteration_problems(line, where))

        if line.cls in EVENT_CLASSES:
            events.append(build_event(line))
        if line.cls == "api_error":
            error_key = unknown_error_key(line.obj)
            if error_key is not None:
                unknown_errors[error_key] = unknown_errors.get(error_key, 0) + 1
        if line.cls == "retry_notice" and has_retry_rate_limits(line.obj):
            retry_rate_limits += 1

    requests = select_requests(request_lines)
    totals_by_model, totals_by_day = compute_totals(requests)
    return {
        "requests": requests,
        "totals_by_model": totals_by_model,
        "totals_by_day_utc": totals_by_day,
        "events": events,
        "report": {
            "lines": line_counts,
            "malformed": malformed,
            "ignored_types": sorted_counts(ignored_types),
            "unkeyed_requests": unkeyed,
            "unknown_error_values": sorted_counts(unknown_errors),
            "missing_fields": missing_fields,
            "unparsed_timestamps": unparsed_timestamps,
            "non_message_iterations": non_message_iterations,
            "retry_rate_limits_present": retry_rate_limits,
        },
    }


def iteration_problems(line: LogLine, where: dict[str, Any]) -> list[dict[str, Any]]:
    """List ``usage.iterations[]`` entries whose ``type`` isn't ``"message"``.

    Args:
        line: A ``request`` line.
        where: ``{"file", "line"}`` for the line.

    Returns:
        One ``{file, line, type}`` entry per offending iteration, in array
        order. ``type`` is the raw value, or None when the entry has none (or
        is not an object). A non-array ``iterations`` yields nothing.
    """
    message = get_object(line.obj, "message")
    usage = get_object(message, "usage") or {}
    iterations = usage.get("iterations")
    if not isinstance(iterations, list):
        return []
    problems = []
    for entry in iterations:
        entry_type = entry.get("type") if isinstance(entry, dict) else None
        if entry_type != "message":
            problems.append({**where, "type": entry_type})
    return problems


def run_dirs(case_dir: str) -> list[tuple[int, str]]:
    """Find a case's ``run-N`` directories in numeric order.

    Args:
        case_dir: The case directory.

    Returns:
        ``(N, name)`` pairs sorted by N, so ``run-10`` follows ``run-9``.
    """
    found = []
    for name in os.listdir(case_dir):
        match = RUN_DIR_PATTERN.fullmatch(name)
        if match and os.path.isdir(os.path.join(case_dir, name)):
            found.append((int(match.group(1)), name))
    found.sort()
    return found


def process_case(case_dir: str) -> dict[str, Any]:
    """Compute the full ``expected.json`` object for one case directory.

    Args:
        case_dir: A directory holding ``projects/`` or ``run-1/``, ``run-2/``...

    Returns:
        ``{"final": result}`` for a single-state case, or
        ``{"run-1": result, "run-2": result, ...}`` for a multi-run case where
        each result is cumulative over runs 1..N.

    Raises:
        OSError: when the directory or a log file cannot be read.
    """
    runs = run_dirs(case_dir)
    store = LineStore()
    if not runs:
        store.ingest_state(case_dir, run=1)
        return {"final": build_result(store.sorted_lines())}
    output: dict[str, Any] = {}
    for run_number, name in runs:
        # The store is not reset between runs: raw lines are append-only, so a
        # line removed by a rewrite still counts.
        store.ingest_state(os.path.join(case_dir, name), run=run_number)
        output[name] = build_result(store.sorted_lines())
    return output


# ---------------------------------------------------------------------------
# --check
# ---------------------------------------------------------------------------


def json_type(value: Any) -> str:
    """Name the JSON type of a parsed value.

    Args:
        value: A value produced by ``json.loads``.

    Returns:
        One of ``null``, ``boolean``, ``number``, ``string``, ``array``,
        ``object``.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        # Checked before numbers because bool is a subclass of int.
        return "boolean"
    if is_number(value):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return "object"


def diff_json(expected: Any, actual: Any, path: str = "$") -> list[str]:
    """Deep-compare two parsed JSON values and describe every difference.

    Plain ``==`` is not used on the whole tree because Python considers
    ``True == 1`` and ``False == 0``, which JSON does not. Numbers compare by
    value, so ``1`` equals ``1.0``. Object key order is ignored.

    Args:
        expected: The value from ``expected.json``.
        actual: The value computed by this implementation.
        path: The JSONPath-like location of these values, for messages.

    Returns:
        One human-readable line per differing path; empty when equal.
    """
    expected_type, actual_type = json_type(expected), json_type(actual)
    if expected_type != actual_type:
        return [f"{path}: expected {dump_short(expected)}, got {dump_short(actual)}"]
    if expected_type == "object":
        differences = []
        for key in sorted(set(expected) | set(actual)):
            child = f"{path}.{key}"
            if key not in actual:
                differences.append(f"{child}: missing (expected {dump_short(expected[key])})")
            elif key not in expected:
                differences.append(f"{child}: unexpected {dump_short(actual[key])}")
            else:
                differences.extend(diff_json(expected[key], actual[key], child))
        return differences
    if expected_type == "array":
        differences = []
        if len(expected) != len(actual):
            differences.append(
                f"{path}: expected {len(expected)} items, got {len(actual)}"
            )
        for index in range(min(len(expected), len(actual))):
            differences.extend(
                diff_json(expected[index], actual[index], f"{path}[{index}]")
            )
        for index in range(len(actual), len(expected)):
            differences.append(f"{path}[{index}]: missing {dump_short(expected[index])}")
        for index in range(len(expected), len(actual)):
            differences.append(f"{path}[{index}]: unexpected {dump_short(actual[index])}")
        return differences
    if expected != actual:
        return [f"{path}: expected {dump_short(expected)}, got {dump_short(actual)}"]
    return []


def dump_short(value: Any, limit: int = 200) -> str:
    """Render a JSON value compactly for a diff message.

    Args:
        value: Any parsed JSON value.
        limit: Maximum length before the text is truncated.

    Returns:
        Compact JSON text, truncated with ``...`` when longer than ``limit``.
    """
    text = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return text if len(text) <= limit else text[:limit] + "..."


def find_case_dirs(fixtures_root: str) -> list[str]:
    """List case directories directly under a fixtures root.

    Args:
        fixtures_root: The directory holding one subdirectory per case.

    Returns:
        Names of subdirectories containing ``projects/`` or ``run-1/``, sorted.
    """
    cases = []
    for name in sorted(os.listdir(fixtures_root)):
        path = os.path.join(fixtures_root, name)
        if not os.path.isdir(path):
            continue
        if os.path.isdir(os.path.join(path, "projects")) or os.path.isdir(
            os.path.join(path, "run-1")
        ):
            cases.append(name)
    return cases


def check_fixtures(fixtures_root: str, out: TextIO) -> int:
    """Run every case and compare it with its ``expected.json``.

    Args:
        fixtures_root: The directory holding the case directories.
        out: Where ``PASS``/``FAIL`` lines and diffs are written.

    Returns:
        0 when every case has an ``expected.json`` and matches it, else 1.
    """
    failed = False
    for name in find_case_dirs(fixtures_root):
        case_dir = os.path.join(fixtures_root, name)
        expected_path = os.path.join(case_dir, "expected.json")
        if not os.path.isfile(expected_path):
            failed = True
            out.write(f"FAIL {name}\n  no expected.json\n")
            continue
        with open(expected_path, encoding="utf-8") as handle:
            expected = json.load(handle)
        # Round-trip through JSON text so the comparison sees exactly what
        # the CLI would print, not Python-only values.
        actual = json.loads(json.dumps(process_case(case_dir)))
        differences = diff_json(expected, actual)
        if differences:
            failed = True
            out.write(f"FAIL {name}\n")
            for difference in differences:
                out.write(f"  {difference}\n")
        else:
            out.write(f"PASS {name}\n")
    return 1 if failed else 0


def main(argv: list[str], out: TextIO = sys.stdout, err: TextIO = sys.stderr) -> int:
    """Command-line entry point.

    Args:
        argv: Arguments after the program name: ``<case-dir>`` or
            ``--check <fixtures-root>``.
        out: Stream for data (result JSON or check lines).
        err: Stream for usage errors.

    Returns:
        The process exit code: 0 on success, 1 on a failed check, 2 on usage
        errors.
    """
    if len(argv) == 2 and argv[0] == "--check":
        return check_fixtures(argv[1], out)
    if len(argv) == 1 and not argv[0].startswith("--"):
        result = process_case(argv[0])
        out.write(json.dumps(result, indent=2, sort_keys=False, ensure_ascii=False))
        out.write("\n")
        return 0
    err.write(
        "usage: reference.py <case-dir>\n"
        "       reference.py --check <fixtures-root>\n"
    )
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
