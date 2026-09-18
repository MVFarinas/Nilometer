/**
 * @file Unit tests for core/ingest/results.ts (docs/development.md P4.5). Full per-field agreement with every
 * fixture is the loader fidelity check's job (A6c); these tests cover each query's behavior.
 */
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { type Db, openDatabase } from "../../../../core/db/database.js";
import { ensureDerived } from "../../../../core/ingest/derive.js";
import { ingestLogs } from "../../../../core/ingest/ingest.js";
import { rawTimestamp, readReport, readResult, toTotals } from "../../../../core/ingest/results.js";

/** Repository paths. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Ingests one single-state fixture case into a fresh database.
 * @param caseId - Fixture case directory name.
 * @returns The database with derived tables up to date.
 */
function ingestCase(caseId: string): Db {
  const db = openDatabase(":memory:", join(ROOT, "core/schema"));
  const root = mkdtempSync(join(tmpdir(), "aua-results-"));
  cpSync(join(ROOT, "fixtures", caseId, "projects"), join(root, "projects"), { recursive: true });
  ingestLogs(db, {
    roots: [root],
    mode: "incremental",
    now: () => new Date("2026-09-13T00:00:00Z"),
  });
  ensureDerived(db);
  return db;
}

describe("rawTimestamp", () => {
  it("parses stored JSON text back to its value, and null stays null", () => {
    expect(rawTimestamp('"2026-09-01T00:00:00Z"')).toBe("2026-09-01T00:00:00Z");
    expect(rawTimestamp("5")).toBe(5);
    expect(rawTimestamp(null)).toBeNull();
  });
});

describe("toTotals", () => {
  it("keeps exactly the seven totals fields in order, dropping group keys", () => {
    const row = {
      model: "m",
      day: "d",
      requests: 1,
      input_tokens: 2,
      output_tokens: 3,
      cache_read_tokens: 4,
      cache_write_5m_tokens: 5,
      cache_write_1h_tokens: 6,
      cache_write_unsplit_tokens: 7,
    };
    expect(Object.keys(toTotals(row))).toEqual([
      "requests",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_5m_tokens",
      "cache_write_1h_tokens",
      "cache_write_unsplit_tokens",
    ]);
  });
});

describe("readResult", () => {
  it("returns the deduplicated winner with its source position", () => {
    const result = readResult(ingestCase("01-streaming-snapshots"));
    expect(
      result.requests.map((r) => [r.dedup_key, r.line, r.output_tokens, r.is_sidechain]),
    ).toEqual([
      ["s01/m/msg_01a", 4, 42, false],
      ["s01/m/msg_01b", 6, 7, false],
    ]);
    expect(result.requests[0]?.file).toBe("projects/-fixture-demo/s01.jsonl");
  });

  it("totals per model and per UTC day, counting null cache writes as 0", () => {
    const result = readResult(ingestCase("16-cache-write-forms"));
    expect(result.totals_by_model["claude-sonnet-5"]).toEqual({
      requests: 2,
      input_tokens: 11,
      output_tokens: 30,
      cache_read_tokens: 110,
      cache_write_5m_tokens: 300,
      cache_write_1h_tokens: 700,
      cache_write_unsplit_tokens: 400,
    });
    expect(Object.keys(result.totals_by_day_utc)).toEqual(["2026-09-01"]);
  });

  it("leaves requests with unparsed timestamps out of day totals only", () => {
    const result = readResult(ingestCase("17-report-edges"));
    expect(result.totals_by_model["claude-sonnet-5"]?.requests).toBe(3);
    expect(result.totals_by_day_utc["2026-09-01"]?.["claude-sonnet-5"]?.requests).toBe(2);
  });

  it("lists events in canonical order with parsed limit text", () => {
    const events = readResult(ingestCase("08-limit-hits")).events;
    expect(events.map((e) => [e.class, e.line, e.window, e.reset_text])).toEqual([
      ["limit_hit", 3, "five_hour", "6:10am (UTC)"],
      ["limit_hit", 4, "seven_day", "Sep 5, 9am (UTC)"],
      ["limit_hit", 5, "five_hour", "2am"],
      ["limit_hit", 6, null, null],
    ]);
  });

  it("returns empty collections for an empty database", () => {
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    expect(readResult(db)).toEqual({
      requests: [],
      totals_by_model: {},
      totals_by_day_utc: {},
      events: [],
      report: {
        lines: {
          malformed: 0,
          limit_hit: 0,
          api_error: 0,
          synthetic_other: 0,
          request: 0,
          retry_notice: 0,
          ignored_type: 0,
        },
        malformed: [],
        ignored_types: {},
        unkeyed_requests: 0,
        unknown_error_values: {},
        missing_fields: [],
        unparsed_timestamps: [],
        non_message_iterations: [],
        retry_rate_limits_present: 0,
      },
    });
  });
});

describe("readReport", () => {
  it("counts lines by class and labels ignored types with subtypes", () => {
    const report = readReport(ingestCase("15-retry-notices"));
    expect(report.lines).toMatchObject({ retry_notice: 2, request: 1, ignored_type: 1 });
    expect(report.ignored_types).toEqual({ "system/turn_duration": 1 });
    expect(report.retry_rate_limits_present).toBe(1);
  });

  it("lists malformed lines, unknown errors, and unkeyed requests", () => {
    expect(readReport(ingestCase("10-malformed-lines")).malformed.map((m) => m.line)).toEqual([
      2, 3,
    ]);
    expect(readReport(ingestCase("09-api-errors")).unknown_error_values).toEqual({
      "<missing>": 1,
      billing_error: 1,
    });
    expect(readReport(ingestCase("05-missing-ids")).unkeyed_requests).toBe(2);
  });

  it("maps line problems to their documented fields", () => {
    const report = readReport(ingestCase("17-report-edges"));
    expect(report.missing_fields).toEqual([
      { file: "projects/-fixture-demo/s17.jsonl", line: 1, field: "output_tokens" },
    ]);
    expect(report.unparsed_timestamps).toEqual([
      { file: "projects/-fixture-demo/s17.jsonl", line: 2, raw: "not-a-time" },
    ]);
    expect(report.non_message_iterations).toEqual([
      { file: "projects/-fixture-demo/s17.jsonl", line: 3, type: "advisor" },
    ]);
  });
});
