/**
 * @file The install record: what `init` changed, so `uninstall` can put it back.
 *
 * Implements the `statusline-collector` skill's `init`/`uninstall` rules. Two files in the data
 * directory:
 * - `install-record.json`: the settings path, whether it existed, the backup path, and the user's
 *   original `statusLine` entry (or null).
 * - `wrapped-command`: the original command as plain text, the only thing the shell hook reads.
 *   It exists only when there was an original command.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ensurePrivateDir, tightenMode } from "./private-files.js";
import { writeFileAtomic } from "../settings/settings-file.js";
import { type StatusLineEntry, isCommandEntry } from "../settings/statusline.js";

/** File name of the install record inside the data directory. */
export const RECORD_FILE = "install-record.json";

/** File name of the wrapped command the hook runs (see hooks/statusline.sh). */
export const WRAPPED_COMMAND_FILE = "wrapped-command";

/** Everything `uninstall` needs to reverse `init`. */
export interface InstallRecord {
  /** Record format version. */
  readonly version: 1;
  /** Settings file that was changed. */
  readonly settingsPath: string;
  /** Whether the settings file existed before `init` created or changed it. */
  readonly settingsExisted: boolean;
  /** Backup made before the first change; null when there was no file to back up. */
  readonly backupPath: string | null;
  /** The user's `statusLine` entry before install; null when there was none. */
  readonly original: StatusLineEntry | null;
  /** ISO-8601 UTC time of the install. */
  readonly installedAt: string;
}

/** An install record that exists but can't be trusted. Nothing is changed when this is raised. */
export class InstallRecordError extends Error {
  /**
   * Creates an install record error.
   * @param path - Path of the unreadable record.
   * @param reason - What is wrong with it.
   */
  constructor(path: string, reason: string) {
    super(`install record ${path} is unusable: ${reason}`);
    this.name = "InstallRecordError";
  }
}

/**
 * Writes the install record and the hook's wrapped-command file.
 *
 * Called before settings are changed, so the hook finds the user's original command on its very
 * first run and the status bar never shows the default in between.
 * @param dataDir - The tool's data directory; created if missing.
 * @param record - The record to write.
 */
export function writeInstallRecord(dataDir: string, record: InstallRecord): void {
  ensurePrivateDir(dataDir);
  writeFileAtomic(join(dataDir, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
  const wrappedPath = join(dataDir, WRAPPED_COMMAND_FILE);
  if (record.original === null) {
    // A stale file from an earlier install would make the hook run a command that's gone.
    rmSync(wrappedPath, { force: true });
  } else {
    writeFileAtomic(wrappedPath, record.original.command);
  }
  // writeFileAtomic keeps an existing file's mode; an install from before D-043 may have left 0644.
  tightenMode(join(dataDir, RECORD_FILE));
  tightenMode(wrappedPath);
}

/**
 * Reads the install record, validating its shape.
 * @param dataDir - The tool's data directory.
 * @returns The record, or null if none exists.
 * @throws {InstallRecordError} If the file exists but isn't a valid record.
 */
export function readInstallRecord(dataDir: string): InstallRecord | null {
  const path = join(dataDir, RECORD_FILE);
  if (!existsSync(path)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new InstallRecordError(path, "not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InstallRecordError(path, "not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  // Validate every field uninstall relies on; a guess here could restore the wrong settings.
  const valid =
    record["version"] === 1 &&
    typeof record["settingsPath"] === "string" &&
    typeof record["settingsExisted"] === "boolean" &&
    (record["backupPath"] === null || typeof record["backupPath"] === "string") &&
    (record["original"] === null || isCommandEntry(record["original"])) &&
    typeof record["installedAt"] === "string";
  if (!valid) {
    throw new InstallRecordError(path, "missing or mistyped fields");
  }
  return record as unknown as InstallRecord;
}

/**
 * Removes the install record and wrapped-command file, keeping all collected data.
 * @param dataDir - The tool's data directory.
 */
export function removeInstallRecord(dataDir: string): void {
  rmSync(join(dataDir, RECORD_FILE), { force: true });
  rmSync(join(dataDir, WRAPPED_COMMAND_FILE), { force: true });
}
