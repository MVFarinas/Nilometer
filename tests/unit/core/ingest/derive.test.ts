/**
 * @file Unit tests for core/ingest/derive.ts (docs/development.md P4.4).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { type Db, openDatabase } from "../../../../core/db/database.js";
import { fingerprintTables } from "../../../../core/db/fingerprint.js";
import {
  DERIVED_TABLES,
  PARSER_VERSION,
  deriveLine,
  deriveNewLines,
  ensureDerived,
  rebuildDerived,
} from "../../../../core/ingest/derive.js";
import { findOrCreateSourceFile, rawLineWriter, startRun } from "../../../../core/ingest/store.js";

/** The real migrations directory. */
const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), "../../../../core/schema");

/**
 * Serializes an object as line bytes.
 * @param value - Any JSON value.
 * @returns The bytes.
 */
function bytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

describe("deriveLine", () => {
  it("derives only the class for a malformed line", () => {
    expect(deriveLine(Buffer.from("{oops"))).toEqual({
      parsed: {
        lineClass: "malformed",
        sessionId: null,
        type: null,
        subtype: null,
        timestampRaw: null,
        timestampUtc: null,
        cwd: null,
        gitBranch: null,
        ccVersion: null,
        isSidechain: false,
      },
      links: { uuid: null, parentUuid: null, originKind: null, userContent: null, isMeta: false },
      request: null,
      event: null,
      resetAtUtc: null,
      problems: [],
    });
  });

  it("derives envelope fields, request fields, and every request problem", () => {
    const derived = deriveLine(
      bytes({
        type: "assistant",
        sessionId: "s",
        timestamp: "not-a-time",
        cwd: "/w",
        gitBranch: "main",
        version: "2.1.269",
        isSidechain: true,
        message: {
          id: "m",
          model: "claude-sonnet-5",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, iterations: [{ type: "advisor" }] },
        },
      }),
    );
    expect(derived.parsed).toEqual({
      lineClass: "request",
      sessionId: "s",
      type: "assistant",
      subtype: null,
      timestampRaw: '"not-a-time"',
      timestampUtc: null,
      cwd: "/w",
      gitBranch: "main",
      ccVersion: "2.1.269",
      isSidechain: true,
    });
    expect(derived.request?.outputTokens).toBe(0);
    expect(derived.event).toBeNull();
    expect(derived.problems).toEqual([
      ["missing_field", "output_tokens"],
      ["unparsed_timestamp", '"not-a-time"'],
      ["non_message_iteration", "advisor"],
    ]);
  });

  it("reports a missing timestamp on a request as JSON null", () => {
    const derived = deriveLine(
      bytes({
        type: "assistant",
        message: { usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } },
      }),
    );
    expect(derived.problems).toEqual([["unparsed_timestamp", "null"]]);
    expect(derived.parsed.timestampRaw).toBeNull();
  });

  it("derives an event for event classes, with no request problems", () => {
    const derived = deriveLine(
      bytes({ type: "system", subtype: "api_error", timestamp: 5, error: { status: 429 } }),
    );
    expect(derived.parsed).toMatchObject({
      lineClass: "retry_notice",
      subtype: "api_error",
      timestampRaw: "5",
    });
    expect(derived.event).toMatchObject({ apiErrorStatus: 429 });
    expect(derived.problems).toEqual([]);
  });

  it("resolves a limit hit's reset time against its own timestamp, and nothing for other lines", () => {
    const hit = deriveLine(
      bytes({
        isApiErrorMessage: true,
        error: "rate_limit",
        timestamp: "2026-09-01T03:00:00.000Z",
        uuid: "u2",
        parentUuid: "u1",
        message: {
          content: [{ type: "text", text: "You've hit your session limit · resets 6:10am (UTC)" }],
        },
      }),
    );
    expect(hit.resetAtUtc).toBe("2026-09-01T06:10:00.000Z");
    expect(hit.links).toMatchObject({ uuid: "u2", parentUuid: "u1" });
    const untimed = deriveLine(
      bytes({
        isApiErrorMessage: true,
        error: "rate_limit",
        message: { content: "resets 6am (UTC)" },
      }),
    );
    expect(untimed.resetAtUtc).toBeNull();
    const retry = deriveLine(
      bytes({ type: "system", subtype: "api_error", timestamp: "2026-09-01T03:00:00Z" }),
    );
    expect(retry.resetAtUtc).toBeNull();
  });

  it("derives neither request nor event for an ignored line, with missing labels", () => {
    const derived = deriveLine(bytes({ subtype: 7 }));
    expect(derived.parsed).toMatchObject({
      lineClass: "ignored_type",
      type: "<missing>",
      sessionId: "<missing>",
      subtype: null,
    });
    expect(derived.request).toBeNull();
    expect(derived.event).toBeNull();
  });
});

describe("deriving into the database", () => {
  let db: Db;
  let store: (value: unknown) => void;

  beforeEach(() => {
    db = openDatabase(":memory:", SCHEMA);
    const run = startRun(db, "incremental", new Date("2026-09-13T00:00:00Z"));
    const file = findOrCreateSourceFile(
      db,
      {
        kind: "log",
        root: "/r",
        relativePath: "projects/p/s.jsonl",
        stat: { size: 0, inode: null },
      },
      run,
    );
    const writer = rawLineWriter(db, file.id, run);
    let line = 0;
    store = (value) => {
      line += 1;
      writer({
        bytes: typeof value === "string" ? Buffer.from(value) : bytes(value),
        offset: line,
        lineNumber: line,
      });
    };
  });

  /**
   * Counts rows in each derived table.
   * @returns Row counts keyed by table.
   */
  function counts(): Record<string, number> {
    return Object.fromEntries(
      DERIVED_TABLES.map((table) => [
        table,
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      ]),
    );
  }

  it("derives rows for new lines only and inserts each kind of row", () => {
    store("not json");
    store({
      type: "assistant",
      timestamp: "2026-09-01T00:00:00Z",
      message: { id: "m", usage: { output_tokens: 3 } },
    });
    store({
      isApiErrorMessage: true,
      error: "rate_limit",
      apiErrorStatus: 429,
      message: { content: "session limit" },
    });
    expect(deriveNewLines(db)).toBe(3);
    expect(counts()).toEqual({
      line_problems: 2,
      events: 1,
      requests: 1,
      parsed_lines: 3,
      rate_limit_windows: 0,
      status_readings: 0,
    });
    expect(deriveNewLines(db)).toBe(0);
    store({ type: "user" });
    expect(deriveNewLines(db)).toBe(1);
    expect(counts().parsed_lines).toBe(4);
  });

  it("stores booleans as integers and keeps null cache-write columns", () => {
    store({
      type: "assistant",
      isSidechain: true,
      message: {
        id: "m",
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 1,
          cache_creation_input_tokens: 9,
        },
      },
    });
    deriveNewLines(db);
    expect(db.prepare("SELECT is_sidechain FROM parsed_lines").get()).toEqual({ is_sidechain: 1 });
    store({
      type: "user",
      uuid: "u",
      parentUuid: "p",
      isMeta: true,
      origin: { kind: "human" },
      message: { content: [{ type: "tool_result" }] },
    });
    store({
      isApiErrorMessage: true,
      error: "rate_limit",
      timestamp: "2026-09-01T03:00:00Z",
      message: { content: "resets 4pm (UTC)" },
    });
    deriveNewLines(db);
    expect(
      db
        .prepare(
          "SELECT uuid, parent_uuid, origin_kind, user_content, is_meta FROM parsed_lines WHERE uuid = 'u'",
        )
        .get(),
    ).toEqual({
      uuid: "u",
      parent_uuid: "p",
      origin_kind: "human",
      user_content: "tool_result",
      is_meta: 1,
    });
    expect(db.prepare("SELECT reset_at_utc FROM events").get()).toEqual({
      reset_at_utc: "2026-09-01T16:00:00.000Z",
    });
    expect(
      db.prepare("SELECT cache_write_5m_tokens, cache_write_unsplit_tokens FROM requests").get(),
    ).toEqual({
      cache_write_5m_tokens: null,
      cache_write_unsplit_tokens: 9,
    });
  });

  it("rebuilds to identical rows and records the parser version", () => {
    store({ type: "assistant", message: { id: "m", usage: {} } });
    store({ type: "system", subtype: "api_error", error: { rateLimits: {} } });
    deriveNewLines(db);
    const before = fingerprintTables(db, [...DERIVED_TABLES]);
    expect(rebuildDerived(db)).toBe(2);
    expect(fingerprintTables(db, [...DERIVED_TABLES])).toEqual(before);
    expect(db.prepare("SELECT value FROM derive_meta WHERE key = 'parser_version'").get()).toEqual({
      value: PARSER_VERSION,
    });
  });

  it("rebuilds when no parser version is recorded, then derives incrementally", () => {
    store({ type: "user" });
    expect(ensureDerived(db)).toEqual({ derived: 1, rebuilt: true });
    store({ type: "user", uuid: "second" });
    expect(ensureDerived(db)).toEqual({ derived: 1, rebuilt: false });
  });

  it("rebuilds everything when the recorded parser version differs", () => {
    store({ type: "user" });
    ensureDerived(db);
    db.prepare("UPDATE derive_meta SET value = 'old' WHERE key = 'parser_version'").run();
    expect(ensureDerived(db)).toEqual({ derived: 1, rebuilt: true });
  });
});
