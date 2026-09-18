/**
 * @file Tests for migration 001 (docs/development.md P3.2): constraints actually hold on a real database.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { type Db, openDatabase, schemaVersion } from "../../../../core/db/database.js";

/** The real migrations directory. */
const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), "../../../../core/schema");

/** A valid 64-character hex hash. */
const HASH = "a".repeat(64);

describe("migration 001: ingestion tables", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:", SCHEMA);
    db.prepare(
      "INSERT INTO ingest_runs (id, started_at, mode) VALUES (1, '2026-09-13T00:00:00Z', 'full')",
    ).run();
    db.prepare(
      "INSERT INTO source_files (id, kind, root, relative_path, byte_offset, size, inode, first_run_id, last_run_id) VALUES (1, 'log', '/r', 'projects/p/s.jsonl', 0, 10, 42, 1, 1)",
    ).run();
  });

  /**
   * Inserts a raw line with overridable fields.
   * @param fields - Column overrides.
   * @returns The insert result.
   */
  function insertLine(fields: Partial<Record<string, unknown>> = {}): Database.RunResult {
    const row = {
      source_file_id: 1,
      line_number: 1,
      byte_offset: 0,
      content_hash: HASH,
      bytes: Buffer.from("{}"),
      first_run_id: 1,
      ...fields,
    };
    return db
      .prepare(
        "INSERT INTO raw_lines (source_file_id, line_number, byte_offset, content_hash, bytes, first_run_id) VALUES (@source_file_id, @line_number, @byte_offset, @content_hash, @bytes, @first_run_id)",
      )
      .run(row);
  }

  it("is at schema version 1 with all four tables", () => {
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(1);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining(["ingest_report", "ingest_runs", "raw_lines", "source_files"]),
    );
  });

  it("stores a raw line and rejects the same bytes twice in one file", () => {
    insertLine();
    expect(() => insertLine({ line_number: 2, byte_offset: 3 })).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it("allows the same bytes in a different file", () => {
    db.prepare(
      "INSERT INTO source_files (id, kind, root, relative_path, byte_offset, size, first_run_id, last_run_id) VALUES (2, 'log', '/r', 'projects/p/t.jsonl', 0, 0, 1, 1)",
    ).run();
    insertLine();
    expect(insertLine({ source_file_id: 2 }).changes).toBe(1);
  });

  it.each([
    ["an unknown source file", { source_file_id: 99 }, /FOREIGN KEY constraint failed/],
    ["an unknown run", { first_run_id: 99 }, /FOREIGN KEY constraint failed/],
    ["line number 0", { line_number: 0 }, /CHECK constraint failed/],
    ["a negative offset", { byte_offset: -1 }, /CHECK constraint failed/],
    ["a short hash", { content_hash: "abc" }, /CHECK constraint failed/],
    ["text where bytes belong", { bytes: "text" }, /cannot store TEXT value in BLOB column/],
  ])("rejects a raw line with %s", (_name, fields, error) => {
    expect(() => insertLine(fields)).toThrow(error);
  });

  it.each([
    [
      "an unknown kind",
      "INSERT INTO source_files (kind, root, relative_path, byte_offset, size, first_run_id, last_run_id) VALUES ('other', '/r', 'x', 0, 0, 1, 1)",
    ],
    [
      "an offset past the end of the file",
      "INSERT INTO source_files (kind, root, relative_path, byte_offset, size, first_run_id, last_run_id) VALUES ('log', '/r', 'x', 11, 10, 1, 1)",
    ],
    [
      "a duplicate root and path",
      "INSERT INTO source_files (kind, root, relative_path, byte_offset, size, first_run_id, last_run_id) VALUES ('log', '/r', 'projects/p/s.jsonl', 0, 0, 1, 1)",
    ],
    [
      "an unknown ingest mode",
      "INSERT INTO ingest_runs (started_at, mode) VALUES ('t', 'partial')",
    ],
    ["a report for an unknown run", "INSERT INTO ingest_report (run_id, problem) VALUES (99, 'x')"],
  ])("rejects %s", (_name, sql) => {
    expect(() => db.prepare(sql).run()).toThrow(/constraint failed/);
  });

  it("indexes raw lines in the canonical (file, first run, line) order", () => {
    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'raw_lines_order'")
      .get();
    expect(index).toEqual({ name: "raw_lines_order" });
  });
});
