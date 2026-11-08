/**
 * @file Combining machines: setup, leaving, and the step each ingest runs (D-101 to D-103, G7).
 *
 * `nilometer machines folder <path>` names this machine and the synced folder. From then on every
 * ingest (so `report`, `view` and its Refresh) writes this machine's export to the folder and reads
 * every other machine's. Nothing runs in the background and nothing goes over the network: the
 * user's sync provider moves the files.
 */
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Db } from "../db/database.js";
import { finishRun, startRun } from "../ingest/store.js";
import { removePath } from "../install/private-files.js";
import { type AccountRead } from "./account.js";
import { type ExportSummary, exportThisMachine } from "./export.js";
import { FOLDER_DIR, MACHINE_FILE, cleanLabel } from "./folder.js";
import { type ImportSummary, importMachines } from "./import.js";

/** This machine's setup, once `machines folder` has run. */
export interface ThisMachine {
  /** Its random ID. */
  readonly machineId: string;
  /** Its label. */
  readonly label: string;
  /** The synced folder; null after `machines leave`. */
  readonly folder: string | null;
}

/**
 * Reads this machine's setup.
 * @param db - Open, migrated database.
 * @returns The setup, or null if `machines folder` never ran.
 */
export function readThisMachine(db: Db): ThisMachine | null {
  const row = db.prepare("SELECT machine_id, label, folder FROM this_machine").get() as
    { machine_id: string; label: string; folder: string | null } | undefined;
  return row === undefined
    ? null
    : { machineId: row.machine_id, label: row.label, folder: row.folder };
}

/** A setup the user asked for that can't be made. */
export class MachinesError extends Error {
  /**
   * Creates the error.
   * @param message - What's wrong, for the user.
   */
  constructor(message: string) {
    super(message);
    this.name = "MachinesError";
  }
}

/**
 * Sets the synced folder and this machine's label, making its ID on first use.
 * @param db - Open, migrated database.
 * @param folder - The folder, which must already exist (a missing one may be an unmounted drive).
 * @param label - The label; kept as it was when omitted, "This machine" on first use.
 * @param newId - ID maker, injectable for tests.
 * @returns The setup.
 * @throws {MachinesError} When the folder isn't an existing directory or the label isn't usable.
 */
export function setFolder(
  db: Db,
  folder: string,
  label: string | undefined,
  newId: () => string = randomUUID,
): ThisMachine {
  const path = resolve(folder);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new MachinesError(`${path} isn't a folder; create it, or point to your synced folder`);
  }
  const cleaned = label === undefined ? undefined : cleanLabel(label);
  if (cleaned === null) {
    throw new MachinesError(
      "a machine's name must be 1 to 60 characters, with no control characters",
    );
  }
  const current = readThisMachine(db);
  const next = {
    machineId: current?.machineId ?? newId(),
    label: cleaned ?? current?.label ?? "This machine",
    folder: path,
  };
  // A new folder gets every month, not just new lines: last_exported_line_id starts over.
  db.prepare(
    `INSERT INTO this_machine (id, machine_id, label, folder, last_exported_line_id) VALUES (1, ?, ?, ?, 0)
     ON CONFLICT (id) DO UPDATE SET label = excluded.label, folder = excluded.folder,
       last_exported_line_id = CASE WHEN this_machine.folder IS excluded.folder
         THEN this_machine.last_exported_line_id ELSE 0 END`,
  ).run(next.machineId, next.label, next.folder);
  return next;
}

/** What leaving did. */
export interface LeaveOutcome {
  /** The folder left, or null when none was set. */
  readonly folder: string | null;
  /** This machine's export folder, when it was removed. */
  readonly removed: string | null;
}

/**
 * Stops writing to and reading from the folder. Lines already read from other machines stay, as
 * every stored line does (D-002).
 * @param db - Open, migrated database.
 * @param removeExport - Also delete this machine's folder inside the synced folder.
 * @param remove - Removes a path and says whether it's gone; injectable for tests.
 * @returns The folder left and what was removed.
 * @throws {MachinesError} When the export folder was asked to be removed and is still there.
 */
export function leaveFolder(
  db: Db,
  removeExport: boolean,
  remove: (path: string) => boolean = removePath,
): LeaveOutcome {
  const current = readThisMachine(db);
  if (current?.folder == null) {
    return { folder: null, removed: null };
  }
  db.prepare("UPDATE this_machine SET folder = NULL, last_exported_line_id = 0").run();
  if (!removeExport) {
    return { folder: current.folder, removed: null };
  }
  const dir = join(current.folder, FOLDER_DIR, current.machineId);
  // Verified, not assumed: a removal that silently did nothing would leave the records shared (D-061).
  if (!remove(dir)) {
    throw new MachinesError(`couldn't remove ${dir}; delete it by hand`);
  }
  return { folder: current.folder, removed: dir };
}

/** What one ingest's machine step did. */
export type MachinesStep =
  | { readonly kind: "off" }
  | { readonly kind: "folder_missing"; readonly folder: string }
  | {
      readonly kind: "done";
      readonly machine: ThisMachine;
      /** The export, or why there was none. */
      readonly exported: ExportSummary | { readonly reason: string };
      readonly imported: ImportSummary;
    };

/** What the machine step needs. */
export interface MachinesStepOptions {
  /** This machine's account. */
  readonly account: AccountRead;
  /** The Nilometer version. */
  readonly nilometerVersion: string;
  /** The clock. */
  readonly now: () => Date;
}

/**
 * Writes this machine's export and reads the others', when a folder is set.
 * @param db - Open, migrated database, with this run's local lines stored.
 * @param options - Account, version, clock.
 * @returns What it did.
 */
export function runMachinesStep(db: Db, options: MachinesStepOptions): MachinesStep {
  const machine = readThisMachine(db);
  if (machine?.folder == null) {
    return { kind: "off" };
  }
  const folder = machine.folder;
  // Not created here: a missing synced folder is more often an unmounted drive than a new folder.
  if (!existsSync(folder)) {
    return { kind: "folder_missing", folder };
  }
  const own = join(folder, FOLDER_DIR, machine.machineId, MACHINE_FILE);
  const exported =
    options.account.kind === "ok"
      ? exportThisMachine(db, {
          folder,
          machineId: machine.machineId,
          label: machine.label,
          accountHash: options.account.accountHash,
          nilometerVersion: options.nilometerVersion,
          now: options.now,
          // This machine's files are gone from the folder (deleted, or a new folder): write them all.
          everything: !existsSync(own),
        })
      : { reason: options.account.reason };
  const runId = startRun(db, "incremental", options.now());
  const imported = importMachines(db, {
    folder,
    machineId: machine.machineId,
    account:
      options.account.kind === "ok"
        ? { accountHash: options.account.accountHash }
        : { reason: options.account.reason },
    runId,
    now: options.now,
  });
  finishRun(db, runId, options.now());
  return { kind: "done", machine, exported, imported };
}
