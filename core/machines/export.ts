/**
 * @file Writing this machine's records to the synced folder (D-103, step G7.1).
 *
 * Each of this machine's stored lines is scrubbed (core/machines/scrub.ts) and written to a gzip file
 * for its kind and the month it was first read. Only months that gained lines since the last export
 * are rewritten, so after the first export a sync provider moves one small file per ingest. Each file
 * is written to a temporary name and renamed, so another machine reads the old file or the new one,
 * never half of one. Lines read from other machines are never exported again.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { type Db, blobBytes } from "../db/database.js";
import type { SourceKind } from "../ingest/store.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "../install/private-files.js";
import {
  EXPORT_FORMAT,
  FOLDER_DIR,
  MACHINE_FILE,
  type MachineInfo,
  exportFileName,
} from "./folder.js";
import { lineOrigin, scrubLine } from "./scrub.js";

/** What an export needs. */
export interface ExportOptions {
  /** The synced folder. */
  readonly folder: string;
  /** This machine's ID. */
  readonly machineId: string;
  /** This machine's label. */
  readonly label: string;
  /** This machine's account, hashed. */
  readonly accountHash: string;
  /** The Nilometer version writing it. */
  readonly nilometerVersion: string;
  /** The clock. */
  readonly now: () => Date;
  /** Rewrite every month, not only those with new lines (the folder was new, or its files are missing). */
  readonly everything: boolean;
}

/** What an export did. */
export interface ExportSummary {
  /** Files rewritten, by name. */
  readonly files: readonly string[];
  /** Lines written across those files. */
  readonly lines: number;
  /** Lines not sent on because they're malformed; they stay reported on this machine. */
  readonly notSent: number;
}

/** SQL for this machine's own lines: not from another machine's folder. */
const LOCAL_LINES = `FROM raw_lines l
  JOIN source_files f ON f.id = l.source_file_id
  JOIN ingest_runs r ON r.id = l.first_run_id
  WHERE NOT EXISTS (SELECT 1 FROM machine_files mf WHERE mf.source_file_id = l.source_file_id)`;

/**
 * Writes a file through a temporary name, owner-only.
 * @param path - The final path.
 * @param data - Its contents.
 */
export function writeAtomically(path: string, data: Buffer | string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, data, { mode: PRIVATE_FILE_MODE });
  renameSync(temporary, path);
}

/**
 * Exports this machine's lines to the folder.
 * @param db - Open, migrated database, with this run's lines stored.
 * @param options - Folder, identity, account, clock, and whether to rewrite every month.
 * @returns The files written and line counts.
 */
export function exportThisMachine(db: Db, options: ExportOptions): ExportSummary {
  const dir = join(options.folder, FOLDER_DIR, options.machineId);
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const since = options.everything
    ? 0
    : (db.prepare("SELECT last_exported_line_id AS id FROM this_machine").get() as { id: number })
        .id;
  const top = (
    db.prepare(`SELECT COALESCE(MAX(l.id), 0) AS id ${LOCAL_LINES}`).get() as {
      id: number;
    }
  ).id;
  // A month is the UTC month of the run that first read the line: fixed once read, so a month's file
  // only ever gains lines.
  const months = db
    .prepare(
      `SELECT DISTINCT f.kind AS kind, substr(r.started_at, 1, 7) AS month ${LOCAL_LINES} AND l.id > ? ORDER BY 1, 2`,
    )
    .all(since) as { kind: SourceKind; month: string }[];
  const lines = db.prepare(
    `SELECT l.content_hash AS hash, f.relative_path AS path, l.bytes AS bytes ${LOCAL_LINES}
     AND f.kind = ? AND substr(r.started_at, 1, 7) = ? ORDER BY l.id`,
  );
  const files: string[] = [];
  let written = 0;
  let notSent = 0;
  for (const { kind, month } of months) {
    const out: string[] = [];
    for (const row of lines.iterate(kind, month) as Iterable<{
      hash: string;
      path: string;
      bytes: Uint8Array;
    }>) {
      const scrubbed = scrubLine(kind, blobBytes(row.bytes), lineOrigin(row.path, row.hash));
      if (scrubbed === null) {
        notSent += 1;
      } else {
        out.push(scrubbed);
      }
    }
    const name = exportFileName(kind, month);
    writeAtomically(join(dir, name), gzipSync(out.map((line) => `${line}\n`).join("")));
    files.push(name);
    written += out.length;
  }
  const info: MachineInfo = {
    format: EXPORT_FORMAT,
    machineId: options.machineId,
    label: options.label,
    accountHash: options.accountHash,
    exportedAt: options.now().toISOString(),
    nilometerVersion: options.nilometerVersion,
  };
  // Last, so another machine never sees a description newer than the files it describes.
  writeAtomically(join(dir, MACHINE_FILE), `${JSON.stringify(info, null, 2)}\n`);
  db.prepare("UPDATE this_machine SET last_exported_line_id = ?").run(top);
  return { files, lines: written, notSent };
}
