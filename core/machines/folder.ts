/**
 * @file The layout of the synced folder and of a machine's description in it (D-101, D-103).
 *
 * ```
 * <folder>/nilometer/<machine id>/machine.json          who wrote it, for which account, when
 * <folder>/nilometer/<machine id>/logs-YYYY-MM.jsonl.gz  scrubbed session-log lines, by the month they were read
 * <folder>/nilometer/<machine id>/readings-YYYY-MM.jsonl.gz  scrubbed status line readings, the same way
 * ```
 *
 * Only the machine named by a folder writes into it, so a sync provider never sees two machines
 * change one file. Everything read from another machine's folder is untrusted input: its names,
 * sizes and contents are checked here before anything is stored.
 */
import { isObject } from "../ingest/classify.js";
import type { SourceKind } from "../ingest/store.js";

/** The folder Nilometer keeps inside the synced folder, so it never mixes with the user's files. */
export const FOLDER_DIR = "nilometer";

/** A machine's description file. */
export const MACHINE_FILE = "machine.json";

/** The export format this build writes and reads. A newer one is refused, not guessed at. */
export const EXPORT_FORMAT = 1;

/** A machine ID: a lowercase random UUID, also its folder's name. */
export const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** An export file's name: its kind and its month. Anything else in a machine's folder is ignored. */
export const EXPORT_FILE = /^(logs|readings)-(\d{4}-(?:0[1-9]|1[0-2]))\.jsonl\.gz$/;

/** The largest export file read, compressed. A month of heavy use was about 3 MB (G7.1). */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** The most a file may expand to: the gzip limit that keeps a hostile file from filling memory. */
export const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;

/** The longest line stored. A scrubbed line is under 2 KB; the reader's own limit is far above this. */
export const MAX_LINE_BYTES = 64 * 1024;

/** The largest machine.json read. */
export const MAX_MACHINE_FILE_BYTES = 64 * 1024;

/**
 * Control characters, which would let a label rewrite the terminal when it's printed on another
 * machine.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The longest machine label. */
export const MAX_LABEL_LENGTH = 60;

/** A machine's description, as written to {@link MACHINE_FILE}. */
export interface MachineInfo {
  /** {@link EXPORT_FORMAT} when written. */
  readonly format: number;
  /** The machine's ID, matching its folder's name. */
  readonly machineId: string;
  /** The name the user gave it. */
  readonly label: string;
  /** Its account, hashed (core/machines/account.ts). */
  readonly accountHash: string;
  /** When it last wrote its export, ISO-8601 UTC by its own clock. */
  readonly exportedAt: string;
  /** The Nilometer version that wrote it. */
  readonly nilometerVersion: string;
}

/**
 * The file name for a kind and month.
 * @param kind - `log` or `spool`.
 * @param month - `YYYY-MM`.
 * @returns For example `logs-2026-11.jsonl.gz`.
 */
export function exportFileName(kind: SourceKind, month: string): string {
  return `${kind === "log" ? "logs" : "readings"}-${month}.jsonl.gz`;
}

/**
 * Reads an export file's name.
 * @param name - A file name in a machine's folder.
 * @returns Its kind and month, or null when it isn't an export file (a sync provider's conflict copy,
 *   a placeholder, a temporary file).
 */
export function parseExportFileName(name: string): { kind: SourceKind; month: string } | null {
  const match = EXPORT_FILE.exec(name);
  if (match === null) {
    return null;
  }
  return { kind: match[1] === "logs" ? "log" : "spool", month: match[2] ?? "" };
}

/**
 * Checks a label the user gave.
 * @param label - The label.
 * @returns The label trimmed, or null when it's empty, too long, or holds a control character.
 */
export function cleanLabel(label: string): string | null {
  const trimmed = label.trim();
  if (trimmed === "" || trimmed.length > MAX_LABEL_LENGTH || CONTROL.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Validates another machine's description.
 * @param text - The file's contents.
 * @param folderName - The folder it was in, which must be its machine ID.
 * @returns The description, or why it can't be used.
 */
export function parseMachineInfo(
  text: string,
  folderName: string,
): { kind: "ok"; info: MachineInfo } | { kind: "bad"; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "bad", reason: "its machine.json isn't valid JSON" };
  }
  if (!isObject(value)) {
    return { kind: "bad", reason: "its machine.json isn't an object" };
  }
  const { format, machineId, label, accountHash, exportedAt, nilometerVersion } = value;
  if (typeof format !== "number" || !Number.isInteger(format)) {
    return { kind: "bad", reason: "its machine.json has no format number" };
  }
  if (format > EXPORT_FORMAT) {
    return {
      kind: "bad",
      reason: `it was written by a newer Nilometer (format ${format}); update this one`,
    };
  }
  // The folder's name is what the importer trusts; a file claiming another machine's ID is refused.
  if (machineId !== folderName) {
    return { kind: "bad", reason: "its machine.json names a different machine than its folder" };
  }
  const cleaned = typeof label === "string" ? cleanLabel(label) : null;
  if (cleaned === null || cleaned !== label) {
    return { kind: "bad", reason: "its machine.json has no usable label" };
  }
  if (typeof accountHash !== "string" || !/^[0-9a-f]{64}$/.test(accountHash)) {
    return { kind: "bad", reason: "its machine.json has no account" };
  }
  if (typeof exportedAt !== "string" || Number.isNaN(Date.parse(exportedAt))) {
    return { kind: "bad", reason: "its machine.json has no export time" };
  }
  if (typeof nilometerVersion !== "string" || nilometerVersion.length > 40) {
    return { kind: "bad", reason: "its machine.json has no Nilometer version" };
  }
  return {
    kind: "ok",
    info: { format, machineId, label: cleaned, accountHash, exportedAt, nilometerVersion },
  };
}
