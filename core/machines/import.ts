/**
 * @file Reading other machines' records from the synced folder (D-103, step G7.2).
 *
 * Every other machine's folder is checked before anything in it is stored: a valid machine.json, the
 * same account as this machine, and files with export names and sane sizes. Lines are stored in
 * raw_lines as ordinary `log` and `spool` lines, so the classifier and every view read them as they
 * read this machine's (D-102). Each line's origin is recorded, and a line already stored from any
 * file is skipped, so a rewritten month, or a machine whose folder was made again, adds nothing twice.
 * A refused machine or file is recorded with its reason, never merged.
 */
import { createHash } from "node:crypto";
import { type Dirent, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { type Db, transaction } from "../db/database.js";
import { isObject } from "../ingest/classify.js";
import {
  contentHash,
  findOrCreateSourceFile,
  recordProblem,
  saveFileState,
} from "../ingest/store.js";
import {
  FOLDER_DIR,
  MACHINE_FILE,
  MACHINE_ID,
  MAX_EXPANDED_BYTES,
  MAX_FILE_BYTES,
  MAX_LINE_BYTES,
  MAX_MACHINE_FILE_BYTES,
  parseExportFileName,
  parseMachineInfo,
} from "./folder.js";
import { EXPORT_LINE_FIELD } from "./scrub.js";

/** What an import needs. */
export interface ImportOptions {
  /** The synced folder. */
  readonly folder: string;
  /** This machine's ID, whose own folder is skipped. */
  readonly machineId: string;
  /** This machine's account hash, or why it has none (then every machine is refused). */
  readonly account: { readonly accountHash: string } | { readonly reason: string };
  /** The ingest run storing the lines. */
  readonly runId: number;
  /** The clock. */
  readonly now: () => Date;
  /** Directory listing, injectable for tests. */
  readonly listDir?: (path: string) => Dirent[];
}

/** One machine found in the folder. */
export interface MachineFound {
  /** Its ID. */
  readonly machineId: string;
  /** Its label, when its machine.json could be read. */
  readonly label: string | null;
  /** Whether its lines were merged. */
  readonly status: "merged" | "refused";
  /** Why it was refused. */
  readonly reason: string | null;
  /** Lines stored for the first time this run. */
  readonly linesStored: number;
}

/** What an import did. */
export interface ImportSummary {
  /** Every other machine found. */
  readonly machines: readonly MachineFound[];
  /** Entries ignored: names that aren't machines or export files, files too large or unreadable. */
  readonly ignored: number;
}

/**
 * The root recorded for a machine's files: its ID, not the folder's path, which differs per machine
 * and can move without its lines being stored again.
 * @param machineId - The machine's ID.
 * @returns The `source_files.root` value.
 */
export function machineRoot(machineId: string): string {
  return `machine:${machineId}`;
}

/**
 * Lists a directory, treating an unreadable one as empty.
 * @param listDir - The listing function.
 * @param path - The directory.
 * @returns Its entries, sorted by name for a deterministic order.
 */
function list(listDir: (path: string) => Dirent[], path: string): Dirent[] {
  try {
    return [...listDir(path)].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch {
    return [];
  }
}

/**
 * Reads another machine's description, refusing it for any reason found.
 * @param dir - The machine's folder.
 * @param name - The folder's name.
 * @param options - This machine's account.
 * @returns Its label and status.
 */
function checkMachine(
  dir: string,
  name: string,
  options: ImportOptions,
): {
  label: string | null;
  exportedAt: string | null;
  version: string | null;
  refused: string | null;
} {
  const path = join(dir, MACHINE_FILE);
  let text: string;
  try {
    if (statSync(path).size > MAX_MACHINE_FILE_BYTES) {
      return {
        label: null,
        exportedAt: null,
        version: null,
        refused: "its machine.json is too large",
      };
    }
    text = readFileSync(path, "utf8");
  } catch {
    // A machine whose description hasn't synced yet is refused this run and read on a later one.
    return {
      label: null,
      exportedAt: null,
      version: null,
      refused: "its machine.json isn't there yet",
    };
  }
  const parsed = parseMachineInfo(text, name);
  if (parsed.kind === "bad") {
    return { label: null, exportedAt: null, version: null, refused: parsed.reason };
  }
  const { info } = parsed;
  const known = { label: info.label, exportedAt: info.exportedAt, version: info.nilometerVersion };
  if (!("accountHash" in options.account)) {
    return { ...known, refused: `this machine's account is unknown: ${options.account.reason}` };
  }
  if (info.accountHash !== options.account.accountHash) {
    return { ...known, refused: "it's logged in to a different Claude account" };
  }
  return { ...known, refused: null };
}

/**
 * Stores one export file's new lines.
 * @param db - Open, migrated database.
 * @param machineId - The machine it came from.
 * @param name - Its file name, already checked.
 * @param kind - `log` or `spool`.
 * @param data - Its compressed bytes.
 * @param runId - This run.
 * @returns Lines stored for the first time; -1 when the file couldn't be expanded.
 */
function importFile(
  db: Db,
  machineId: string,
  name: string,
  kind: "log" | "spool",
  data: Buffer,
  runId: number,
): number {
  const sha = createHash("sha256").update(data).digest("hex");
  const root = machineRoot(machineId);
  const seen = db
    .prepare(
      "SELECT mf.file_sha256 AS sha FROM machine_files mf JOIN source_files f ON f.id = mf.source_file_id WHERE f.root = ? AND f.relative_path = ?",
    )
    .get(root, name) as { sha: string } | undefined;
  if (seen?.sha === sha) {
    return 0;
  }
  let expanded: Buffer;
  try {
    expanded = gunzipSync(data, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch {
    // Truncated mid-sync, or not gzip: tried again next run, when the provider has the whole file.
    return -1;
  }
  const insertLine = db.prepare(
    "INSERT OR IGNORE INTO raw_lines (source_file_id, line_number, byte_offset, content_hash, bytes, first_run_id) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const known = db.prepare("SELECT 1 FROM machine_lines WHERE origin = ?");
  const insertOrigin = db.prepare("INSERT INTO machine_lines (raw_line_id, origin) VALUES (?, ?)");
  return transaction(db, () => {
    const file = findOrCreateSourceFile(
      db,
      { kind, root, relativePath: name, stat: { size: expanded.length, inode: null } },
      runId,
    );
    db.prepare(
      "INSERT INTO machine_files (source_file_id, machine_id, file_sha256) VALUES (?, ?, ?) ON CONFLICT (source_file_id) DO UPDATE SET file_sha256 = excluded.file_sha256",
    ).run(file.id, machineId, sha);
    let stored = 0;
    let rejected = 0;
    let offset = 0;
    let lineNumber = 0;
    while (offset < expanded.length) {
      const end = expanded.indexOf(0x0a, offset);
      // An export always ends with a newline; a last line without one isn't complete (D-003).
      if (end === -1) {
        break;
      }
      const bytes = expanded.subarray(offset, end);
      lineNumber += 1;
      const at = offset;
      offset = end + 1;
      const origin = bytes.length <= MAX_LINE_BYTES ? originOf(bytes) : null;
      if (origin === null) {
        rejected += 1;
        continue;
      }
      if (known.get(origin) !== undefined) {
        continue;
      }
      const result = insertLine.run(file.id, lineNumber, at, contentHash(bytes), bytes, runId);
      if (result.changes === 1) {
        insertOrigin.run(Number(result.lastInsertRowid), origin);
        stored += 1;
      }
    }
    if (rejected > 0) {
      recordProblem(db, {
        runId,
        fileId: file.id,
        problem: "machine_line_rejected",
        detail: `${rejected} lines from another machine were too long or carried no origin; not stored`,
      });
    }
    saveFileState(
      db,
      file.id,
      { byteOffset: offset, lineCount: lineNumber, size: expanded.length, inode: null },
      runId,
    );
    return stored;
  });
}

/**
 * Reads a line's origin.
 * @param bytes - A line from an export file.
 * @returns Its origin, or null when it isn't a JSON object with one.
 */
export function originOf(bytes: Buffer): string | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const origin = isObject(value) ? value[EXPORT_LINE_FIELD] : null;
  return typeof origin === "string" && /^[0-9a-f]{32}$/.test(origin) ? origin : null;
}

/**
 * Reads every other machine in the folder.
 * @param db - Open, migrated database.
 * @param options - Folder, this machine, its account, run, clock.
 * @returns The machines found and how many entries were ignored.
 */
export function importMachines(db: Db, options: ImportOptions): ImportSummary {
  const listDir = options.listDir ?? ((path: string) => readdirSync(path, { withFileTypes: true }));
  const base = join(options.folder, FOLDER_DIR);
  const machines: MachineFound[] = [];
  let ignored = 0;
  /**
   * Counts and records an entry that isn't read.
   * @param detail - What it was, without content.
   */
  const ignore = (detail: string): void => {
    ignored += 1;
    recordProblem(db, {
      runId: options.runId,
      fileId: null,
      problem: "machine_entry_ignored",
      detail,
    });
  };
  const upsert = db.prepare(
    `INSERT INTO machines (machine_id, label, exported_at, nilometer_version, status, reason, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (machine_id) DO UPDATE SET label = excluded.label, exported_at = excluded.exported_at,
       nilometer_version = excluded.nilometer_version, status = excluded.status, reason = excluded.reason,
       checked_at = excluded.checked_at`,
  );
  for (const entry of list(listDir, base)) {
    if (entry.name === options.machineId) {
      continue;
    }
    // Only folders named by a machine ID: a sync provider's own files, or a copy, are left alone.
    if (!entry.isDirectory() || !MACHINE_ID.test(entry.name)) {
      ignore(`not a machine folder: ${entry.name.slice(0, 80)}`);
      continue;
    }
    const dir = join(base, entry.name);
    const checked = checkMachine(dir, entry.name, options);
    let linesStored = 0;
    if (checked.refused === null) {
      for (const file of list(listDir, dir)) {
        if (file.name === MACHINE_FILE) {
          continue;
        }
        const parsed = file.isFile() ? parseExportFileName(file.name) : null;
        if (parsed === null) {
          // Conflict copies ("logs-2026-11 (1).jsonl.gz"), placeholders and temporary files.
          ignore(`not an export file in machine ${entry.name}: ${file.name.slice(0, 80)}`);
          continue;
        }
        const path = join(dir, file.name);
        let data: Buffer;
        try {
          if (statSync(path).size > MAX_FILE_BYTES) {
            ignore(`too large: ${entry.name}/${file.name}`);
            continue;
          }
          data = readFileSync(path);
        } catch {
          ignore(`unreadable: ${entry.name}/${file.name}`);
          continue;
        }
        const stored = importFile(db, entry.name, file.name, parsed.kind, data, options.runId);
        if (stored < 0) {
          ignore(`not complete yet: ${entry.name}/${file.name}`);
        } else {
          linesStored += stored;
        }
      }
    }
    upsert.run(
      entry.name,
      checked.label,
      checked.exportedAt,
      checked.version,
      checked.refused === null ? "merged" : "refused",
      checked.refused,
      options.now().toISOString(),
    );
    machines.push({
      machineId: entry.name,
      label: checked.label,
      status: checked.refused === null ? "merged" : "refused",
      reason: checked.refused,
      linesStored,
    });
  }
  return { machines, ignored };
}
