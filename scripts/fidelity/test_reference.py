"""Unit tests for the reference implementation in ``reference.py``.

Each test class covers one group of rules in ``fixtures/README.md``. Inputs
are built inline in temporary directories; no fixture ``expected.json`` is
read. Run with::

    python3 -m unittest discover -s scripts/fidelity -p 'test_*.py' -v
"""

from __future__ import annotations

import ast
import io
import json
import os
import sys
import tempfile
import unittest
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import reference  # noqa: E402  (path set up above so discovery from any cwd works)

FILE = "projects/-p/s1.jsonl"


def dump(obj: Any) -> str:
    """Serialise a line object compactly, as Claude Code writes it.

    Args:
        obj: The line object.

    Returns:
        Compact JSON text without a newline.
    """
    return json.dumps(obj, separators=(",", ":"))


def assistant(
    output: Any = 10,
    message_id: Any = "msg_1",
    request_id: Any = "req_1",
    session: Any = "s1",
    model: Any = "claude-sonnet-5",
    timestamp: Any = "2026-09-01T10:00:00.000Z",
    sidechain: Any = False,
    usage: dict[str, Any] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """Build an assistant request line; ``None`` arguments omit the field.

    Args:
        output: ``usage.output_tokens``.
        message_id: ``message.id``.
        request_id: ``requestId``.
        session: ``sessionId``.
        model: ``message.model``.
        timestamp: ``timestamp``.
        sidechain: ``isSidechain``.
        usage: Replaces the default usage object entirely when given.
        **extra: Extra top-level members.

    Returns:
        The line object.
    """
    if usage is None:
        usage = {
            "input_tokens": 1,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 2,
            "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0},
            "iterations": [{"type": "message"}],
        }
        if output is not None:
            usage["output_tokens"] = output
    message: dict[str, Any] = {"type": "message", "role": "assistant", "usage": usage,
                               "content": [{"type": "text", "text": "hi"}]}
    if message_id is not None:
        message["id"] = message_id
    if model is not None:
        message["model"] = model
    line: dict[str, Any] = {"type": "assistant", "message": message, "cwd": "/w"}
    for key, value in (("requestId", request_id), ("sessionId", session),
                       ("timestamp", timestamp), ("isSidechain", sidechain)):
        if value is not None:
            line[key] = value
    line.update(extra)
    return line


def synthetic(text: str, error: Any = "rate_limit", status: Any = 429, **extra: Any) -> dict[str, Any]:
    """Build a ``<synthetic>`` API error line; ``None`` omits ``error``/status.

    Args:
        text: The single content text.
        error: Top-level ``error``.
        status: ``apiErrorStatus``.
        **extra: Extra top-level members.

    Returns:
        The line object.
    """
    line: dict[str, Any] = {
        "type": "assistant", "sessionId": "s1", "timestamp": "2026-09-01T11:00:00.000Z",
        "isApiErrorMessage": True,
        "message": {"model": "<synthetic>", "content": [{"type": "text", "text": text}],
                    "usage": {"input_tokens": 0, "output_tokens": 0}},
    }
    if error is not None:
        line["error"] = error
    if status is not None:
        line["apiErrorStatus"] = status
    line.update(extra)
    return line


def retry(status: Any = 429, rate_limits: Any = None, **extra: Any) -> dict[str, Any]:
    """Build a ``system``/``api_error`` retry notice line.

    Args:
        status: ``error.status``.
        rate_limits: ``error.rateLimits``.
        **extra: Extra top-level members.

    Returns:
        The line object.
    """
    line = {"type": "system", "subtype": "api_error", "sessionId": "s1",
            "timestamp": "2026-09-01T12:00:00.000Z",
            "error": {"status": status, "rateLimits": rate_limits}, "retryAttempt": 1}
    line.update(extra)
    return line


class CaseTestCase(unittest.TestCase):
    """Base class that builds case directories in a temporary directory."""

    def setUp(self) -> None:
        """Create a fresh temporary directory for the test."""
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name

    def tearDown(self) -> None:
        """Remove the temporary directory."""
        self._tmp.cleanup()

    def write(self, rel: str, content: str | bytes) -> None:
        """Write a file under the temporary root, creating directories.

        Args:
            rel: Path relative to the temporary root.
            content: Text (written as UTF-8) or bytes.
        """
        path = os.path.join(self.root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        data = content.encode("utf-8") if isinstance(content, str) else content
        with open(path, "wb") as handle:
            handle.write(data)

    def lines_text(self, *objs: Any) -> str:
        """Join line objects (or raw strings) into newline-terminated text.

        Args:
            *objs: Dicts are serialised; strings are used verbatim.

        Returns:
            The file text, every line terminated by ``\\n``.
        """
        return "".join((o if isinstance(o, str) else dump(o)) + "\n" for o in objs)

    def single(self, *objs: Any, rel: str = FILE) -> dict[str, Any]:
        """Run a single-state case with one file and return its ``final`` result.

        Args:
            *objs: Lines for the file.
            rel: The file path relative to the case directory.

        Returns:
            The ``final`` result object.
        """
        self.write(rel, self.lines_text(*objs))
        return reference.process_case(self.root)["final"]


class ReadingTests(CaseTestCase):
    """Reading, line numbering, trailing fragments, line identity, file order."""

    def test_trailing_fragment_is_ignored(self) -> None:
        """A fragment without a newline is neither counted nor malformed."""
        self.write(FILE, dump(assistant()) + "\n" + '{"type":"assis')
        result = reference.process_case(self.root)["final"]
        self.assertEqual(result["report"]["lines"]["malformed"], 0)
        self.assertEqual(sum(result["report"]["lines"].values()), 1)

    def test_complete_json_without_newline_is_still_a_fragment(self) -> None:
        """A complete JSON line with no terminating newline is still a fragment."""
        self.write(FILE, dump(assistant()))
        result = reference.process_case(self.root)["final"]
        self.assertEqual(result["requests"], [])
        self.assertEqual(sum(result["report"]["lines"].values()), 0)

    def test_line_numbers_are_one_based(self) -> None:
        """Line numbers count newline-terminated lines from 1."""
        result = self.single({"type": "user"}, assistant())
        self.assertEqual(result["requests"][0]["line"], 2)

    def test_empty_line_is_malformed(self) -> None:
        """An empty complete line is malformed and is still numbered."""
        result = self.single("", assistant(), "   ")
        self.assertEqual(result["report"]["malformed"],
                         [{"file": FILE, "line": 1}, {"file": FILE, "line": 3}])
        self.assertEqual(result["report"]["lines"]["malformed"], 2)
        self.assertEqual(result["requests"][0]["line"], 2)

    def test_repeated_empty_lines_count_once(self) -> None:
        """Empty lines have identical bytes, so they are one distinct line."""
        result = self.single("", "", {"type": "user"}, "")
        self.assertEqual(result["report"]["malformed"], [{"file": FILE, "line": 1}])
        self.assertEqual(result["report"]["lines"]["malformed"], 1)

    def test_lines_count_distinct_lines_per_class(self) -> None:
        """lines counts distinct lines; request repeats count once, not twice."""
        request = assistant()
        result = self.single(request, request, synthetic("x"), synthetic("x"), retry(), retry())
        self.assertEqual(result["report"]["lines"],
                         {"malformed": 0, "limit_hit": 1, "api_error": 0, "synthetic_other": 0,
                          "request": 1, "retry_notice": 1, "ignored_type": 0})
        self.assertEqual(len(result["events"]), 2)

    def test_identical_bytes_in_one_file_are_one_line(self) -> None:
        """Repeated bytes collapse to one line that keeps its first line number."""
        result = self.single({"type": "user"}, {"type": "user"}, "not json", "not json")
        self.assertEqual(result["report"]["lines"]["ignored_type"], 1)
        self.assertEqual(result["report"]["ignored_types"], {"user": 1})
        self.assertEqual(result["report"]["malformed"], [{"file": FILE, "line": 3}])

    def test_identical_bytes_in_different_files_are_distinct(self) -> None:
        """Line identity includes the file, so two files each count."""
        self.write("projects/-p/a.jsonl", self.lines_text({"type": "user"}))
        self.write("projects/-p/b.jsonl", self.lines_text({"type": "user"}))
        result = reference.process_case(self.root)["final"]
        self.assertEqual(result["report"]["ignored_types"], {"user": 2})

    def test_files_found_at_any_depth_in_bytewise_order(self) -> None:
        """Subagent files are read, and ``s1.jsonl`` sorts before ``s1/...``."""
        self.write("projects/-p/s1/subagents/a.jsonl",
                   self.lines_text(assistant(message_id="m2", sidechain=True)))
        self.write("projects/-p/s1.jsonl", self.lines_text(assistant(message_id="m1")))
        self.write("projects/-p/notes.txt", self.lines_text(assistant(message_id="m3")))
        result = reference.process_case(self.root)["final"]
        self.assertEqual([r["file"] for r in result["requests"]],
                         ["projects/-p/s1.jsonl", "projects/-p/s1/subagents/a.jsonl"])
        self.assertTrue(result["requests"][1]["is_sidechain"])

    def test_bytewise_sort_puts_uppercase_first(self) -> None:
        """Byte order, not case-insensitive order: ``B`` (0x42) before ``a``."""
        self.assertEqual(reference.list_jsonl_files(self._write_two()),
                         ["projects/-p/B.jsonl", "projects/-p/a.jsonl"])

    def _write_two(self) -> str:
        """Write two files whose names differ in case.

        Returns:
            The temporary root.
        """
        self.write("projects/-p/a.jsonl", "")
        self.write("projects/-p/B.jsonl", "")
        return self.root


class ClassificationTests(CaseTestCase):
    """Each classification rule and the precedence between them."""

    def classify(self, raw: str) -> str:
        """Classify raw line text.

        Args:
            raw: The line without its newline.

        Returns:
            The class name.
        """
        return reference.classify(reference.parse_json_object(raw.encode("utf-8")))

    def test_malformed_invalid_json(self) -> None:
        """Invalid JSON is malformed."""
        self.assertEqual(self.classify('{"type":'), "malformed")

    def test_malformed_non_object(self) -> None:
        """Valid JSON that is not an object is malformed."""
        for raw in ("[1,2]", '"text"', "3", "null", "true"):
            with self.subTest(raw=raw):
                self.assertEqual(self.classify(raw), "malformed")

    def test_malformed_non_standard_constants(self) -> None:
        """NaN and Infinity are not JSON even though Python accepts them."""
        self.assertEqual(self.classify('{"a":NaN}'), "malformed")
        self.assertEqual(self.classify('{"a":-Infinity}'), "malformed")

    def test_malformed_invalid_utf8(self) -> None:
        """Bytes that aren't UTF-8 are malformed."""
        self.assertEqual(reference.classify(reference.parse_json_object(b'{"a":"\xff"}')),
                         "malformed")

    def test_limit_hit(self) -> None:
        """isApiErrorMessage true with error rate_limit is a limit hit."""
        self.assertEqual(reference.classify(synthetic("x")), "limit_hit")

    def test_api_error_other_and_missing_error(self) -> None:
        """isApiErrorMessage true with any other or no error is an api_error."""
        self.assertEqual(reference.classify(synthetic("x", error="server_error")), "api_error")
        self.assertEqual(reference.classify(synthetic("x", error=None)), "api_error")

    def test_is_api_error_message_must_be_literal_true(self) -> None:
        """The string "true" or the number 1 does not make an api error."""
        for value in ("true", 1):
            with self.subTest(value=value):
                line = synthetic("x", isApiErrorMessage=value)
                self.assertEqual(reference.classify(line), "synthetic_other")

    def test_synthetic_other(self) -> None:
        """A <synthetic> model without the API error flag is synthetic_other."""
        line = synthetic("x")
        del line["isApiErrorMessage"]
        self.assertEqual(reference.classify(line), "synthetic_other")

    def test_synthetic_beats_request(self) -> None:
        """A <synthetic> assistant line with usage is not a request."""
        self.assertEqual(reference.classify(assistant(model="<synthetic>")), "synthetic_other")

    def test_api_error_beats_synthetic_and_request(self) -> None:
        """The API error flag wins even over a real model with usage."""
        line = assistant(isApiErrorMessage=True, error="rate_limit")
        self.assertEqual(reference.classify(line), "limit_hit")
        line = assistant(isApiErrorMessage=True)
        self.assertEqual(reference.classify(line), "api_error")

    def test_api_error_beats_retry_notice(self) -> None:
        """A system/api_error line flagged isApiErrorMessage is an api_error."""
        self.assertEqual(reference.classify(retry(isApiErrorMessage=True)), "api_error")

    def test_request(self) -> None:
        """An assistant line whose message.usage is an object is a request."""
        self.assertEqual(reference.classify(assistant()), "request")

    def test_request_needs_usage_object(self) -> None:
        """Usage that is null or an array, or a non-assistant type, is ignored."""
        for usage in (None, [], "x"):
            with self.subTest(usage=usage):
                line = assistant()
                line["message"]["usage"] = usage
                self.assertEqual(reference.classify(line), "ignored_type")
        line = assistant()
        line["type"] = "user"
        self.assertEqual(reference.classify(line), "ignored_type")

    def test_request_beats_retry_notice_rule_order(self) -> None:
        """An assistant line with usage and subtype api_error is a request."""
        self.assertEqual(reference.classify(assistant(subtype="api_error")), "request")

    def test_retry_notice(self) -> None:
        """type system with subtype api_error is a retry notice."""
        self.assertEqual(reference.classify(retry()), "retry_notice")

    def test_ignored_type(self) -> None:
        """Anything else is ignored, including other system subtypes."""
        for obj in ({"type": "user"}, {"type": "system", "subtype": "turn_duration"}, {}):
            with self.subTest(obj=obj):
                self.assertEqual(reference.classify(obj), "ignored_type")


class RequestFieldTests(CaseTestCase):
    """Request field extraction, token defaults, cache-write forms."""

    def test_field_mapping_and_key_order(self) -> None:
        """Every request field maps from its log field, in README key order."""
        result = self.single(assistant(output=30))
        record = result["requests"][0]
        self.assertEqual(list(record), [
            "dedup_key", "file", "line", "session_id", "message_id", "request_id", "model",
            "timestamp", "is_sidechain", "cwd", "input_tokens", "output_tokens",
            "cache_read_tokens", "cache_write_5m_tokens", "cache_write_1h_tokens",
            "cache_write_unsplit_tokens"])
        self.assertEqual(record, {
            "dedup_key": "s1/m/msg_1", "file": FILE, "line": 1, "session_id": "s1",
            "message_id": "msg_1", "request_id": "req_1", "model": "claude-sonnet-5",
            "timestamp": "2026-09-01T10:00:00.000Z", "is_sidechain": False, "cwd": "/w",
            "input_tokens": 1, "output_tokens": 30, "cache_read_tokens": 2,
            "cache_write_5m_tokens": 0, "cache_write_1h_tokens": 0,
            "cache_write_unsplit_tokens": None})

    def test_missing_request_id_and_cwd_are_null(self) -> None:
        """requestId and cwd are null when missing."""
        line = assistant(request_id=None)
        del line["cwd"]
        record = self.single(line)["requests"][0]
        self.assertIsNone(record["request_id"])
        self.assertIsNone(record["cwd"])

    def test_missing_session_and_model_become_placeholder(self) -> None:
        """An absent or non-string sessionId or model is "<missing>" everywhere."""
        result = self.single(assistant(session=None, model=None),
                             assistant(session=42, model=7, message_id=None, request_id="r"))
        records = result["requests"]
        self.assertEqual([(r["session_id"], r["model"], r["dedup_key"]) for r in records],
                         [("<missing>", "<missing>", "<missing>/m/msg_1"),
                          ("<missing>", "<missing>", "<missing>/r/r")])
        self.assertEqual(list(result["totals_by_model"]), ["<missing>"])
        self.assertEqual(result["totals_by_model"]["<missing>"]["requests"], 2)
        self.assertEqual(list(result["totals_by_day_utc"]["2026-09-01"]), ["<missing>"])

    def test_missing_sessions_share_a_key(self) -> None:
        """Two lines missing sessionId with one message.id dedup together."""
        result = self.single(assistant(session=None, output=1),
                             assistant(session=None, output=2, request_id="r2"))
        self.assertEqual(len(result["requests"]), 1)
        self.assertEqual(result["requests"][0]["output_tokens"], 2)

    def test_boolean_cache_write_values_default_silently(self) -> None:
        """Boolean or string cache-write values are 0 and not reported."""
        split = {"input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0,
                 "cache_creation": {"ephemeral_5m_input_tokens": True,
                                    "ephemeral_1h_input_tokens": "9"}}
        unsplit = {"input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0,
                   "cache_creation_input_tokens": False}
        result = self.single(assistant(message_id="a", usage=split),
                             assistant(message_id="b", usage=unsplit))
        self.assertEqual([(r["cache_write_5m_tokens"], r["cache_write_1h_tokens"],
                           r["cache_write_unsplit_tokens"]) for r in result["requests"]],
                         [(0, 0, None), (None, None, 0)])
        self.assertEqual(result["report"]["missing_fields"], [])

    def test_boolean_reported_token_fields(self) -> None:
        """Booleans in the three reported fields are 0 plus a missing_fields entry."""
        usage = {"input_tokens": False, "output_tokens": True, "cache_read_input_tokens": True}
        result = self.single(assistant(usage=usage))
        record = result["requests"][0]
        self.assertEqual((record["input_tokens"], record["output_tokens"],
                          record["cache_read_tokens"]), (0, 0, 0))
        self.assertIs(type(record["output_tokens"]), int)
        self.assertEqual([m["field"] for m in result["report"]["missing_fields"]],
                         ["input_tokens", "output_tokens", "cache_read_input_tokens"])
        self.assertEqual(result["totals_by_model"]["claude-sonnet-5"]["output_tokens"], 0)

    def test_is_sidechain_only_literal_true(self) -> None:
        """isSidechain "true" or missing is false."""
        result = self.single(assistant(message_id="a", sidechain="true"),
                             assistant(message_id="b", sidechain=None),
                             assistant(message_id="c", sidechain=True))
        self.assertEqual([r["is_sidechain"] for r in result["requests"]], [False, False, True])

    def test_cache_split_form(self) -> None:
        """A cache_creation object gives split fields and a null unsplit field."""
        usage = {"input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0,
                 "cache_creation_input_tokens": 1000,
                 "cache_creation": {"ephemeral_5m_input_tokens": 300,
                                    "ephemeral_1h_input_tokens": 700}}
        record = self.single(assistant(usage=usage))["requests"][0]
        self.assertEqual((record["cache_write_5m_tokens"], record["cache_write_1h_tokens"],
                          record["cache_write_unsplit_tokens"]), (300, 700, None))

    def test_cache_split_form_missing_members_default_silently(self) -> None:
        """Missing ephemeral fields are 0 and not reported."""
        usage = {"input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0,
                 "cache_creation": {"ephemeral_1h_input_tokens": 5}}
        result = self.single(assistant(usage=usage))
        record = result["requests"][0]
        self.assertEqual((record["cache_write_5m_tokens"], record["cache_write_1h_tokens"],
                          record["cache_write_unsplit_tokens"]), (0, 5, None))
        self.assertEqual(result["report"]["missing_fields"], [])

    def test_cache_unsplit_form(self) -> None:
        """Without a cache_creation object, the unsplit total is used."""
        usage = {"input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0,
                 "cache_creation_input_tokens": 400}
        record = self.single(assistant(usage=usage))["requests"][0]
        self.assertEqual((record["cache_write_5m_tokens"], record["cache_write_1h_tokens"],
                          record["cache_write_unsplit_tokens"]), (None, None, 400))

    def test_cache_unsplit_form_missing_and_null_object(self) -> None:
        """A null cache_creation is not an object; a missing total is 0 silently."""
        usage = {"input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0,
                 "cache_creation": None}
        result = self.single(assistant(usage=usage))
        self.assertEqual(result["requests"][0]["cache_write_unsplit_tokens"], 0)
        self.assertIsNone(result["requests"][0]["cache_write_5m_tokens"])
        self.assertEqual(result["report"]["missing_fields"], [])

    def test_missing_and_non_numeric_token_fields_reported(self) -> None:
        """Missing or non-numeric token fields are 0 and reported by log name."""
        usage = {"input_tokens": "5", "output_tokens": True}
        result = self.single(assistant(usage=usage))
        record = result["requests"][0]
        self.assertEqual((record["input_tokens"], record["output_tokens"],
                          record["cache_read_tokens"]), (0, 0, 0))
        self.assertEqual(result["report"]["missing_fields"], [
            {"file": FILE, "line": 1, "field": "input_tokens"},
            {"file": FILE, "line": 1, "field": "output_tokens"},
            {"file": FILE, "line": 1, "field": "cache_read_input_tokens"}])

    def test_report_fields_apply_to_every_request_line_before_dedup(self) -> None:
        """A losing snapshot still contributes to every per-line report field."""
        loser = assistant(output=None, timestamp="bad", message_id=None, request_id=None)
        loser["message"]["id"] = "msg_1"
        loser["message"]["usage"]["iterations"] = [{"type": "advisor"}]
        result = self.single(loser, assistant(output=9, request_id="x"))
        self.assertEqual([r["line"] for r in result["requests"]], [2])
        report = result["report"]
        self.assertEqual(report["lines"]["request"], 2)
        self.assertEqual(report["missing_fields"],
                         [{"file": FILE, "line": 1, "field": "output_tokens"}])
        self.assertEqual(report["unparsed_timestamps"], [{"file": FILE, "line": 1, "raw": "bad"}])
        self.assertEqual(report["non_message_iterations"],
                         [{"file": FILE, "line": 1, "type": "advisor"}])
        # The winner's timestamp parses, so the loser's bad one doesn't affect day totals.
        self.assertEqual(result["totals_by_day_utc"]["2026-09-01"]["claude-sonnet-5"]["requests"], 1)


class DedupTests(CaseTestCase):
    """Dedup keys, fallbacks, unkeyed pass-through, and winner tie-breaks."""

    def test_key_uses_message_id(self) -> None:
        """Snapshots sharing a message.id collapse to one request."""
        result = self.single(assistant(output=5), assistant(output=20, request_id="req_x"))
        self.assertEqual(len(result["requests"]), 1)
        self.assertEqual(result["requests"][0]["dedup_key"], "s1/m/msg_1")
        self.assertEqual(result["report"]["lines"]["request"], 2)

    def test_key_includes_session(self) -> None:
        """The same message.id in two sessions gives two requests."""
        result = self.single(assistant(session="s1"), assistant(session="s2"))
        self.assertEqual([r["dedup_key"] for r in result["requests"]], ["s1/m/msg_1", "s2/m/msg_1"])

    def test_fallback_to_request_id_when_message_id_missing_or_empty(self) -> None:
        """A missing or empty message.id falls back to requestId."""
        result = self.single(assistant(message_id=None, request_id="r1"),
                             assistant(message_id="", request_id="r2"))
        self.assertEqual([r["dedup_key"] for r in result["requests"]], ["s1/r/r1", "s1/r/r2"])
        self.assertEqual(result["requests"][1]["message_id"], "")

    def test_non_string_ids_do_not_key(self) -> None:
        """A numeric message.id is not a non-empty string."""
        result = self.single(assistant(message_id=7, request_id="r1"))
        self.assertEqual(result["requests"][0]["dedup_key"], "s1/r/r1")

    def test_unkeyed_pass_through_and_counted(self) -> None:
        """Lines with neither ID are each their own request and are counted."""
        result = self.single(assistant(output=1, message_id=None, request_id=None),
                             assistant(output=2, message_id=None, request_id=""))
        self.assertEqual([r["dedup_key"] for r in result["requests"]], [None, None])
        self.assertEqual(result["report"]["unkeyed_requests"], 2)
        self.assertEqual(result["totals_by_model"]["claude-sonnet-5"]["output_tokens"], 3)

    def test_winner_largest_output(self) -> None:
        """Largest output_tokens wins, wherever it is in the file."""
        result = self.single(assistant(output=5), assistant(output=42), assistant(output=20))
        self.assertEqual((result["requests"][0]["line"], result["requests"][0]["output_tokens"]),
                         (2, 42))

    def test_winner_non_sidechain_on_equal_output(self) -> None:
        """On equal output, the non-sidechain copy wins even if earlier."""
        result = self.single(assistant(output=30, request_id="a"),
                             assistant(output=30, request_id="z", sidechain=True))
        self.assertEqual(result["requests"][0]["request_id"], "a")
        result = self.single(assistant(output=30, request_id="z", sidechain=True),
                             assistant(output=30, request_id="a"))
        self.assertEqual(result["requests"][0]["request_id"], "a")

    def test_winner_later_line_on_full_tie(self) -> None:
        """On equal output and sidechain, the later line wins."""
        result = self.single(assistant(request_id="a"), assistant(request_id="b"))
        self.assertEqual(result["requests"][0]["line"], 2)

    def test_winner_later_file_on_full_tie(self) -> None:
        """Later means later file first, regardless of line number."""
        self.write("projects/-p/a.jsonl",
                   self.lines_text({"type": "user"}, {"type": "user", "n": 2}, assistant(request_id="a")))
        self.write("projects/-p/b.jsonl", self.lines_text(assistant(request_id="b")))
        result = reference.process_case(self.root)["final"]
        self.assertEqual(result["requests"][0]["file"], "projects/-p/b.jsonl")

    def test_winner_later_run_beats_higher_line_number(self) -> None:
        """A line first seen in run 2 is later than any run-1 line of that file."""
        self.write("run-1/" + FILE, self.lines_text({"type": "user"}, assistant(request_id="a")))
        self.write("run-2/" + FILE, self.lines_text(assistant(request_id="b")))
        result = reference.process_case(self.root)["run-2"]
        self.assertEqual((result["requests"][0]["request_id"], result["requests"][0]["line"]),
                         ("b", 1))


class TimestampTests(CaseTestCase):
    """Timestamp parsing and UTC day totals."""

    def test_parse_z_and_fraction(self) -> None:
        """Z with or without a fraction parses to its own date."""
        self.assertEqual(reference.parse_utc_day("2026-09-01T23:59:59Z"), "2026-09-01")
        self.assertEqual(reference.parse_utc_day("2026-09-01T23:59:59.123456789Z"), "2026-09-01")

    def test_positive_offset_moves_to_previous_day(self) -> None:
        """01:30+02:00 is 23:30 UTC the day before."""
        self.assertEqual(reference.parse_utc_day("2026-09-02T01:30:00.000+02:00"), "2026-09-01")

    def test_negative_offset_moves_to_next_day(self) -> None:
        """22:00-05:00 is 03:00 UTC the next day, across a month end."""
        self.assertEqual(reference.parse_utc_day("2026-09-30T22:00:00-05:00"), "2026-10-01")

    def test_unparseable_forms(self) -> None:
        """Forms outside the pattern, or impossible dates, do not parse."""
        for raw in ("not-a-time", "2026-09-01T10:00:00", "2026-09-01 10:00:00Z",
                    "2026-09-01T10:00Z", "2026-09-01T10:00:00z", "2026-09-01T10:00:00+0200",
                    "2026-13-01T10:00:00Z", "2026-02-30T10:00:00Z", "2026-09-01T24:00:00Z",
                    "2026-09-01T10:00:00.Z", "2026-09-01T10:00:00Z\n", "", 1756720800, None):
            with self.subTest(raw=raw):
                self.assertIsNone(reference.parse_utc_day(raw))

    def test_strict_ranges(self) -> None:
        """Every part must be in range: date, hour, minute, second, offset."""
        for raw in ("2026-00-01T10:00:00Z", "2026-09-00T10:00:00Z", "2026-09-31T10:00:00Z",
                    "2027-02-29T10:00:00Z", "2026-09-01T10:60:00Z", "2026-09-01T10:00:60Z",
                    "2026-09-01T10:00:00+24:00", "2026-09-01T10:00:00-05:60",
                    "2026-09-01T10:00:00+99:00"):
            with self.subTest(raw=raw):
                self.assertIsNone(reference.parse_utc_day(raw))

    def test_range_edges_parse(self) -> None:
        """Boundary values that are in range do parse."""
        self.assertEqual(reference.parse_utc_day("2028-02-29T23:59:59Z"), "2028-02-29")
        self.assertEqual(reference.parse_utc_day("2026-09-01T00:00:00+23:59"), "2026-08-31")
        self.assertEqual(reference.parse_utc_day("2026-09-01T23:59:59-23:59"), "2026-09-02")
        self.assertEqual(reference.parse_utc_day("2026-09-01T10:00:00-00:00"), "2026-09-01")

    def test_uppercase_z_only(self) -> None:
        """A lowercase z, or a missing zone, does not parse."""
        self.assertIsNone(reference.parse_utc_day("2026-09-01T10:00:00.000z"))
        self.assertIsNone(reference.parse_utc_day("2026-09-01T10:00:00.000"))
        self.assertEqual(reference.parse_utc_day("2026-09-01T10:00:00.000Z"), "2026-09-01")

    def test_non_ascii_digits_do_not_parse(self) -> None:
        """Only ASCII digits match the pattern."""
        self.assertIsNone(reference.parse_utc_day("２026-09-01T10:00:00Z"))

    def test_unparsed_timestamp_excluded_from_day_totals_only(self) -> None:
        """An unparsed or missing timestamp is reported and kept outside day totals."""
        result = self.single(assistant(message_id="a", output=1),
                             assistant(message_id="b", output=2, timestamp="bad"),
                             assistant(message_id="c", output=4, timestamp=None))
        self.assertEqual(len(result["requests"]), 3)
        self.assertEqual(result["totals_by_model"]["claude-sonnet-5"]["output_tokens"], 7)
        self.assertEqual(result["totals_by_day_utc"]["2026-09-01"]["claude-sonnet-5"]["output_tokens"], 1)
        self.assertEqual(result["report"]["unparsed_timestamps"], [
            {"file": FILE, "line": 2, "raw": "bad"},
            {"file": FILE, "line": 3, "raw": None}])
        self.assertEqual(result["requests"][1]["timestamp"], "bad")

    def test_day_totals_split_by_utc_day_and_model(self) -> None:
        """Requests bucket by their own UTC day and model."""
        result = self.single(assistant(message_id="a", output=10, timestamp="2026-09-01T23:59:58.000Z"),
                             assistant(message_id="b", output=20, timestamp="2026-09-02T00:00:03.000Z"),
                             assistant(message_id="c", output=30, model="claude-opus-5",
                                       timestamp="2026-09-02T01:30:00.000+02:00"))
        days = result["totals_by_day_utc"]
        self.assertEqual(sorted(days), ["2026-09-01", "2026-09-02"])
        self.assertEqual(days["2026-09-01"]["claude-sonnet-5"]["output_tokens"], 10)
        self.assertEqual(days["2026-09-01"]["claude-opus-5"]["output_tokens"], 30)
        self.assertEqual(days["2026-09-02"]["claude-sonnet-5"]["output_tokens"], 20)


class TotalsTests(CaseTestCase):
    """totals_by_model contents."""

    def test_totals_count_nulls_as_zero_and_use_winners(self) -> None:
        """Totals sum post-dedup requests; null cache fields add 0."""
        split = assistant(message_id="a", output=5)
        split["message"]["usage"]["cache_creation"] = {"ephemeral_5m_input_tokens": 3,
                                                       "ephemeral_1h_input_tokens": 4}
        unsplit_usage = {"input_tokens": 2, "output_tokens": 7, "cache_read_input_tokens": 1,
                         "cache_creation_input_tokens": 9}
        result = self.single(assistant(message_id="a", output=1), split,
                             assistant(message_id="b", usage=unsplit_usage))
        self.assertEqual(result["totals_by_model"], {"claude-sonnet-5": {
            "requests": 2, "input_tokens": 3, "output_tokens": 12, "cache_read_tokens": 3,
            "cache_write_5m_tokens": 3, "cache_write_1h_tokens": 4,
            "cache_write_unsplit_tokens": 9}})


class LimitTextTests(unittest.TestCase):
    """Window and reset_text parsing for limit hits."""

    def test_session_limit(self) -> None:
        """"session limit" is the five-hour window."""
        self.assertEqual(reference.parse_limit_text("You've hit your session limit · resets 6:10am (UTC)"),
                         ("five_hour", "6:10am (UTC)"))

    def test_five_hour_limit(self) -> None:
        """"5-hour limit" is the five-hour window."""
        self.assertEqual(reference.parse_limit_text("5-hour limit reached ∙ resets 2am"),
                         ("five_hour", "2am"))

    def test_weekly_limit(self) -> None:
        """"weekly limit" is the seven-day window."""
        self.assertEqual(reference.parse_limit_text("You've hit your weekly limit · resets Sep 5, 9am (UTC)"),
                         ("seven_day", "Sep 5, 9am (UTC)"))

    def test_unrecognised_text(self) -> None:
        """Text with neither phrase nor "resets " gives nulls."""
        self.assertEqual(reference.parse_limit_text("Usage limit reached"), (None, None))

    def test_reset_text_trimmed(self) -> None:
        """The reset text runs to the end of the text and is trimmed."""
        self.assertEqual(reference.parse_limit_text("limit · resets   3pm  \n"), (None, "3pm"))

    def test_text_concatenated_from_content(self) -> None:
        """Every content[].text is concatenated; non-text entries are skipped."""
        line = synthetic("You've hit your ")
        line["message"]["content"] += [{"type": "image"}, {"type": "text", "text": "weekly limit"},
                                       {"type": "text", "text": " · resets 9am"}]
        self.assertEqual(reference.message_text(line), "You've hit your weekly limit · resets 9am")

    def test_string_content_is_the_text(self) -> None:
        """A string content is the text itself."""
        line = synthetic("x")
        line["message"]["content"] = "session limit · resets 1am"
        self.assertEqual(reference.message_text(line), "session limit · resets 1am")

    def test_other_content_gives_empty_text(self) -> None:
        """Content that is neither a list nor a string gives empty text."""
        for content in (None, 5, {"text": "weekly limit"}):
            with self.subTest(content=content):
                line = synthetic("x")
                line["message"]["content"] = content
                self.assertEqual(reference.message_text(line), "")
        line = synthetic("x")
        del line["message"]["content"]
        self.assertEqual(reference.message_text(line), "")

    def test_list_entries_with_non_string_text_skipped(self) -> None:
        """Only string text members of list entries are concatenated."""
        line = synthetic("a")
        line["message"]["content"] += [{"text": 5}, "b", {"text": "c"}]
        self.assertEqual(reference.message_text(line), "ac")

    def test_matching_is_case_insensitive(self) -> None:
        """Window phrases and the resets marker match in any letter case."""
        self.assertEqual(reference.parse_limit_text("SESSION LIMIT · RESETS 5pm"),
                         ("five_hour", "5pm"))
        self.assertEqual(reference.parse_limit_text("5-Hour Limit reached · Resets 2am"),
                         ("five_hour", "2am"))
        self.assertEqual(reference.parse_limit_text("Your Weekly Limit · resets Mon"),
                         ("seven_day", "Mon"))

    def test_window_order_five_hour_before_weekly(self) -> None:
        """Text naming both windows is five_hour, whichever comes first."""
        self.assertEqual(reference.parse_limit_text("weekly limit and session limit")[0],
                         "five_hour")

    def test_reset_uses_first_marker(self) -> None:
        """The reset text starts after the first ``resets ``."""
        self.assertEqual(reference.parse_limit_text("resets 1am, then resets 2am")[1],
                         "1am, then resets 2am")

    def test_reset_text_null_when_nothing_follows(self) -> None:
        """``resets `` followed only by whitespace, or nothing, gives null."""
        for text in ("session limit · resets ", "session limit · resets   \n "):
            with self.subTest(text=text):
                self.assertEqual(reference.parse_limit_text(text), ("five_hour", None))

    def test_marker_needs_trailing_space(self) -> None:
        """``resets`` without a following space is not the marker."""
        self.assertEqual(reference.parse_limit_text("session limit resets"), ("five_hour", None))


class EventTests(CaseTestCase):
    """Event field mapping for each event class."""

    def test_limit_hit_event(self) -> None:
        """A limit hit maps error, status, window and reset text."""
        result = self.single(synthetic("You've hit your session limit · resets 6:10am (UTC)"))
        self.assertEqual(result["events"], [{
            "class": "limit_hit", "session_id": "s1", "timestamp": "2026-09-01T11:00:00.000Z",
            "file": FILE, "line": 1, "error": "rate_limit", "api_error_status": 429,
            "window": "five_hour", "reset_text": "6:10am (UTC)"}])
        self.assertEqual(result["requests"], [])
        self.assertEqual(result["totals_by_model"], {})

    def test_limit_hit_unparsed_text_still_an_event(self) -> None:
        """A limit hit whose text parses to nothing still counts."""
        result = self.single(synthetic("Usage limit reached"))
        self.assertEqual((result["events"][0]["window"], result["events"][0]["reset_text"]),
                         (None, None))

    def test_api_error_event_has_null_window(self) -> None:
        """Window and reset are null outside limit hits, even with matching text."""
        result = self.single(synthetic("session limit · resets 1am", error="server_error", status=529))
        event = result["events"][0]
        self.assertEqual((event["class"], event["error"], event["api_error_status"],
                          event["window"], event["reset_text"]),
                         ("api_error", "server_error", 529, None, None))

    def test_non_number_status_is_null(self) -> None:
        """A string apiErrorStatus is not a number."""
        result = self.single(synthetic("x", error="server_error", status="529"))
        self.assertIsNone(result["events"][0]["api_error_status"])

    def test_synthetic_other_event(self) -> None:
        """A synthetic line with no error fields has null error and status."""
        line = synthetic("No response requested.", error=None, status=None)
        del line["isApiErrorMessage"]
        event = self.single(line)["events"][0]
        self.assertEqual((event["class"], event["error"], event["api_error_status"]),
                         ("synthetic_other", None, None))

    def test_retry_notice_event(self) -> None:
        """A retry notice has null error and status from error.status."""
        event = self.single(retry(status=429))["events"][0]
        self.assertEqual(event, {
            "class": "retry_notice", "session_id": "s1", "timestamp": "2026-09-01T12:00:00.000Z",
            "file": FILE, "line": 1, "error": None, "api_error_status": 429,
            "window": None, "reset_text": None})

    def test_retry_notice_non_number_status(self) -> None:
        """A missing, string, or boolean error.status gives a null status."""
        missing = retry()
        del missing["error"]["status"]
        events = self.single(retry(status="429"), retry(status=True, n=2), missing)["events"]
        self.assertEqual([e["api_error_status"] for e in events], [None, None, None])

    def test_api_error_status_checked_first_for_retry_notices(self) -> None:
        """A numeric apiErrorStatus beats error.status on a retry notice."""
        event = self.single(retry(status=429, apiErrorStatus=503))["events"][0]
        self.assertEqual(event["api_error_status"], 503)

    def test_non_number_api_error_status_falls_back_on_retry_notice(self) -> None:
        """A non-numeric apiErrorStatus lets a retry notice use error.status."""
        event = self.single(retry(status=429, apiErrorStatus="503"))["events"][0]
        self.assertEqual(event["api_error_status"], 429)

    def test_boolean_api_error_status_is_null(self) -> None:
        """A boolean apiErrorStatus is not a number."""
        event = self.single(synthetic("x", error="server_error", status=True))["events"][0]
        self.assertIsNone(event["api_error_status"])

    def test_missing_session_in_event(self) -> None:
        """An event's absent or non-string sessionId is "<missing>"."""
        line = synthetic("x")
        del line["sessionId"]
        events = self.single(line, retry(sessionId=None))["events"]
        self.assertEqual([e["session_id"] for e in events], ["<missing>", "<missing>"])

    def test_limit_hit_with_string_content(self) -> None:
        """A limit hit whose content is a string is parsed from that string."""
        line = synthetic("x")
        line["message"]["content"] = "You've hit your weekly limit · resets Sep 5"
        event = self.single(line)["events"][0]
        self.assertEqual((event["window"], event["reset_text"]), ("seven_day", "Sep 5"))

    def test_error_status_ignored_outside_retry_notices(self) -> None:
        """error.status is only consulted for retry notices."""
        line = synthetic("x", error=None, status=None)
        del line["isApiErrorMessage"]
        line["error"] = {"status": 500}
        self.assertIsNone(self.single(line)["events"][0]["api_error_status"])

    def test_events_are_not_deduplicated(self) -> None:
        """Two distinct event lines with the same message id are two events."""
        first = synthetic("a")
        second = synthetic("b")
        first["message"]["id"] = second["message"]["id"] = "msg_x"
        self.assertEqual(len(self.single(first, second)["events"]), 2)


class ReportTests(CaseTestCase):
    """Every report field."""

    def test_report_shape_and_empty_values(self) -> None:
        """A request-only file gives zero counts for every other field."""
        report = self.single(assistant())["report"]
        self.assertEqual(report, {
            "lines": {"malformed": 0, "limit_hit": 0, "api_error": 0, "synthetic_other": 0,
                      "request": 1, "retry_notice": 0, "ignored_type": 0},
            "malformed": [], "ignored_types": {}, "unkeyed_requests": 0,
            "unknown_error_values": {}, "missing_fields": [], "unparsed_timestamps": [],
            "non_message_iterations": [], "retry_rate_limits_present": 0})

    def test_lines_count_every_class(self) -> None:
        """lines counts complete lines per class, requests before dedup."""
        no_flag = synthetic("x", error=None, status=None)
        del no_flag["isApiErrorMessage"]
        report = self.single("bad", synthetic("x"), synthetic("y", error="server_error"), no_flag,
                             assistant(output=1), assistant(output=2, request_id="r2"),
                             retry(), {"type": "user"})["report"]
        self.assertEqual(report["lines"], {"malformed": 1, "limit_hit": 1, "api_error": 1,
                                           "synthetic_other": 1, "request": 2,
                                           "retry_notice": 1, "ignored_type": 1})

    def test_malformed_list(self) -> None:
        """Malformed lines are listed by file and line; neighbours still ingest."""
        result = self.single(assistant(message_id="a"), '{"type":"assistant","message":',
                             "[1,2,3]", assistant(message_id="b"))
        self.assertEqual(result["report"]["malformed"],
                         [{"file": FILE, "line": 2}, {"file": FILE, "line": 3}])
        self.assertEqual(len(result["requests"]), 2)

    def test_ignored_types_keys(self) -> None:
        """Keys are type, or type/subtype when subtype is a string."""
        report = self.single({"type": "user"}, {"type": "user", "n": 1},
                             {"type": "system", "subtype": "turn_duration"},
                             {"type": "system", "subtype": 5},
                             {"type": "file-history-snapshot"})["report"]
        self.assertEqual(report["ignored_types"], {"user": 2, "system/turn_duration": 1,
                                                   "system": 1, "file-history-snapshot": 1})

    def test_ignored_type_without_string_type(self) -> None:
        """An absent or non-string type is labelled "<missing>"."""
        report = self.single({"x": 1}, {"type": None}, {"type": 7, "subtype": "s"},
                             {"subtype": "only"})["report"]
        self.assertEqual(report["ignored_types"], {"<missing>": 2, "<missing>/s": 1,
                                                   "<missing>/only": 1})

    def test_unknown_error_values(self) -> None:
        """server_error is known; other values and a missing error are counted."""
        report = self.single(synthetic("a", error="server_error"),
                             synthetic("b", error="billing_error"),
                             synthetic("c", error="billing_error", status=402),
                             synthetic("d", error=None),
                             synthetic("e", error="rate_limit"))["report"]
        self.assertEqual(report["unknown_error_values"], {"billing_error": 2, "<missing>": 1})

    def test_unknown_error_non_string_is_missing(self) -> None:
        """An explicit null, number, or object error counts under "<missing>"."""
        report = self.single(synthetic("a") | {"error": None},
                             synthetic("b") | {"error": 500},
                             synthetic("c") | {"error": {"type": "server_error"}})["report"]
        self.assertEqual(report["unknown_error_values"], {"<missing>": 3})

    def test_non_message_iterations(self) -> None:
        """Iteration entries of other types are listed with their type."""
        line = assistant()
        line["message"]["usage"]["iterations"] = [{"type": "message"},
                                                  {"type": "advisor", "model": "claude-opus-5"},
                                                  {"model": "x"}]
        report = self.single(line)["report"]
        self.assertEqual(report["non_message_iterations"], [
            {"file": FILE, "line": 1, "type": "advisor"},
            {"file": FILE, "line": 1, "type": None}])

    def test_retry_rate_limits_present(self) -> None:
        """Only retry notices with a non-null error.rateLimits count."""
        missing_member = retry()
        del missing_member["error"]["rateLimits"]
        report = self.single(retry(rate_limits=None, retryAttempt=1),
                             retry(rate_limits={"five_hour": {"used_percentage": 100}}, retryAttempt=2),
                             retry(rate_limits={}, retryAttempt=3),
                             missing_member)["report"]
        self.assertEqual(report["retry_rate_limits_present"], 2)


class MultiRunTests(CaseTestCase):
    """Cumulative multi-run behaviour."""

    def test_keys_and_file_paths(self) -> None:
        """Runs are keyed run-N in numeric order and share file paths."""
        for n in (1, 2, 10):
            self.write(f"run-{n}/" + FILE, self.lines_text(assistant(output=n)))
        result = reference.process_case(self.root)
        self.assertEqual(list(result), ["run-1", "run-2", "run-10"])
        self.assertEqual({r["file"] for state in result.values() for r in state["requests"]}, {FILE})

    def test_split_across_runs_final_count(self) -> None:
        """A stream stopped mid-way in run 1 reaches its final count in run 2."""
        first = [{"type": "user"}, assistant(output=5), assistant(output=20)]
        self.write("run-1/" + FILE, self.lines_text(*first))
        self.write("run-2/" + FILE, self.lines_text(*first, assistant(output=42)))
        result = reference.process_case(self.root)
        self.assertEqual(result["run-1"]["requests"][0]["output_tokens"], 20)
        self.assertEqual((result["run-2"]["requests"][0]["output_tokens"],
                          result["run-2"]["requests"][0]["line"]), (42, 4))
        self.assertEqual(result["run-2"]["report"]["lines"]["request"], 3)
        self.assertEqual(result["run-2"]["report"]["ignored_types"], {"user": 1})

    def test_fragment_completed_in_next_run_counted_once(self) -> None:
        """A fragment is ignored in run 1 and counted once when complete."""
        whole = dump(assistant(message_id="b"))
        self.write("run-1/" + FILE, self.lines_text(assistant(message_id="a")) + whole[:20])
        self.write("run-2/" + FILE, self.lines_text(assistant(message_id="a")) + whole + "\n")
        result = reference.process_case(self.root)
        self.assertEqual(result["run-1"]["report"]["lines"]["request"], 1)
        self.assertEqual(result["run-1"]["report"]["malformed"], [])
        self.assertEqual(result["run-2"]["report"]["lines"]["request"], 2)
        self.assertEqual([r["line"] for r in result["run-2"]["requests"]], [1, 2])

    def test_rewritten_file_old_lines_persist(self) -> None:
        """Lines gone from a rewritten file still count; new lines keep run-2 numbers."""
        a, b, c, d = (assistant(message_id=m, output=o) for m, o in
                      (("a", 10), ("b", 20), ("c", 30), ("d", 5)))
        self.write("run-1/" + FILE, self.lines_text(a, b, c))
        self.write("run-2/" + FILE, self.lines_text(a, d))
        result = reference.process_case(self.root)["run-2"]
        # Sorted by (file, first run, line): d (run 2, line 2) follows c (run 1, line 3).
        self.assertEqual([(r["message_id"], r["line"]) for r in result["requests"]],
                         [("a", 1), ("b", 2), ("c", 3), ("d", 2)])
        self.assertEqual(result["totals_by_model"]["claude-sonnet-5"]["output_tokens"], 65)
        self.assertEqual(result["report"]["lines"]["request"], 4)

    def test_line_moved_to_new_position_keeps_first_number(self) -> None:
        """Same bytes at a new position in a later run keep the first line number."""
        self.write("run-1/" + FILE, self.lines_text({"type": "user"}, assistant()))
        self.write("run-2/" + FILE, self.lines_text(assistant()))
        self.assertEqual(reference.process_case(self.root)["run-2"]["requests"][0]["line"], 2)


class OutputTests(CaseTestCase):
    """Result shape, ordering, and the CLI."""

    def test_result_key_order(self) -> None:
        """The result object keys follow the README example order."""
        result = self.single(assistant())
        self.assertEqual(list(result), ["requests", "totals_by_model", "totals_by_day_utc",
                                        "events", "report"])
        self.assertEqual(list(result["report"]), [
            "lines", "malformed", "ignored_types", "unkeyed_requests", "unknown_error_values",
            "missing_fields", "unparsed_timestamps", "non_message_iterations",
            "retry_rate_limits_present"])

    def test_single_state_key_is_final(self) -> None:
        """A case without run directories is keyed final."""
        self.write(FILE, self.lines_text(assistant()))
        self.assertEqual(list(reference.process_case(self.root)), ["final"])

    def test_requests_and_events_sorted_by_file_then_line(self) -> None:
        """Requests and events interleave by (file, line) across files."""
        self.write("projects/-p/b.jsonl", self.lines_text(assistant(message_id="b1"), synthetic("x")))
        self.write("projects/-p/a.jsonl", self.lines_text(synthetic("y"), assistant(message_id="a1")))
        result = reference.process_case(self.root)["final"]
        self.assertEqual([(r["file"][-7:], r["line"]) for r in result["requests"]],
                         [("a.jsonl", 2), ("b.jsonl", 1)])
        self.assertEqual([(e["file"][-7:], e["line"]) for e in result["events"]],
                         [("a.jsonl", 1), ("b.jsonl", 2)])

    def test_every_list_sorted_by_file_first_run_line(self) -> None:
        """Requests, events, and every report list use (file, first run, line)."""
        def problem_line(tag: str) -> dict[str, Any]:
            """Build a request line that lands in every per-line report list.

            Args:
                tag: Distinguishes the line's message id.

            Returns:
                The line object.
            """
            line = assistant(message_id=tag, output=None, timestamp="bad-" + tag)
            line["message"]["usage"]["iterations"] = [{"type": "advisor-" + tag}]
            return line

        run1 = [problem_line("a"), "bad-1", synthetic("x", timestamp="t-run1"), problem_line("b")]
        # Run 2 rewrites the file: run-1 lines disappear, and new lines take
        # line numbers 1-3, lower than run 1's line 4.
        run2 = [problem_line("c"), "bad-2", synthetic("y", timestamp="t-run2")]
        self.write("run-1/projects/-p/z.jsonl", self.lines_text(*run1))
        self.write("run-2/projects/-p/z.jsonl", self.lines_text(*run2))
        self.write("run-2/projects/-p/a.jsonl", self.lines_text(problem_line("d")))
        report_state = reference.process_case(self.root)["run-2"]
        report = report_state["report"]

        a_file, z_file = "projects/-p/a.jsonl", "projects/-p/z.jsonl"
        expected_order = [(a_file, 1), (z_file, 1), (z_file, 4), (z_file, 1)]
        self.assertEqual([(r["file"], r["line"]) for r in report_state["requests"]], expected_order)
        self.assertEqual([r["message_id"] for r in report_state["requests"]], ["d", "a", "b", "c"])
        for name in ("missing_fields", "unparsed_timestamps", "non_message_iterations"):
            with self.subTest(list=name):
                entries = [(e["file"], e["line"]) for e in report[name]]
                # missing_fields holds one entry per line here, output_tokens only.
                self.assertEqual(entries, expected_order)
        self.assertEqual([e["raw"] for e in report["unparsed_timestamps"]],
                         ["bad-d", "bad-a", "bad-b", "bad-c"])
        self.assertEqual(report["malformed"], [{"file": z_file, "line": 2}, {"file": z_file, "line": 2}])
        self.assertEqual([(e["file"], e["line"], e["timestamp"]) for e in report_state["events"]],
                         [(z_file, 3, "t-run1"), (z_file, 3, "t-run2")])

    def test_cli_prints_indented_json(self) -> None:
        """The CLI prints the result as indent-2 JSON."""
        self.write(FILE, self.lines_text(assistant()))
        out = io.StringIO()
        self.assertEqual(reference.main([self.root], out=out), 0)
        text = out.getvalue()
        self.assertTrue(text.startswith('{\n  "final": {\n    "requests": ['))
        self.assertEqual(json.loads(text), reference.process_case(self.root))

    def test_cli_usage_error(self) -> None:
        """Bad arguments exit 2 with a usage message."""
        err = io.StringIO()
        self.assertEqual(reference.main([], out=io.StringIO(), err=err), 2)
        self.assertIn("usage", err.getvalue())


class CheckTests(CaseTestCase):
    """The --check comparison."""

    def test_diff_json_equal_values(self) -> None:
        """Equal trees give no differences; key order and 1 vs 1.0 don't matter."""
        self.assertEqual(reference.diff_json({"a": [1, {"b": None}], "c": 2},
                                             {"c": 2.0, "a": [1, {"b": None}]}), [])

    def test_diff_json_reports_paths(self) -> None:
        """Differences name their path; booleans are not numbers."""
        differences = reference.diff_json(
            {"a": {"b": 1, "gone": 0}, "l": [1, 2], "t": True},
            {"a": {"b": 2, "extra": 0}, "l": [1], "t": 1})
        self.assertEqual(differences, [
            "$.a.b: expected 1, got 2",
            "$.a.extra: unexpected 0",
            "$.a.gone: missing (expected 0)",
            "$.l: expected 2 items, got 1",
            "$.l[1]: missing 2",
            "$.t: expected true, got 1"])

    def test_check_fixtures_root(self) -> None:
        """A matching case passes, a mismatching one fails with a diff, exit 1."""
        good = os.path.join(self.root, "01-good")
        bad = os.path.join(self.root, "02-bad")
        for case in (good, bad):
            path = os.path.join(case, FILE)
            os.makedirs(os.path.dirname(path))
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(self.lines_text(assistant(output=30)))
        expected = reference.process_case(good)
        with open(os.path.join(good, "expected.json"), "w", encoding="utf-8") as handle:
            json.dump(expected, handle)
        expected["final"]["requests"][0]["output_tokens"] = 31
        with open(os.path.join(bad, "expected.json"), "w", encoding="utf-8") as handle:
            json.dump(expected, handle)
        os.makedirs(os.path.join(self.root, "not-a-case"))

        out = io.StringIO()
        self.assertEqual(reference.check_fixtures(self.root, out), 1)
        self.assertEqual(out.getvalue(),
                         "PASS 01-good\n"
                         "FAIL 02-bad\n"
                         "  $.final.requests[0].output_tokens: expected 31, got 30\n")

        os.remove(os.path.join(bad, "expected.json"))
        out = io.StringIO()
        self.assertEqual(reference.main(["--check", self.root], out=out), 1)
        self.assertIn("FAIL 02-bad\n  no expected.json", out.getvalue())

        with open(os.path.join(bad, "expected.json"), "w", encoding="utf-8") as handle:
            json.dump(reference.process_case(bad), handle)
        self.assertEqual(reference.check_fixtures(self.root, io.StringIO()), 0)


class DocumentationTests(unittest.TestCase):
    """The project's docstring requirement."""

    def test_every_function_and_class_has_a_docstring(self) -> None:
        """reference.py has a module docstring and one on every def and class."""
        with open(reference.__file__, encoding="utf-8") as handle:
            tree = ast.parse(handle.read())
        self.assertIsNotNone(ast.get_docstring(tree))
        missing = [
            f"{node.name} (line {node.lineno})"
            for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            and not ast.get_docstring(node)
        ]
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
