/**
 * @file One ingest run over session logs: discover, read new lines, store them (docs/development.md P4.3).
 *
 * Implements README § How it works (copy logs into SQLite before Claude Code deletes them) with
 * D-002 and D-003. Derived tables (classification, requests, events) are refreshed from raw lines by
 * later steps; this module only makes sure every complete line on disk is stored exactly once.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { type Db, transaction } from "../db/database.js";
import { type ListDir, discoverLogFiles } from "./discover.js";
import {
  DEFAULT_CHUNK_SIZE,
  type FileStat,
  readCompleteLines,
  readStart,
  storedInode,
} from "./reader.js";
import {
  type IngestMode,
  MACHINE_ROOT_PREFIX,
  type SourceKind,
  contentHash,
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
  /** Directory listing, injectable for tests; defaults to the real filesystem. */
  readonly listDir?: ListDir;
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
  /**
   * Session logs examined, without the status line spool. Reported separately because "2 files"
   * for one session log and the spool reads as a miscount to someone who has one log (R2.5).
   */
  readonly logFiles: number;
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
  /**
   * Status line readings not stored again because the same line is already stored from the spool at
   * another path: the data folder was moved or copied (D-104). Counted, and recorded per file.
   */
  readonly spoolLinesFromOtherPath: number;
  /**
   * Files and folders this run couldn't read: deleted between discovery and open, or permission
   * denied. They're skipped and counted, never fatal (D-050). Claude Code deletes session logs
   * after 30 days, so a file can vanish mid-run with no attacker involved.
   */
  readonly unreadable: number;
}

/**
 * Reads a file's size and inode. The inode is read as a bigint: an NTFS file ID is often above 2^53,
 * where a number rounds it and node:sqlite then refuses to read it back (M17).
 * @param path - File path.
 * @param statImpl - Stat function, injectable so a zero or very large inode can be tested.
 * @returns Size in bytes and the inode as stored (null when the platform reports 0).
 */
export function statFile(
  path: string,
  statImpl: (path: string) => { size: number | bigint; ino: number | bigint } = (p) =>
    statSync(p, { bigint: true }),
): FileStat {
  const stats = statImpl(path);
  const ino = BigInt(stats.ino);
  // Some filesystems report inode 0 when they have none; treat that as unknown, not as a value.
  return { size: Number(stats.size), inode: ino === 0n ? null : storedInode(ino) };
}

/**
 * Error codes that mean a file or folder couldn't be read, so it is counted and skipped. Anything
 * else, such as a database error, is a fault and is raised: M17 found a SQLite range error counted as
 * an unreadable file, which hid it.
 */
export const UNREADABLE_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "EACCES",
  "EPERM",
  "EBUSY",
  "ELOOP",
  "ENAMETOOLONG",
  "EIO",
]);

/** File name of the hook's spool inside the data directory (hooks/statusline.sh). */
export const SPOOL_FILE = "statusline.spool.jsonl";

/** Counts accumulated while reading files in one run. */
interface RunCounts {
  /** Files examined. */
  files: number;
  /** Session logs examined, without the spool. */
  logFiles: number;
  /** Files and folders skipped because they couldn't be read. */
  unreadable: number;
  /** Complete lines read. */
  linesRead: number;
  /** Lines stored for the first time. */
  linesStored: number;
  /** Files detected as rewritten. */
  filesRewritten: number;
  /** Spool lines already stored from the spool at another path (D-104). */
  spoolLinesFromOtherPath: number;
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
  // node:sqlite types changes as number or bigint; a row count here never nears 2^53.
  return Number(
    db
      .prepare(
        "UPDATE source_files SET relative_path = replace(relative_path, char(92), '/') WHERE kind = 'log' AND instr(relative_path, char(92)) > 0",
      )
      .run().changes,
  );
}

/**
 * Builds a check for whether a spool line is already stored from this machine's spool at another
 * path (D-104).
 *
 * Source files are known by path, so a data folder that was moved or copied (`--data-dir`,
 * `NILOMETER_HOME`) makes the same spool a new file, read from its first byte. Without this check
 * every reading it already held was stored a second time: G7.6 found 25,706 doubled on one machine,
 * and window readings listed twice. A spool line carries its own capture time and payload, and one
 * file already stores identical lines once, so identical bytes at another path are the same reading.
 * Another machine's readings are left out: they never share this machine's spool, and the importer
 * has its own origin check (D-103).
 * @param db - Open database, inside the file's transaction.
 * @param fileId - The spool file being read.
 * @returns A check by line bytes, or null when no other local spool path is stored.
 */
function spoolStoredElsewhere(db: Db, fileId: number): ((bytes: Buffer) => boolean) | null {
  const others = (
    db
      .prepare(
        // By root, not by machine_files: ingest also runs on databases from before migration 033.
        "SELECT id FROM source_files WHERE kind = 'spool' AND id <> ? AND substr(root, 1, length(?)) <> ?",
      )
      .all(fileId, MACHINE_ROOT_PREFIX, MACHINE_ROOT_PREFIX) as { id: number }[]
  ).map((row) => row.id);
  if (others.length === 0) {
    return null;
  }
  // The UNIQUE (source_file_id, content_hash) index answers each lookup; there are only ever a few
  // spool paths, so the IN list stays short.
  const seen = db.prepare(
    `SELECT 1 FROM raw_lines WHERE source_file_id IN (${others.map(() => "?").join(", ")}) AND content_hash = ? LIMIT 1`,
  );
  return (bytes) => seen.get(...others, contentHash(bytes)) !== undefined;
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
  if (file.kind === "log") {
    counts.logFiles += 1;
  }
  // One transaction per file: its lines and its new offset commit together, so a crash can
  // never save an offset past lines that weren't stored.
  transaction(db, () => {
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
    const storedElsewhere = file.kind === "spool" ? spoolStoredElsewhere(db, row.id) : null;
    let fromOtherPath = 0;
    const result = readCompleteLines(
      path,
      start,
      (line) => {
        if (storedElsewhere?.(line.bytes) === true) {
          fromOtherPath += 1;
          return;
        }
        if (store(line)) {
          counts.linesStored += 1;
        }
      },
      options.chunkSize ?? DEFAULT_CHUNK_SIZE,
    );
    if (fromOtherPath > 0) {
      counts.spoolLinesFromOtherPath += fromOtherPath;
      recordProblem(db, {
        runId,
        fileId: row.id,
        problem: "spool_line_stored_from_other_path",
        detail: `${fromOtherPath} status line readings are already stored from the spool at another path (the data folder was moved or copied); not stored again`,
      });
    }
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
  });
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
  const counts: RunCounts = {
    logFiles: 0,
    files: 0,
    unreadable: 0,
    linesRead: 0,
    linesStored: 0,
    filesRewritten: 0,
    spoolLinesFromOtherPath: 0,
  };
  const run = { runId, options, stat, counts };
  for (const root of options.roots) {
    for (const relativePath of discoverLogFiles(root, options.listDir, () => {
      counts.unreadable += 1;
    })) {
      readFileOrCount(db, { kind: "log", root, relativePath }, run);
    }
  }
  const spoolRead =
    options.spoolDir !== undefined && existsSync(join(options.spoolDir, SPOOL_FILE));
  if (spoolRead) {
    readFileOrCount(db, { kind: "spool", root: options.spoolDir, relativePath: SPOOL_FILE }, run);
  }
  finishRun(db, runId, options.now());
  return {
    runId,
    files: counts.files,
    logFiles: counts.logFiles,
    spoolRead,
    linesRead: counts.linesRead,
    linesStored: counts.linesStored,
    linesAlreadyStored: counts.linesRead - counts.linesStored,
    filesRewritten: counts.filesRewritten,
    spoolLinesFromOtherPath: counts.spoolLinesFromOtherPath,
    unreadable: counts.unreadable,
  };
}

/**
 * Ingests one file, counting it as unreadable instead of failing the run (D-050).
 *
 * A session log can be deleted between discovery and open (Claude Code removes them after 30 days),
 * or be unreadable. Either would otherwise abort the run with a stack trace, leaving the run
 * unfinished and, during `init`, landing after settings.json was already changed.
 * @param db - Open, migrated database.
 * @param file - Kind, root, and path below the root.
 * @param run - The current run's context.
 * @throws {unknown} Anything that isn't a filesystem error, since that would be a bug.
 */
function readFileOrCount(db: Db, file: FileRef, run: RunContext): void {
  try {
    ingestFile(db, file, run);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined || !UNREADABLE_CODES.has(code)) {
      throw error;
    }
    run.counts.unreadable += 1;
    // Which file and why, so a skip can be diagnosed from the database, not only counted (M17).
    recordProblem(db, {
      runId: run.runId,
      fileId: null,
      problem: "file_unreadable",
      detail: `${code} reading ${file.kind} file ${file.relativePath}`,
    });
  }
}
