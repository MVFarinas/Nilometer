/**
 * @file Tests for core/ingest/spool.ts (docs/development.md P4.7), including the real hook writing the spool.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SH } from "../../../setup/platform.js";

import { openDatabase } from "../../../../core/db/database.js";
import { ensureDerived } from "../../../../core/ingest/derive.js";
import { SPOOL_FILE, ingestLogs } from "../../../../core/ingest/ingest.js";
import {
  KNOWN_WINDOWS,
  MAX_EPOCH_SECONDS,
  MIN_EPOCH_SECONDS,
  decodeSpoolLine,
  deriveNewSpoolLines,
  deriveSpoolLine,
  validateWindow,
} from "../../../../core/ingest/spool.js";

/** Repository paths. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** A realistic synthetic payload. */
const PAYLOAD = readFileSync(join(ROOT, "tests/fixtures/statusline/payload.json"));

/**
 * Builds a spool line the way the hook does.
 * @param payload - Payload bytes or text.
 * @param header - Overrides for the header fields.
 * @returns The spool line bytes.
 */
function spoolLine(payload: Buffer | string, header: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      captured_at_s: 1774030000,
      hook_version: 1,
      payload_b64: Buffer.from(payload).toString("base64"),
      ...header,
    }),
  );
}

/**
 * A fixed clock.
 * @returns 2026-09-13T00:00:00Z.
 */
function now(): Date {
  return new Date("2026-09-13T00:00:00Z");
}

describe("decodeSpoolLine", () => {
  it("decodes a valid line into its header and payload", () => {
    const decoded = decodeSpoolLine(spoolLine(PAYLOAD));
    expect(decoded).toMatchObject({ status: "ok", capturedAtS: 1774030000, hookVersion: 1 });
    expect(decoded.payload).toEqual(JSON.parse(PAYLOAD.toString()));
  });

  it.each([
    [
      "invalid JSON (an interleaved line)",
      Buffer.from('{"captured_at_s":1,"hook_ve{"captured_at_s":2}'),
    ],
    ["a JSON array", Buffer.from("[1]")],
    [
      "a missing capture time",
      Buffer.from(JSON.stringify({ hook_version: 1, payload_b64: "e30=" })),
    ],
    [
      "a string hook version",
      Buffer.from(JSON.stringify({ captured_at_s: 1, hook_version: "1", payload_b64: "e30=" })),
    ],
    ["a missing payload", Buffer.from(JSON.stringify({ captured_at_s: 1, hook_version: 1 }))],
  ])("reports %s as a malformed line", (_name, bytes) => {
    expect(decodeSpoolLine(bytes)).toEqual({
      status: "malformed_line",
      capturedAtS: null,
      hookVersion: null,
      payload: null,
    });
  });

  it.each([
    ["invalid characters", "e30*"],
    ["bad padding", "e30"],
    ["padding in the middle", "e3=0"],
  ])("reports base64 with %s as a malformed encoding, keeping the header", (_name, encoded) => {
    expect(decodeSpoolLine(spoolLine("", { payload_b64: encoded }))).toEqual({
      status: "malformed_payload_encoding",
      capturedAtS: 1774030000,
      hookVersion: 1,
      payload: null,
    });
  });

  it.each([
    ["not JSON", "not json"],
    ["a JSON array", "[1,2]"],
    ["empty", ""],
  ])("reports a payload that is %s as malformed", (_name, payload) => {
    expect(decodeSpoolLine(spoolLine(payload)).status).toBe("malformed_payload");
  });
});

describe("validateWindow", () => {
  const good = { used_percentage: 42.3, resets_at: 1774036800 };

  it("lists the documented windows", () => {
    expect(KNOWN_WINDOWS).toEqual(["five_hour", "seven_day", "spend_limit"]);
    expect(MIN_EPOCH_SECONDS).toBe(1_000_000_000);
    expect(MAX_EPOCH_SECONDS).toBe(10_000_000_000);
  });

  it.each<[string, string, Record<string, unknown>, string]>([
    ["a normal reading", "five_hour", good, "valid"],
    ["0%", "seven_day", { ...good, used_percentage: 0 }, "valid"],
    ["exactly 100%", "five_hour", { ...good, used_percentage: 100 }, "valid"],
    ["101%", "five_hour", { ...good, used_percentage: 101 }, "invalid_percentage"],
    ["a negative percentage", "seven_day", { ...good, used_percentage: -1 }, "invalid_percentage"],
    ["a string percentage", "five_hour", { ...good, used_percentage: "42" }, "invalid_percentage"],
    ["a missing percentage", "five_hour", { resets_at: 1774036800 }, "invalid_percentage"],
    [
      "an epoch in the percentage (Claude Code bug #52326)",
      "five_hour",
      { ...good, used_percentage: 1774036800 },
      "invalid_epoch_in_percentage",
    ],
    ["a spend limit over 100%", "spend_limit", { ...good, used_percentage: 130 }, "valid"],
    [
      "an epoch in a spend limit's percentage",
      "spend_limit",
      { ...good, used_percentage: 1774036800 },
      "invalid_epoch_in_percentage",
    ],
    [
      "a reset time in milliseconds",
      "five_hour",
      { ...good, resets_at: 1774036800000 },
      "invalid_resets_at",
    ],
    ["a tiny reset time", "five_hour", { ...good, resets_at: 5 }, "invalid_resets_at"],
    ["a missing reset time", "seven_day", { used_percentage: 5 }, "invalid_resets_at"],
    ["an unknown window", "seven_day_opus", good, "unknown_window"],
  ])("labels %s", (_name, window, value, validity) => {
    expect(validateWindow(window, value).validity).toBe(validity);
  });

  it("keeps values as written, never clamped", () => {
    expect(validateWindow("five_hour", { used_percentage: 101, resets_at: 1774036800 })).toEqual({
      window: "five_hour",
      usedPercentage: 101,
      resetsAt: 1774036800,
      validity: "invalid_percentage",
    });
    expect(validateWindow("five_hour", { used_percentage: "x", resets_at: "y" })).toMatchObject({
      usedPercentage: null,
      resetsAt: null,
    });
  });
});

describe("deriveSpoolLine", () => {
  it("derives reading fields and one row per window", () => {
    expect(deriveSpoolLine(spoolLine(PAYLOAD))).toEqual({
      reading: {
        status: "ok",
        capturedAtS: 1774030000,
        hookVersion: 1,
        sessionId: "00000000-0000-4000-8000-000000000001",
        transcriptPath:
          "/home/example/.claude/projects/-home-example-demo/00000000-0000-4000-8000-000000000001.jsonl",
        modelId: "claude-sonnet-5",
        ccVersion: "2.1.269",
        costTotalUsd: 1.2345,
        hasRateLimits: true,
      },
      windows: [
        { window: "five_hour", usedPercentage: 42.3, resetsAt: 1774036800, validity: "valid" },
        { window: "seven_day", usedPercentage: 85.7, resetsAt: 1774580400, validity: "valid" },
      ],
    });
  });

  it("records no window rows, not zeros, when rate_limits is absent", () => {
    const derived = deriveSpoolLine(
      spoolLine(JSON.stringify({ session_id: "s", cost: { total_cost_usd: "x" } })),
    );
    expect(derived.reading).toMatchObject({
      hasRateLimits: false,
      costTotalUsd: null,
      modelId: null,
    });
    expect(derived.windows).toEqual([]);
  });

  it("skips window keys whose value isn't an object", () => {
    const derived = deriveSpoolLine(
      spoolLine(
        JSON.stringify({
          rate_limits: {
            five_hour: null,
            seven_day: { used_percentage: 1, resets_at: 1774580400 },
          },
        }),
      ),
    );
    expect(derived.windows.map((w) => w.window)).toEqual(["seven_day"]);
  });

  it("derives an empty reading for a malformed line", () => {
    expect(deriveSpoolLine(Buffer.from("garbage"))).toEqual({
      reading: {
        status: "malformed_line",
        capturedAtS: null,
        hookVersion: null,
        sessionId: null,
        transcriptPath: null,
        modelId: null,
        ccVersion: null,
        costTotalUsd: null,
        hasRateLimits: false,
      },
      windows: [],
    });
  });
});

describe("spool ingestion end to end", () => {
  it("ingests lines written by the real hook, derives readings, and never treats them as log lines", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aua-spool-"));
    const hook = join(ROOT, "hooks/statusline.sh");
    for (const input of [
      PAYLOAD,
      Buffer.from("not json"),
      Buffer.from(JSON.stringify({ model: { id: "m" } })),
    ]) {
      const run = spawnSync(SH, [hook, dataDir], { input });
      expect(run.status).toBe(0);
    }
    const logRoot = mkdtempSync(join(tmpdir(), "aua-spool-logs-"));
    mkdirSync(join(logRoot, "projects"));
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    const summary = ingestLogs(db, {
      roots: [logRoot],
      mode: "incremental",
      now,
      spoolDir: dataDir,
    });
    expect(summary).toMatchObject({ files: 1, spoolRead: true, linesStored: 3 });
    ensureDerived(db);
    expect(
      db
        .prepare(
          "SELECT status, model_id, has_rate_limits FROM status_readings ORDER BY raw_line_id",
        )
        .all(),
    ).toEqual([
      { status: "ok", model_id: "claude-sonnet-5", has_rate_limits: 1 },
      { status: "malformed_payload", model_id: null, has_rate_limits: 0 },
      { status: "ok", model_id: "m", has_rate_limits: 0 },
    ]);
    expect(
      db
        .prepare("SELECT window, used_percentage, validity FROM rate_limit_windows ORDER BY window")
        .all(),
    ).toEqual([
      { window: "five_hour", used_percentage: 42.3, validity: "valid" },
      { window: "seven_day", used_percentage: 85.7, validity: "valid" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM parsed_lines").get()).toEqual({ n: 0 });
    // A later hook write with a new payload is picked up incrementally.
    spawnSync(SH, [hook, dataDir], { input: JSON.stringify({ model: { id: "later" } }) });
    expect(
      ingestLogs(db, { roots: [logRoot], mode: "incremental", now, spoolDir: dataDir }),
    ).toMatchObject({ linesRead: 1, linesStored: 1 });
    expect(deriveNewSpoolLines(db)).toBe(1);
  });

  it("stores a byte-identical reading from the same second once, per raw-line identity (D-002)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aua-spool-same-"));
    const line = spoolLine(PAYLOAD);
    writeFileSync(join(dataDir, SPOOL_FILE), `${line.toString()}\n${line.toString()}\n`);
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    const logRoot = mkdtempSync(join(tmpdir(), "aua-spool-same-logs-"));
    mkdirSync(join(logRoot, "projects"));
    expect(
      ingestLogs(db, { roots: [logRoot], mode: "incremental", now, spoolDir: dataDir }),
    ).toMatchObject({
      linesRead: 2,
      linesStored: 1,
    });
  });

  it("reports no spool when the data directory has none", () => {
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    const logRoot = mkdtempSync(join(tmpdir(), "aua-spool-none-"));
    mkdirSync(join(logRoot, "projects"));
    expect(
      ingestLogs(db, {
        roots: [logRoot],
        mode: "incremental",
        now,
        spoolDir: mkdtempSync(join(tmpdir(), "aua-empty-data-")),
      }),
    ).toMatchObject({
      files: 0,
      spoolRead: false,
    });
    expect(ingestLogs(db, { roots: [logRoot], mode: "incremental", now })).toMatchObject({
      spoolRead: false,
    });
  });

  it("stores an interleaved spool line and reports it as malformed", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aua-spool-bad-"));
    writeFileSync(
      join(dataDir, SPOOL_FILE),
      '{"captured_at_s":1,"hook_ve{"captured_at_s":2,"hook_version":1,"payload_b64":"e30="}\n',
    );
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    const logRoot = mkdtempSync(join(tmpdir(), "aua-spool-bad-logs-"));
    mkdirSync(join(logRoot, "projects"));
    ingestLogs(db, { roots: [logRoot], mode: "incremental", now, spoolDir: dataDir });
    ensureDerived(db);
    expect(db.prepare("SELECT status FROM status_readings").all()).toEqual([
      { status: "malformed_line" },
    ]);
  });
});
