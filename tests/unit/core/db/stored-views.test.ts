/**
 * @file The stored views hold exactly their computed views' rows (D-096, step G6.1).
 *
 * `requests_dedup` and `window_readings` are tables that ingest fills from `requests_dedup_computed` and
 * `window_readings_computed`. Each test compares every row, value and SQLite type, in both directions:
 * after an ingest, after a later ingest that adds lines, and straight after migration 032 on a database
 * that already held data. Scenario: one response written as two cumulative lines (the larger wins),
 * one plain request, and three readings of the same 5-hour window: one after each request, and one later
 * repeating the second with no new request, which window_readings counts once (D-044), so two rows.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyMigrations, listMigrations, openDatabase } from "../../../../core/db/database.js";
import type { Db } from "../../../../core/db/database.js";
import { deriveNewLines, ensureDerived } from "../../../../core/ingest/derive.js";
import { SPOOL_FILE, ingestLogs } from "../../../../core/ingest/ingest.js";
import { deriveNewSpoolLines } from "../../../../core/ingest/spool.js";
import {
  STORED_VIEWS,
  inputSignature,
  refreshStoredViews,
} from "../../../../core/db/stored-views.js";
import { epoch, now, request } from "../metrics/helpers.js";

/** Repository root. */
const ROOT = join(import.meta.dirname, "../../../..");

/**
 * One spool line: a 5-hour reading of session s1.
 * @param at - Capture time, ISO-8601 UTC.
 * @param used - used_percentage.
 * @returns The line, with its newline.
 */
function spoolLine(at: string, used: number): string {
  const payload = {
    session_id: "s1",
    rate_limits: { five_hour: { used_percentage: used, resets_at: epoch("2026-09-01T14:00:00Z") } },
  };
  return `${JSON.stringify({
    captured_at_s: epoch(at),
    hook_version: 1,
    payload_b64: Buffer.from(JSON.stringify(payload)).toString("base64"),
  })}\n`;
}

/**
 * Writes the scenario's logs and spool into a new folder.
 * @returns The log root and the spool directory.
 */
function scenarioFiles(): { root: string; spoolDir: string } {
  const root = mkdtempSync(join(tmpdir(), "nilometer-stored-"));
  mkdirSync(join(root, "projects", "-p"), { recursive: true });
  const lines = [
    request("s1", "a", null, "2026-09-01T10:00:00Z", { usage: { output_tokens: 3 } }),
    request("s1", "a", null, "2026-09-01T10:00:01Z", { usage: { output_tokens: 9 } }),
    request("s1", "b", "a", "2026-09-01T11:00:00Z"),
  ];
  writeFileSync(
    join(root, "projects", "-p", "s1.jsonl"),
    lines.map((l) => `${JSON.stringify(l)}\n`).join(""),
  );
  const spoolDir = join(root, "data");
  mkdirSync(spoolDir);
  writeFileSync(
    join(spoolDir, SPOOL_FILE),
    spoolLine("2026-09-01T10:00:05Z", 10) +
      spoolLine("2026-09-01T11:00:05Z", 20) +
      spoolLine("2026-09-01T12:00:00Z", 20),
  );
  return { root, spoolDir };
}

/**
 * Every row of a table or view, each value tagged with its SQLite type, sorted.
 * @param db - The database.
 * @param name - Table or view.
 * @param columns - Its columns.
 * @returns One JSON string per row.
 */
function typedRows(db: Db, name: string, columns: readonly string[]): string[] {
  const cells = columns.map((c) => `${c}, typeof(${c})`).join(", ");
  return (db.prepare(`SELECT json_array(${cells}) AS row FROM ${name}`).all() as { row: string }[])
    .map((r) => r.row)
    .sort();
}

/**
 * Compares each stored table with its view.
 * @param db - The database.
 * @returns Per table: its row count, and whether its rows equal the view's exactly.
 */
function compare(db: Db): Record<string, { rows: number; same: boolean }> {
  return Object.fromEntries(
    STORED_VIEWS.map(({ table, view }) => {
      const columns = (
        db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]
      ).map((c) => c.name);
      const stored = typedRows(db, table, columns);
      const computed = typedRows(db, view, columns);
      return [
        table,
        { rows: stored.length, same: JSON.stringify(stored) === JSON.stringify(computed) },
      ];
    }),
  );
}

describe("stored views (D-096)", () => {
  it("hold exactly their views' rows after an ingest", () => {
    const { root, spoolDir } = scenarioFiles();
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    ingestLogs(db, { roots: [root], mode: "incremental", now, spoolDir });
    ensureDerived(db);
    // Two responses (the two lines of "a" are one), and two readings (the repeat counts once).
    expect(compare(db)).toEqual({
      requests_dedup: { rows: 2, same: true },
      window_readings: { rows: 2, same: true },
    });
    // The larger of the two cumulative lines is the one stored (D-001).
    expect(
      db.prepare("SELECT output_tokens FROM requests_dedup WHERE message_id = 'msg-a'").get(),
    ).toEqual({ output_tokens: 9 });
  });

  it("refill when a later ingest adds lines, and skip when nothing changed", () => {
    const { root, spoolDir } = scenarioFiles();
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    ingestLogs(db, { roots: [root], mode: "incremental", now, spoolDir });
    ensureDerived(db);
    expect(refreshStoredViews(db)).toBe(false);
    writeFileSync(
      join(root, "projects", "-p", "s2.jsonl"),
      `${JSON.stringify(request("s2", "c", null, "2026-09-01T12:30:00Z"))}\n`,
    );
    ingestLogs(db, { roots: [root], mode: "incremental", now, spoolDir });
    ensureDerived(db);
    expect(compare(db).requests_dedup).toEqual({ rows: 3, same: true });
    // Forced, it refills even though nothing changed.
    expect(refreshStoredViews(db, true)).toBe(true);
    expect(compare(db).requests_dedup).toEqual({ rows: 3, same: true });
  });

  it("are filled by migration 032 on a database that already held data", () => {
    const { root, spoolDir } = scenarioFiles();
    const db = new DatabaseSync(":memory:");
    const all = listMigrations(join(ROOT, "core/schema"));
    applyMigrations(
      db,
      all.filter((m) => m.version <= 31),
      now,
    );
    // Data stored and derived the way schema 31 did, with no stored tables yet.
    ingestLogs(db, { roots: [root], mode: "incremental", now, spoolDir });
    deriveNewLines(db);
    deriveNewSpoolLines(db);
    applyMigrations(db, all, now);
    expect(compare(db)).toEqual({
      requests_dedup: { rows: 2, same: true },
      window_readings: { rows: 2, same: true },
    });
  });

  it("are refilled when the database is next opened, if something wrote their inputs without refilling (M15)", () => {
    const { root, spoolDir } = scenarioFiles();
    const path = join(mkdtempSync(join(tmpdir(), "nilometer-stale-")), "usage.db");
    const db = openDatabase(path, join(ROOT, "core/schema"));
    ingestLogs(db, { roots: [root], mode: "incremental", now, spoolDir });
    ensureDerived(db);
    // What a build without the refresh did: new lines stored and derived, the stored table left alone.
    writeFileSync(
      join(root, "projects", "-p", "s2.jsonl"),
      `${JSON.stringify(request("s2", "c", null, "2026-09-01T12:30:00Z"))}\n`,
    );
    ingestLogs(db, { roots: [root], mode: "incremental", now, spoolDir });
    deriveNewLines(db);
    expect(compare(db).requests_dedup).toEqual({ rows: 2, same: false });
    db.close();
    const reopened = openDatabase(path, join(ROOT, "core/schema"));
    expect(compare(reopened).requests_dedup).toEqual({ rows: 3, same: true });
    reopened.close();
  });

  it("change their signature when an input row is added or a source path changes", () => {
    const { root, spoolDir } = scenarioFiles();
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    ingestLogs(db, { roots: [root], mode: "incremental", now, spoolDir });
    ensureDerived(db);
    const before = inputSignature(db);
    db.prepare("UPDATE source_files SET relative_path = relative_path || 'x' WHERE id = 1").run();
    expect(inputSignature(db)).not.toBe(before);
  });
});
