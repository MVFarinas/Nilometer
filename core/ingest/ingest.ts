/**
 * @file One ingest run over session logs: discover, read new lines, store them (docs/development.md P4.3).
 *
 * Implements README § How it works (copy logs into SQLite before Claude Code deletes them) with
 * D-002 and D-003. Derived tables (classification, requests, events) are refreshed from raw lines by
 * later steps; this module only makes sure every complete line on disk is stored exactly once.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Db } from "../db/database.js";
import { discoverLogFiles } from "./discover.js";
import { DEFAULT_CHUNK_SIZE, type FileStat, readCompleteLines, readStart } from "./reader.js";
import {
  type IngestMode,
  type SourceKind,
  finishRun,
  findOrCreateSourceFile,
  rawLineWriter,
  recordProblem,
  saveFileState,
  startRun,
} from "./store.js";

/** Options for {@link ingestLogs}. */
export interface IngestOptions {
  /** Roots from `resolveRoots`, each containing `projects/`. */
  readonly roots: readonly string[];
  /** `incremental` resumes each file at its stored offset; `full` rereads every file from 0. */
  readonly mode: IngestMode;
  /** Clock for run timestamps. */
  readonly now: () => Date;
  /** Bytes per read; defaults to the reader's chunk size. */
  readonly chunkSize?: number;
  /** File stat, injectable for tests; defaults to the real filesystem. */
  readonly stat?: (path: string) => FileStat;
  /**
   * Data directory holding the hook's spool (`statusline.spool.jsonl`). When given and the spool
   * exists, it is read in the same run as the logs (D-008).
   */
  readonly spoolDir?: string;
  /** The platform, for tests; defaults to this one. Decides whether stored paths need {@link normalizeWindowsRelativePaths}. */
  readonly platform?: NodeJS.Platform;
}

/** What one run did. */
export interface IngestSummary {
  /** The run's ID. */
  readonly runId: number;
  /** Files examined, logs and spool together. */
  readonly files: number;
  /** Whether a spool file was found and read this run. */
  readonly spoolRead: boolean;
  /** Complete lines read from disk this run. */
  readonly linesRead: number;
  /** Lines stored for the first time. */
  readonly linesStored: number;
  /** Lines read that were already stored (rereads after a rewrite or a full scan). */
  readonly linesAlreadyStored: number;
  /** Files whose rewrite was detected and which were reread from the start. */
  readonly filesRewritten: number;
}

/**
 * Reads a file's size and inode.
 * @param path - File path.
 * @param statImpl - Stat function, injectable so a zero inode can be tested.
 * @returns Size in bytes and inode (null when the platform reports 0).
 */
export function statFile(
  path: string,
  statImpl: (path: string) => { size: number; ino: number } = statSync,
): FileStat {
  const stats = statImpl(path);
  // Some filesystems report inode 0 when they have none; treat that as unknown, not as a value.
  return { size: stats.size, inode: stats.ino === 0 ? null : stats.ino };
}

/** File name of the hook's spool inside the data directory (hooks/statusline.sh). */
export const SPOOL_FILE = "statusline.spool.jsonl";

/** Counts accumulated while reading files in one run. */
interface RunCounts {
  /** Files examined. */
  files: number;
  /** Complete lines read. */
  linesRead: number;
  /** Lines stored for the first time. */
  linesStored: number;
  /** Files detected as rewritten. */
  filesRewritten: number;
}

/** A file to ingest. */
interface FileRef {
  /** `log` or `spool`. */
  readonly kind: SourceKind;
  /** Root the path is relative to. */
  readonly root: string;
  /** Path below the root. */
  readonly relativePath: string;
}

/** Shared state of one run while its files are read. */
interface RunContext {
  /** The run's ID. */
  readonly runId: number;
  /** The run's options. */
  readonly options: IngestOptions;
  /** Stat function for current size and inode. */
  readonly stat: (path: string) => FileStat;
  /** Counters updated as files are read. */
  readonly counts: RunCounts;
}

/**
 * Rewrites log paths stored with Windows separators to use `/` (D-049).
 *
 * Until 2026-09-17, discovery joined relative paths with the platform separator, so a database
 * built on Windows holds `projects\...`. Discovery now always uses `/`; without this rewrite every
 * existing file would look new and its lines would be stored again.
 * @param db - Open, migrated database.
 * @param platform - The platform. Only Windows rows are rewritten: `\` can't appear in a Windows
 *   file name, so there it is always a separator, but it can be part of a POSIX file name.
 * @returns How many rows were rewritten.
 */
export function normalizeWindowsRelativePaths(db: Db, platform: NodeJS.Platform): number {
  if (platform !== "win32") {
    return 0;
  }
  return db
    .prepare(
      "UPDATE source_files SET relative_path = replace(relative_path, char(92), '/') WHERE kind = 'log' AND instr(relative_path, char(92)) > 0",
    )
    .run().changes;
}

/**
 * Reads one file's new complete lines into raw_lines and saves its position, in one transaction.
 * @param db - Open, migrated database.
 * @param file - Kind, root, and path below the root.
 * @param run - The current run's ID, options, stat function, and counters to update.
 */
function ingestFile(db: Db, file: FileRef, run: RunContext): void {
  const { runId, options, counts } = run;
  const path = join(file.root, file.relativePath);
  const current = run.stat(path);
  counts.files += 1;
  // One transaction per file: its lines and its new offset commit together, so a crash can
  // never save an offset past lines that weren't stored.
  db.transaction(() => {
    const row = findOrCreateSourceFile(db, { ...file, stat: current }, runId);
    const start =
      options.mode === "full"
        ? { byteOffset: 0, lineCount: 0, rewritten: false }
        : readStart(row.state, current);
    if (start.rewritten) {
      counts.filesRewritten += 1;
      recordProblem(db, {
        runId,
        fileId: row.id,
        problem: "file_rewritten",
        detail: `size ${current.size} is below the stored offset ${row.state?.byteOffset ?? 0}, or the inode changed; reread from the start`,
      });
    }
    const store = rawLineWriter(db, row.id, runId);
    const result = readCompleteLines(
      path,
      start,
      (line) => {
        if (store(line)) {
          counts.linesStored += 1;
        }
      },
      options.chunkSize ?? DEFAULT_CHUNK_SIZE,
    );
    counts.linesRead += result.linesRead;
    saveFileState(
      db,
      row.id,
      {
        byteOffset: result.byteOffset,
        lineCount: result.lineCount,
        size: current.size,
        inode: current.inode,
      },
      runId,
    );
  })();
}

/**
 * Runs one ingest over every log file under the given roots, then the spool if one is configured.
 * @param db - Open, migrated database.
 * @param options - Roots, mode, clock, optional spool directory, chunk size, and stat.
 * @returns Counts describing the run.
 * @throws {Error} Whatever reading a file throws; each file is written in its own transaction, so
 *   files finished before the error stay stored, and the run is left unfinished.
 */
export function ingestLogs(db: Db, options: IngestOptions): IngestSummary {
  // Before comparing discovered paths with stored ones, so a Windows database's files aren't read twice.
  normalizeWindowsRelativePaths(db, options.platform ?? process.platform);
  const stat = options.stat ?? ((path: string) => statFile(path));
  const runId = startRun(db, options.mode, options.now());
  const counts: RunCounts = { files: 0, linesRead: 0, linesStored: 0, filesRewritten: 0 };
  const run = { runId, options, stat, counts };
  for (const root of options.roots) {
    for (const relativePath of discoverLogFiles(root)) {
      ingestFile(db, { kind: "log", root, relativePath }, run);
    }
  }
  const spoolRead =
    options.spoolDir !== undefined && existsSync(join(options.spoolDir, SPOOL_FILE));
  if (spoolRead) {
    ingestFile(db, { kind: "spool", root: options.spoolDir, relativePath: SPOOL_FILE }, run);
  }
  finishRun(db, runId, options.now());
  return {
    runId,
    files: counts.files,
    spoolRead,
    linesRead: counts.linesRead,
    linesStored: counts.linesStored,
    linesAlreadyStored: counts.linesRead - counts.linesStored,
    filesRewritten: counts.filesRewritten,
  };
}
