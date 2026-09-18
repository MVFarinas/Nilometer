/**
 * @file Unit tests for core/ingest/store.ts (docs/development.md P4.3).
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { type Db, openDatabase } from "../../../../core/db/database.js";
import {
  contentHash,
  finishRun,
  findOrCreateSourceFile,
  rawLineWriter,
  recordProblem,
  saveFileState,
  startRun,
} from "../../../../core/ingest/store.js";

/** The real migrations directory. */
const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), "../../../../core/schema");

/** A fixed time. */
const T0 = new Date("2026-09-13T01:00:00Z");

describe("contentHash", () => {
  it("is the lowercase hex SHA-256 of the bytes", () => {
    expect(contentHash(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(contentHash(Buffer.alloc(0))).toBe(createHash("sha256").digest("hex"));
  });
});

describe("store operations", () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(":memory:", SCHEMA);
  });

  it("starts and finishes runs with their mode and times", () => {
    const run = startRun(db, "full", T0);
    expect(
      db.prepare("SELECT mode, started_at, finished_at FROM ingest_runs WHERE id = ?").get(run),
    ).toEqual({
      mode: "full",
      started_at: "2026-09-13T01:00:00.000Z",
      finished_at: null,
    });
    finishRun(db, run, new Date("2026-09-13T01:00:05Z"));
    expect(db.prepare("SELECT finished_at FROM ingest_runs WHERE id = ?").get(run)).toEqual({
      finished_at: "2026-09-13T01:00:05.000Z",
    });
  });

  it("creates a source file once, then returns its stored state", () => {
    const run = startRun(db, "incremental", T0);
    const file = {
      kind: "log" as const,
      root: "/r",
      relativePath: "projects/p/s.jsonl",
      stat: { size: 10, inode: 5 },
    };
    const created = findOrCreateSourceFile(db, file, run);
    expect(created.state).toBeNull();
    saveFileState(db, created.id, { byteOffset: 8, lineCount: 2, size: 10, inode: 5 }, run);
    const found = findOrCreateSourceFile(db, file, run);
    expect(found).toEqual({
      id: created.id,
      state: { byteOffset: 8, lineCount: 2, size: 10, inode: 5 },
    });
  });

  it("records the run that last read a file", () => {
    const first = startRun(db, "incremental", T0);
    const file = {
      kind: "log" as const,
      root: "/r",
      relativePath: "x.jsonl",
      stat: { size: 0, inode: null },
    };
    const { id } = findOrCreateSourceFile(db, file, first);
    const second = startRun(db, "incremental", T0);
    saveFileState(db, id, { byteOffset: 0, lineCount: 0, size: 0, inode: null }, second);
    expect(
      db.prepare("SELECT first_run_id, last_run_id FROM source_files WHERE id = ?").get(id),
    ).toEqual({
      first_run_id: first,
      last_run_id: second,
    });
  });

  it("stores a raw line once; the same bytes again keep the first line number and run", () => {
    const run1 = startRun(db, "incremental", T0);
    const { id } = findOrCreateSourceFile(
      db,
      { kind: "log", root: "/r", relativePath: "x.jsonl", stat: { size: 3, inode: 1 } },
      run1,
    );
    const bytes = Buffer.from("{}");
    expect(rawLineWriter(db, id, run1)({ bytes, offset: 0, lineNumber: 1 })).toBe(true);
    const run2 = startRun(db, "full", T0);
    expect(rawLineWriter(db, id, run2)({ bytes, offset: 9, lineNumber: 4 })).toBe(false);
    expect(
      db.prepare("SELECT line_number, byte_offset, first_run_id, bytes FROM raw_lines").all(),
    ).toEqual([{ line_number: 1, byte_offset: 0, first_run_id: run1, bytes }]);
  });

  it("records problems with and without a file", () => {
    const run = startRun(db, "incremental", T0);
    const { id } = findOrCreateSourceFile(
      db,
      { kind: "log", root: "/r", relativePath: "x.jsonl", stat: { size: 0, inode: null } },
      run,
    );
    recordProblem(db, { runId: run, fileId: id, problem: "file_rewritten", detail: "why" });
    recordProblem(db, { runId: run, fileId: null, problem: "run_level", detail: null });
    expect(
      db.prepare("SELECT source_file_id, problem, detail FROM ingest_report ORDER BY id").all(),
    ).toEqual([
      { source_file_id: id, problem: "file_rewritten", detail: "why" },
      { source_file_id: null, problem: "run_level", detail: null },
    ]);
  });
});
