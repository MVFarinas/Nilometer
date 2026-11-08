/**
 * @file Tests for `nilometer machines` and its output (cli/machines.ts, cli/program.ts; G7.5).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { describeFolderSet, describeLeave, describeMachinesStep } from "../../../cli/machines.js";
import { type CliDeps, runCli } from "../../../cli/program.js";
import { ROOT } from "../core/metrics/helpers.js";

/**
 * CLI dependencies over a fresh home logged in to one account, capturing output.
 * @returns The dependencies and the output lines.
 */
function testDeps(): { deps: CliDeps; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "aua-cli-machines-"));
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: "11111111-2222-4333-8444-555555555555" } }),
  );
  return {
    deps: {
      home,
      env: {},
      packageRoot: ROOT,
      now: () => new Date("2026-09-13T12:00:00Z"),
      print: (line) => out.push(line),
      printError: (line) => err.push(line),
      timeZone: "UTC",
      openPage: () => {
        throw new Error("a test reached the real page opener");
      },
    },
    out,
    err,
  };
}

describe("nilometer machines", () => {
  it("sets the folder, lists the machines, and leaves, across two machines", () => {
    const folder = mkdtempSync(join(tmpdir(), "aua-cli-synced-"));
    const desk = testDeps();
    const laptop = testDeps();
    expect(runCli(["machines", "list"], desk.deps)).toBe(0);
    expect(desk.out).toEqual([
      "No folder set. Combine machines with `nilometer machines folder <synced folder> --name <name>` on each one.",
    ]);
    desk.out.length = 0;
    expect(runCli(["machines", "folder", folder, "--name", "Desk"], desk.deps)).toBe(0);
    expect(desk.out).toEqual([
      `This machine is "Desk", writing to ${folder} and reading every other machine there.`,
      "Each ingest (and so `report`, `view` and its Refresh) now does both. Run the same command on each machine, with the same folder as your sync provider sees it.",
      "Machines: 0 lines written in 0 files; read no other machines yet.",
    ]);
    expect(runCli(["machines", "folder", folder, "--name", "Laptop"], laptop.deps)).toBe(0);
    expect(laptop.out.at(-1)).toBe(
      "Machines: 0 lines written in 0 files; read Desk (0 new lines).",
    );
    desk.out.length = 0;
    expect(runCli(["machines", "list"], desk.deps)).toBe(0);
    // Not read until the desk's next ingest.
    expect(desk.out[1]).toBe("No other machines found in the folder yet.");
    expect(runCli(["ingest"], desk.deps)).toBe(0);
    expect(desk.out).toContain("Machines: 0 lines written in 0 files; read Laptop (0 new lines).");
    desk.out.length = 0;
    expect(runCli(["machines", "list"], desk.deps)).toBe(0);
    expect(desk.out[0]).toMatch(
      new RegExp(
        `^This machine: "Desk" \\([0-9a-f]{8}\\), folder ${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.$`,
      ),
    );
    expect(desk.out[1]).toMatch(
      /^Merged: "Laptop" \([0-9a-f]{8}\), 0 lines stored, last export 2026-09-13T12:00:00.000Z\.$/,
    );
    desk.out.length = 0;
    expect(runCli(["machines", "leave", "--remove-export"], desk.deps)).toBe(0);
    expect(desk.out[0]).toBe(`This machine no longer writes to or reads from ${folder}.`);
    desk.out.length = 0;
    expect(runCli(["machines", "list"], desk.deps)).toBe(0);
    expect(desk.out[0]).toMatch(/not writing to a folder\.$/);
    // A folder that doesn't exist is refused, with nothing changed.
    expect(runCli(["machines", "folder", join(folder, "missing")], desk.deps)).toBe(1);
    expect(desk.err.at(-1)).toMatch(/isn't a folder; create it, or point to your synced folder/);
  });
});

describe("what the machine step says", () => {
  it("says nothing with no folder, and says why when nothing was written or read", () => {
    expect(describeMachinesStep({ kind: "off" })).toEqual([]);
    expect(describeMachinesStep({ kind: "folder_missing", folder: "/f" })).toEqual([
      "Machines: the folder /f isn't there (an unmounted drive, or moved), so nothing was written or read. Set it again with `nilometer machines folder <path>`.",
    ]);
    expect(
      describeMachinesStep({
        kind: "done",
        machine: { machineId: "m", label: "Desk", folder: "/f" },
        exported: { files: ["logs-2026-09.jsonl.gz"], lines: 3, notSent: 0 },
        imported: {
          machines: [
            {
              machineId: "x",
              label: null,
              status: "refused",
              reason: "its machine.json isn't there yet",
              linesStored: 0,
            },
          ],
          ignored: 2,
        },
      }),
    ).toEqual([
      "Machines: 3 lines written in 1 file; read x (refused: its machine.json isn't there yet); 2 other entries in the folder ignored.",
    ]);
    expect(
      describeMachinesStep({
        kind: "done",
        machine: { machineId: "m", label: "Desk", folder: "/f" },
        exported: { reason: "no account" },
        imported: { machines: [], ignored: 0 },
      }),
    ).toEqual(["Machines: nothing written: no account; read no other machines yet."]);
  });

  it("describes setup and leaving", () => {
    expect(describeFolderSet({ machineId: "m", label: "Desk", folder: "/f" })[0]).toBe(
      'This machine is "Desk", writing to /f and reading every other machine there.',
    );
    expect(describeLeave({ folder: null, removed: null })).toEqual([
      "No folder was set; nothing changed.",
    ]);
    expect(describeLeave({ folder: "/f", removed: null })[1]).toBe(
      "Its records are still in the folder for the other machines; add --remove-export to delete them.",
    );
    expect(describeLeave({ folder: "/f", removed: "/f/nilometer/m" })[1]).toBe(
      "Its records were deleted from the folder (/f/nilometer/m).",
    );
  });
});
