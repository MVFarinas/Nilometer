/**
 * @file What `nilometer machines` and each ingest say about combining machines (D-101 to D-103, G7.5).
 *
 * Counts, labels and the folder only: never another machine's paths or content, which the export
 * doesn't carry anyway.
 */
import type { Db } from "../core/db/database.js";
import type { LeaveOutcome, MachinesStep, ThisMachine } from "../core/machines/machines.js";
import { readThisMachine } from "../core/machines/machines.js";

/**
 * Describes one ingest's machine step.
 * @param step - What it did.
 * @returns Lines for stdout; none when no folder is set.
 */
export function describeMachinesStep(step: MachinesStep): string[] {
  if (step.kind === "off") {
    return [];
  }
  if (step.kind === "folder_missing") {
    return [
      `Machines: the folder ${step.folder} isn't there (an unmounted drive, or moved), so nothing was written or read. Set it again with \`nilometer machines folder <path>\`.`,
    ];
  }
  const { exported, imported } = step;
  const wrote =
    "reason" in exported
      ? `nothing written: ${exported.reason}`
      : `${exported.lines} lines written in ${exported.files.length} ${exported.files.length === 1 ? "file" : "files"}`;
  const others =
    imported.machines.length === 0
      ? "no other machines yet"
      : imported.machines
          .map((m) =>
            m.status === "merged"
              ? `${m.label ?? m.machineId} (${m.linesStored} new lines)`
              : `${m.label ?? m.machineId} (refused: ${m.reason ?? ""})`,
          )
          .join(", ");
  return [
    `Machines: ${wrote}; read ${others}${imported.ignored === 0 ? "" : `; ${imported.ignored} other entries in the folder ignored`}.`,
  ];
}

/**
 * Describes a `machines folder` setup.
 * @param machine - The setup made.
 * @returns Lines for stdout.
 */
export function describeFolderSet(machine: ThisMachine): string[] {
  return [
    `This machine is "${machine.label}", writing to ${machine.folder ?? ""} and reading every other machine there.`,
    "Each ingest (and so `report`, `view` and its Refresh) now does both. Run the same command on each machine, with the same folder as your sync provider sees it.",
  ];
}

/**
 * Describes leaving the folder.
 * @param outcome - What leaving did.
 * @returns Lines for stdout.
 */
export function describeLeave(outcome: LeaveOutcome): string[] {
  if (outcome.folder === null) {
    return ["No folder was set; nothing changed."];
  }
  return [
    `This machine no longer writes to or reads from ${outcome.folder}.`,
    outcome.removed === null
      ? "Its records are still in the folder for the other machines; add --remove-export to delete them."
      : `Its records were deleted from the folder (${outcome.removed}).`,
    "Records already read from other machines stay in this machine's database, as every stored line does.",
  ];
}

/** A row of the machine list. */
interface MachineRow {
  /** The machine's ID. */
  readonly machine_id: string;
  /** Its label. */
  readonly label: string | null;
  /** `merged` or `refused`. */
  readonly status: string;
  /** Why it was refused. */
  readonly reason: string | null;
  /** When it last wrote its export. */
  readonly exported_at: string | null;
  /** Lines stored from it. */
  readonly lines: number;
}

/**
 * Lists this machine and every other machine found in the folder.
 * @param db - Open, migrated database.
 * @returns Lines for stdout.
 */
export function describeMachineList(db: Db): string[] {
  const own = readThisMachine(db);
  if (own === null) {
    return [
      "No folder set. Combine machines with `nilometer machines folder <synced folder> --name <name>` on each one.",
    ];
  }
  const rows = db
    .prepare(
      `SELECT m.machine_id, m.label, m.status, m.reason, m.exported_at,
         (SELECT COUNT(*) FROM machine_files mf JOIN raw_lines l ON l.source_file_id = mf.source_file_id
          WHERE mf.machine_id = m.machine_id) AS lines
       FROM machines m ORDER BY m.status, m.label`,
    )
    .all() as unknown as MachineRow[];
  return [
    `This machine: "${own.label}" (${own.machineId.slice(0, 8)}), ${own.folder === null ? "not writing to a folder" : `folder ${own.folder}`}.`,
    ...(rows.length === 0
      ? ["No other machines found in the folder yet."]
      : rows.map(
          (r) =>
            `${r.status === "merged" ? "Merged" : "Refused"}: "${r.label ?? "unnamed"}" (${r.machine_id.slice(0, 8)}), ${r.lines} lines stored, last export ${r.exported_at ?? "unknown"}${r.reason === null ? "" : `; ${r.reason}`}.`,
        )),
  ];
}
