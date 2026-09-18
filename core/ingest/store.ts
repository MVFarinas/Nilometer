/**
 * @file Writing ingest runs, file positions, and raw lines to the database (docs/development.md P4.3, D-002).
 *
 * Raw lines are append-only and identified by (file, SHA-256 of their bytes). Storing a line that is
 * already there does nothing, which makes every read safe to repeat: after a rewrite, a `--full`
 * rescan, or a crash mid-run.
 */
import { createHash } from "node:crypto";

import type { Db } from "../db/database.js";
import type { CompleteLine, FileStat, FileState } from "./reader.js";

/** Kinds of source file; matches the `source_files.kind` CHECK constraint. */
export type SourceKind = "log" | "spool";

/** Ingest modes; matches the `ingest_runs.mode` CHECK constraint. */
export type IngestMode = "incremental" | "full";

/**
 * Hashes line bytes for identity.
 * @param bytes - The exact line bytes.
 * @returns Lowercase hex SHA-256.
 */
export function contentHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Records the start of an ingest run.
 * @param db - Open database.
 * @param mode - `incremental` or `full`.
 * @param now - Current time.
 * @returns The new run's ID.
 */
export function startRun(db: Db, mode: IngestMode, now: Date): number {
  const result = db
    .prepare("INSERT INTO ingest_runs (started_at, mode) VALUES (?, ?)")
    .run(now.toISOString(), mode);
  return Number(result.lastInsertRowid);
}

/**
 * Records the end of an ingest run. A run left without `finished_at` crashed or is still running.
 * @param db - Open database.
 * @param runId - The run to close.
 * @param now - Current time.
 */
export function finishRun(db: Db, runId: number, now: Date): void {
  db.prepare("UPDATE ingest_runs SET finished_at = ? WHERE id = ?").run(now.toISOString(), runId);
}

/** Identifies a file on disk for {@link findOrCreateSourceFile}. */
export interface SourceFileInput {
  /** `log` or `spool`. */
  readonly kind: SourceKind;
  /** Discovery root the file was found under. */
  readonly root: string;
  /** Path below the root. */
  readonly relativePath: string;
  /** Current size and inode. */
  readonly stat: FileStat;
}

/** One entry for the ingest report. */
export interface ProblemEntry {
  /** Run that found the problem. */
  readonly runId: number;
  /** File involved, or null for a run-level problem. */
  readonly fileId: number | null;
  /** Problem code, e.g. `file_rewritten`. */
  readonly problem: string;
  /** Human-readable detail, never a full log line; null when there is nothing to add. */
  readonly detail: string | null;
}

/** A source file row as the ingester needs it. */
export interface SourceFileRow {
  /** Row ID. */
  readonly id: number;
  /** Stored reading position, or null if this run just created the row. */
  readonly state: FileState | null;
}

/**
 * Finds a source file's row, creating it if this is the first time the file has been seen.
 * @param db - Open database.
 * @param file - Kind, root, path relative to the root, and current size and inode.
 * @param runId - Current run, recorded as the first run for a new file.
 * @returns The row ID and the previously stored state (null for a new file).
 */
export function findOrCreateSourceFile(
  db: Db,
  file: SourceFileInput,
  runId: number,
): SourceFileRow {
  const existing = db
    .prepare(
      "SELECT id, byte_offset, line_count, size, inode FROM source_files WHERE root = ? AND relative_path = ?",
    )
    .get(file.root, file.relativePath) as
    | { id: number; byte_offset: number; line_count: number; size: number; inode: number | null }
    | undefined;
  if (existing !== undefined) {
    return {
      id: existing.id,
      state: {
        byteOffset: existing.byte_offset,
        lineCount: existing.line_count,
        size: existing.size,
        inode: existing.inode,
      },
    };
  }
  // A new file starts at offset 0 with no lines; its real position is saved after reading.
  const result = db
    .prepare(
      "INSERT INTO source_files (kind, root, relative_path, byte_offset, line_count, size, inode, first_run_id, last_run_id) VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?)",
    )
    .run(file.kind, file.root, file.relativePath, file.stat.size, file.stat.inode, runId, runId);
  return { id: Number(result.lastInsertRowid), state: null };
}

/**
 * Saves a file's reading position after this run read it.
 * @param db - Open database.
 * @param fileId - Source file row ID.
 * @param state - New offset, line count, size, and inode.
 * @param runId - Current run.
 */
export function saveFileState(db: Db, fileId: number, state: FileState, runId: number): void {
  db.prepare(
    "UPDATE source_files SET byte_offset = ?, line_count = ?, size = ?, inode = ?, last_run_id = ? WHERE id = ?",
  ).run(state.byteOffset, state.lineCount, state.size, state.inode, runId, fileId);
}

/**
 * Returns a function that stores raw lines for one file, preparing the statement once.
 * @param db - Open database.
 * @param fileId - Source file the lines belong to.
 * @param runId - Current run, recorded as the first run for newly stored lines.
 * @returns A function storing one line; it returns true if the line was new.
 */
export function rawLineWriter(
  db: Db,
  fileId: number,
  runId: number,
): (line: CompleteLine) => boolean {
  // OR IGNORE leans on UNIQUE (source_file_id, content_hash): a line seen before keeps its first
  // run and line number, which is exactly the identity rule in fixtures/README.md.
  const insert = db.prepare(
    "INSERT OR IGNORE INTO raw_lines (source_file_id, line_number, byte_offset, content_hash, bytes, first_run_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  return (line) =>
    insert.run(fileId, line.lineNumber, line.offset, contentHash(line.bytes), line.bytes, runId)
      .changes === 1;
}

/**
 * Records a run-level or file-level problem in the ingest report.
 * @param db - Open database.
 * @param entry - Run, optional file, problem code, and optional detail.
 */
export function recordProblem(db: Db, entry: ProblemEntry): void {
  db.prepare(
    "INSERT INTO ingest_report (run_id, source_file_id, problem, detail) VALUES (?, ?, ?, ?)",
  ).run(entry.runId, entry.fileId, entry.problem, entry.detail);
}
