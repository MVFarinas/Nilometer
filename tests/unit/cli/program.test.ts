/**
 * @file Unit tests for cli/program.ts.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HAS_POSIX_MODES } from "../../setup/platform.js";

import {
  type CliDeps,
  describeIngest,
  describeInit,
  describePlanPriceList,
  describePlanPriceSet,
  describeDeletion,
  describeVerify,
  describeUninstall,
  TERMINAL_ONLY_NOTE,
  report,
  runCli,
  toIngestOptions,
  toInstallOptions,
  toPlanDatabaseOptions,
} from "../../../cli/program.js";
import type { IngestCommandOutcome } from "../../../core/ingest/command.js";
import { DiscoveryError } from "../../../core/ingest/discover.js";
import type { InitOutcome, UninstallOutcome } from "../../../core/install/install.js";
import { InstallRecordError } from "../../../core/install/record.js";
import { PlanPriceError } from "../../../core/plans/plan-prices.js";
import { UnknownMetricError } from "../../../viewer/explain.js";
import { NoDatabaseError } from "../../../viewer/report.js";
import { PriceTableError } from "../../../core/pricing/prices.js";
import { SettingsError } from "../../../core/settings/settings-file.js";

/** This repository's root, which contains hooks/statusline.sh. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Words the viewer and CLI must never use (CLAUDE.md, D-012). Checked on every message here. */
const BANNED = [
  /time lost/i,
  /wasted/i,
  /would have spent/i,
  /you should/i,
  /savings/i,
  /cheaper by/i,
  /verdict/i,
  /recommend/i,
  /score/i,
];

/**
 * Creates CLI dependencies over a fresh temporary home, capturing output.
 * @param env - Environment variables to expose.
 * @returns The dependencies and arrays receiving stdout and stderr lines.
 */
function testDeps(env: Record<string, string> = {}): {
  deps: CliDeps;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "aua-cli-test-"));
  return {
    deps: {
      home,
      env,
      packageRoot: PACKAGE_ROOT,
      now: () => new Date("2026-09-13T12:00:00Z"),
      print: (line) => out.push(line),
      printError: (line) => err.push(line),
      timeZone: "America/Chicago",
    },
    out,
    err,
  };
}

/**
 * Asserts that none of the lines contains banned wording.
 * @param lines - Output lines to check.
 */
function expectNoBannedWording(lines: readonly string[]): void {
  for (const line of lines) {
    for (const pattern of BANNED) {
      expect(line).not.toMatch(pattern);
    }
  }
}

/** Common fields for outcome fixtures. */
const PATHS = { settingsPath: "/s/settings.json", dataDir: "/d", hookRefreshed: false };

describe("toInstallOptions", () => {
  it("maps flags and the three environment variables, calling the clock once", () => {
    const { deps } = testDeps({
      CLAUDE_CONFIG_DIR: "/cfg",
      NILOMETER_HOME: "/aua",
      XDG_DATA_HOME: "/xdg",
      UNRELATED: "x",
    });
    const options = toInstallOptions({ settings: "/s.json", dataDir: "/data" }, deps);
    expect(options).toEqual({
      home: deps.home,
      env: { CLAUDE_CONFIG_DIR: "/cfg", NILOMETER_HOME: "/aua", XDG_DATA_HOME: "/xdg" },
      settingsOverride: "/s.json",
      dataDirOverride: "/data",
      packageRoot: PACKAGE_ROOT,
      now: new Date("2026-09-13T12:00:00Z"),
    });
  });
});

describe("toIngestOptions", () => {
  it("maps the data dir, full flag, and the four environment variables", () => {
    const { deps } = testDeps({
      CLAUDE_CONFIG_DIR: "/cfg",
      XDG_CONFIG_HOME: "/xdgc",
      NILOMETER_HOME: "/aua",
      XDG_DATA_HOME: "/xdgd",
      OTHER: "x",
    });
    const options = toIngestOptions({ dataDir: "/data", full: true }, deps);
    expect(options).toMatchObject({
      home: deps.home,
      env: {
        CLAUDE_CONFIG_DIR: "/cfg",
        XDG_CONFIG_HOME: "/xdgc",
        NILOMETER_HOME: "/aua",
        XDG_DATA_HOME: "/xdgd",
      },
      dataDirOverride: "/data",
      full: true,
      packageRoot: PACKAGE_ROOT,
    });
    expect(options.now).toBe(deps.now);
    expect(toIngestOptions({}, deps).full).toBe(false);
  });
});

describe("describeIngest", () => {
  /** An outcome with every count distinct, so each appears in a known place. */
  const outcome: IngestCommandOutcome = {
    databasePath: "/d/usage.db",
    roots: ["/h/.claude", "/alt"],
    run: {
      runId: 1,
      files: 3,
      logFiles: 2,
      spoolRead: true,
      linesRead: 40,
      linesStored: 30,
      linesAlreadyStored: 10,
      filesRewritten: 1,
      unreadable: 0,
    },
    derived: { lines: 30, rebuilt: false },
    repositoriesResolved: 2,
    totals: {
      requests: 12,
      unkeyedRequests: 2,
      limitHits: 4,
      otherEvents: 5,
      malformedLines: 6,
      statusReadings: 7,
      malformedReadings: 8,
      invalidWindows: 9,
      hookErrors: 11,
      firstRequestUtc: "2026-09-01T00:00:00.000Z",
      lastRequestUtc: "2026-09-02T00:00:00.000Z",
    },
    permissionsTightened: [],
  };

  it("states every count, the span, and the database path", () => {
    expect(describeIngest(outcome)).toEqual([
      "Log roots read: /h/.claude, /alt",
      "This run: 2 session logs and the status line spool, 40 complete lines read, 30 new, 1 rewritten files reread.",
      "Stored: 12 requests (2 without IDs), 4 limit hits, 5 other error or retry events; requests stored from 2026-09-01T00:00:00.000Z to 2026-09-02T00:00:00.000Z (UTC).",
      "Status line: 7 readings, 8 undecodable spool lines, 9 flagged window values, 11 hook append failures.",
      "Reported for review: 6 malformed log lines.",
      "Database: /d/usage.db",
    ]);
  });

  it("says so when there are no roots, no spool, and no requests", () => {
    const empty = describeIngest({
      ...outcome,
      roots: [],
      run: { ...outcome.run, spoolRead: false },
      totals: { ...outcome.totals, firstRequestUtc: null, lastRequestUtc: null },
    });
    expect(empty[0]).toBe("Log roots read: none found");
    expect(empty[1]).not.toContain("spool");
    expect(empty[2]).toContain("no requests stored yet");
    const tightened = describeIngest({ ...outcome, permissionsTightened: ["/d/usage.db", "/d"] });
    expect(tightened).toContain(
      "Made Nilometer's data owner-only: 2 paths were readable by other accounts on this computer.",
    );
    expectNoBannedWording(empty);
  });
});

describe("describeIngest wording", () => {
  /**
   * Builds an ingest outcome with the counts a test cares about.
   * @param run - Fields to override on the run.
   * @returns An outcome ready for describeIngest.
   */
  function outcomeWith(run: Partial<IngestCommandOutcome["run"]>): IngestCommandOutcome {
    return {
      databasePath: "/d/usage.db",
      roots: ["/h/.claude"],
      run: {
        runId: 1,
        files: 1,
        logFiles: 1,
        spoolRead: false,
        linesRead: 4,
        linesStored: 4,
        linesAlreadyStored: 0,
        filesRewritten: 0,
        unreadable: 0,
        ...run,
      },
      derived: { lines: 4, rebuilt: false },
      repositoriesResolved: 0,
      totals: {
        requests: 4,
        unkeyedRequests: 0,
        limitHits: 0,
        otherEvents: 0,
        malformedLines: 0,
        statusReadings: 0,
        malformedReadings: 0,
        invalidWindows: 0,
        hookErrors: 0,
        firstRequestUtc: null,
        lastRequestUtc: null,
      },
      permissionsTightened: [],
    };
  }

  it("counts session logs apart from the spool, so one log isn't reported as two files", () => {
    // The count used to include the spool, and "2 files" read as a miscount to a tester who had
    // a single session log (R2.5).
    const line = describeIngest(outcomeWith({ files: 2, logFiles: 1, spoolRead: true }))[1];
    expect(line).toContain("1 session log and the status line spool");
    expect(line).not.toContain("2 files");
  });

  it("says nothing about a spool that wasn't there, and pluralises logs", () => {
    expect(describeIngest(outcomeWith({ files: 3, logFiles: 3 }))[1]).toContain("3 session logs,");
    expect(describeIngest(outcomeWith({ files: 3, logFiles: 3 }))[1]).not.toContain("spool");
  });
});

describe("describeInit", () => {
  const cases: [InitOutcome, number, RegExp][] = [
    [
      { ...PATHS, action: "installed", backupPath: null, wrappedCommand: null },
      0,
      /no settings file before/,
    ],
    [
      { ...PATHS, action: "installed", backupPath: "/b", wrappedCommand: "x.sh" },
      0,
      /still runs, unchanged: x\.sh/,
    ],
    [
      { ...PATHS, action: "updated", backupPath: "/b", wrappedCommand: "x.sh" },
      0,
      /location had changed/,
    ],
    [
      { ...PATHS, action: "updated", backupPath: null, wrappedCommand: null },
      0,
      /Backup of the previous settings: none/,
    ],
    [
      // A pulled version whose hook changed: the command is right, the copy was refreshed (D-056).
      {
        ...PATHS,
        action: "already-installed",
        backupPath: null,
        wrappedCommand: null,
        hookRefreshed: true,
      },
      0,
      /hook script in \/d was updated/,
    ],
    [
      { ...PATHS, action: "already-installed", backupPath: null, wrappedCommand: null },
      0,
      /Nothing was changed/,
    ],
    [
      { ...PATHS, action: "refused-unsupported", backupPath: null, wrappedCommand: null },
      1,
      /not a command entry/,
    ],
    [
      { ...PATHS, action: "refused-other-install", backupPath: null, wrappedCommand: null },
      1,
      /different data directory/,
    ],
  ];

  it.each(cases)("describes %j with the right exit code", (outcome, exitCode, pattern) => {
    const described = describeInit(outcome);
    expect(described.exitCode).toBe(exitCode);
    expect(described.lines.join("\n")).toMatch(pattern);
    expectNoBannedWording(described.lines);
  });

  it("names the backup path and data directory after an install with a backup", () => {
    const { lines } = describeInit({
      ...PATHS,
      action: "installed",
      backupPath: "/b",
      wrappedCommand: null,
    });
    expect(lines).toContain("Backup of the previous settings: /b");
    expect(lines).toContain("Status line readings are recorded in /d.");
    // D-029: said at install, so an empty usage window after VS Code-only work isn't a surprise.
    expect(lines).toContain(TERMINAL_ONLY_NOTE);
    expect(TERMINAL_ONLY_NOTE).toMatch(/terminal.*VS Code extension doesn't run the status line/);
  });
});

describe("describeVerify", () => {
  const clean = {
    comparedDays: 12,
    comparedKeys: 20,
    daysOnlyOurs: 0,
    daysOnlyTheirs: 0,
    differences: [],
    unpricedModels: [],
    fromDeletedLogs: 0,
    skippedToday: "2026-09-18",
  };

  it("says everything matched, and exits 0", () => {
    const { lines, exitCode } = describeVerify(clean);
    expect(lines[0]).toContain("Compared 12 days against ccusage");
    expect(lines.join("\n")).toContain("Every one matched");
    expect(exitCode).toBe(0);
  });

  it("names the day, model, field and both values for a difference, and exits 1", () => {
    const { lines, exitCode } = describeVerify({
      ...clean,
      differences: [{ key: "2026-09-13|claude-opus-5", field: "output", ours: 10, theirs: 12 }],
    });
    expect(lines.join("\n")).toContain(
      "2026-09-13  claude-opus-5  output: this tool 10, ccusage 12",
    );
    expect(exitCode).toBe(1);
  });

  it("explains the days it could not compare, without failing on ours", () => {
    // Days only this tool has are the design working (D-002); days only ccusage has are not.
    const kept = describeVerify({ ...clean, daysOnlyOurs: 3, fromDeletedLogs: 40 });
    expect(kept.lines.join("\n")).toMatch(/3 days only this tool has/);
    expect(kept.lines.join("\n")).toMatch(/40 requests were left out/);
    expect(kept.exitCode).toBe(0);
    const missed = describeVerify({ ...clean, daysOnlyTheirs: 2 });
    expect(missed.lines.join("\n")).toMatch(/2 days only ccusage reported/);
    expect(missed.exitCode).toBe(1);
  });

  it("fails when nothing could be compared, rather than reporting success", () => {
    expect(describeVerify({ ...clean, comparedDays: 0, comparedKeys: 0 }).exitCode).toBe(1);
  });

  it("prints nothing a prompt, path, repository or session could be in (D-064)", () => {
    // This output exists to be sent to someone else. Days, model names, field names and token
    // counts are the whole vocabulary; anything else would make it unsendable.
    const { lines } = describeVerify({
      ...clean,
      daysOnlyOurs: 1,
      daysOnlyTheirs: 1,
      fromDeletedLogs: 5,
      unpricedModels: ["some-model-1"],
      differences: [{ key: "2026-09-13|claude-opus-5", field: "cache_read", ours: 1, theirs: 2 }],
    });
    const text = lines.join("\n");
    for (const shape of [/\//, /\\/, /~/, /\.jsonl/, /[0-9a-f]{8}-[0-9a-f]{4}/]) {
      expect(text).not.toMatch(shape);
    }
  });
});

describe("describeUninstall reporting a deletion in every branch", () => {
  const deleted = {
    deletion: { removed: ["usage.db"], failed: [], directoryRemoved: true, kept: [] },
    summary: {
      requests: 4,
      readings: 2,
      firstRequestUtc: "2026-09-01T00:00:00Z",
      lastRequestUtc: "2026-09-02T00:00:00Z",
    },
  };

  it("says the data went even when the settings file was untouched (D-062)", () => {
    // The mirror of D-061: this used to print "Nothing was changed" while the data directory had
    // gone, and lost the counts that were the only remaining record of what was in it.
    for (const action of ["not-installed", "replaced-by-user"] as const) {
      const outcome = {
        ...PATHS,
        action,
        backupPath: null,
        exactBytes: false,
        recordMissing: false,
        restoredCommand: null,
        notRemoved: [],
      };
      const text = describeUninstall(outcome, deleted).lines.join("\n");
      expect(text).toContain("Deleted the recorded data in /d");
      expect(text).toContain("It held 4 requests and 2 status line readings");
      expect(text).not.toContain("Nothing was changed");
    }
  });

  it("still says nothing was changed when no data was deleted", () => {
    const outcome = {
      ...PATHS,
      action: "not-installed" as const,
      backupPath: null,
      exactBytes: false,
      recordMissing: false,
      restoredCommand: null,
      notRemoved: [],
    };
    expect(describeUninstall(outcome).lines.join("\n")).toContain("Nothing was changed");
  });
});

describe("describeDeletion", () => {
  const deletion = {
    removed: ["usage.db", "reports"],
    failed: [],
    directoryRemoved: true,
    kept: [],
  };
  const summary = {
    requests: 6072,
    readings: 1092,
    firstRequestUtc: "2026-07-19T09:04:34.255Z",
    lastRequestUtc: "2026-09-18T07:05:30.238Z",
  };

  it("names what went, how much it held, and that it can't be undone (R2.5)", () => {
    const lines = describeDeletion("/d", { deletion, summary });
    expect(lines[0]).toBe("Deleted the recorded data in /d: usage.db, reports.");
    expect(lines[1]).toContain("6,072 requests and 1,092 status line readings");
    expect(lines[1]).toContain("2026-07-19T09:04:34.255Z to 2026-09-18T07:05:30.238Z");
    expect(lines.join("\n")).toContain("This can't be undone.");
    expect(lines.join("\n")).toContain("The directory is gone");
  });

  it("names what it left alone, so a shared folder's contents are accounted for", () => {
    const lines = describeDeletion("/d", {
      deletion: { removed: ["usage.db"], failed: [], directoryRemoved: false, kept: ["notes.txt"] },
      summary,
    });
    expect(lines.join("\n")).toContain(
      "Left alone, because Nilometer didn't write them: notes.txt.",
    );
  });

  it("says so when there was nothing to delete, and copes with no database", () => {
    expect(
      describeDeletion("/d", {
        deletion: { removed: [], failed: [], directoryRemoved: false, kept: [] },
        summary: null,
      }),
    ).toEqual(["No recorded data was found in /d."]);
    expect(describeDeletion("/d", { deletion, summary: null }).join("\n")).not.toContain("It held");
  });

  it("reports an empty database as no requests rather than a broken range", () => {
    const lines = describeDeletion("/d", {
      deletion,
      summary: { requests: 0, readings: 0, firstRequestUtc: null, lastRequestUtc: null },
    });
    expect(lines[1]).toContain("no requests were stored");
  });
});

describe("describeUninstall", () => {
  const base = { ...PATHS, exactBytes: true, restoredCommand: null, notRemoved: [] };
  const cases: [UninstallOutcome, RegExp][] = [
    [
      { ...base, action: "restored", backupPath: "/b", recordMissing: false },
      /restored the earlier status line/,
    ],
    [
      // The command comes from a file on disk, so uninstall names it (D-050).
      {
        ...base,
        action: "restored",
        backupPath: "/b",
        recordMissing: false,
        restoredCommand: "~/bin/my-status.sh",
      },
      /Status line command restored: ~\/bin\/my-status\.sh/,
    ],
    [
      { ...base, action: "restored", backupPath: null, recordMissing: true },
      /No install record was found/,
    ],
    [
      { ...base, action: "removed-settings-file", backupPath: "/b", recordMissing: false },
      /init had created it/,
    ],
    [
      { ...base, action: "removed-settings-file", backupPath: null, recordMissing: false },
      /Backup of the removed file: none/,
    ],
    [{ ...base, action: "not-installed", backupPath: null, recordMissing: true }, /not installed/],
    [
      { ...base, action: "replaced-by-user", backupPath: null, recordMissing: false },
      /changed after install/,
    ],
  ];

  it.each(cases)("describes %j with exit code 0", (outcome, pattern) => {
    const described = describeUninstall(outcome);
    expect(described.exitCode).toBe(0);
    expect(described.lines.join("\n")).toMatch(pattern);
    expectNoBannedWording(described.lines);
  });

  it("says collected data was kept after a restore", () => {
    const { lines } = describeUninstall({
      ...base,
      action: "restored",
      backupPath: "/b",
      recordMissing: false,
    });
    expect(lines).toContain(
      "Recorded data in /d was kept. Run uninstall --delete-data to remove it.",
    );
  });
});

describe("toPlanDatabaseOptions", () => {
  it("maps the data dir and the two data-directory environment variables", () => {
    const { deps } = testDeps({
      NILOMETER_HOME: "/a",
      XDG_DATA_HOME: "/x",
      CLAUDE_CONFIG_DIR: "/c",
    });
    expect(toPlanDatabaseOptions({ dataDir: "/d" }, deps)).toEqual({
      home: deps.home,
      env: { NILOMETER_HOME: "/a", XDG_DATA_HOME: "/x" },
      dataDirOverride: "/d",
      packageRoot: PACKAGE_ROOT,
    });
  });
});

describe("describePlanPriceSet and describePlanPriceList", () => {
  it("states the stored price, any replaced entry, and where it's stored", () => {
    const entry = { month: "2026-09", planName: "Plan A", usdPerMonth: 17.5 };
    expect(describePlanPriceSet(entry, null, "/d/usage.db")).toEqual([
      "Plan price from 2026-09: Plan A, $17.50 per month (USD list price).",
      "Stored in /d/usage.db",
    ]);
    const previous = {
      month: "2026-09",
      planName: "Plan B",
      usdPerMonth: 200,
      enteredAt: "2026-09-01T00:00:00.000Z",
    };
    const lines = describePlanPriceSet(entry, previous, "/d/usage.db");
    expect(lines[1]).toBe("Replaced the entry for 2026-09: Plan B, $200.00 per month.");
    expectNoBannedWording(lines);
  });

  it("lists entries or says there are none", () => {
    expect(describePlanPriceList([])).toEqual(["No plan prices entered."]);
    expect(
      describePlanPriceList([
        { month: "2026-08", planName: "Plan A", usdPerMonth: 100, enteredAt: "x" },
      ]),
    ).toEqual(["From 2026-08: Plan A, $100.00 per month"]);
  });
});

describe("report", () => {
  it("prints the operation's lines and returns its exit code", () => {
    const { deps, out } = testDeps();
    expect(report(deps, () => ({ lines: ["a", "b"], exitCode: 3 }))).toBe(3);
    expect(out).toEqual(["a", "b"]);
  });

  it("prints an operation's stderr lines after its stdout lines", () => {
    const { deps, out, err } = testDeps();
    expect(report(deps, () => ({ lines: ["done"], exitCode: 1, errors: ["partly"] }))).toBe(1);
    expect(out).toEqual(["done"]);
    expect(err).toEqual(["partly"]);
  });

  it.each([
    ["a SettingsError", new SettingsError("empty", "/s", "/s is empty")],
    ["an InstallRecordError", new InstallRecordError("/r", "not valid JSON")],
    ["a DiscoveryError", new DiscoveryError("CLAUDE_CONFIG_DIR is set but none of its entries...")],
    ["a PriceTableError", new PriceTableError("rows[0].input must be a non-negative number")],
    ["a PlanPriceError", new PlanPriceError("month must be YYYY-MM")],
    ["a NoDatabaseError", new NoDatabaseError("/d/usage.db")],
    ["an UnknownMetricError", new UnknownMetricError("savings")],
  ])("reports %s on stderr and returns 1", (_name, error) => {
    const { deps, out, err } = testDeps();
    expect(
      report(deps, () => {
        throw error;
      }),
    ).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual([`${error.message}. Nothing was changed.`]);
  });

  it("rethrows unexpected errors so bugs keep their stack", () => {
    const { deps } = testDeps();
    expect(() =>
      report(deps, () => {
        throw new TypeError("bug");
      }),
    ).toThrow("bug");
  });
});

describe("runCli", () => {
  it("prints help and exits 0 with no arguments", () => {
    const { deps, out } = testDeps();
    expect(runCli([], deps)).toBe(0);
    expect(out.join("\n")).toMatchSnapshot();
  });

  it.each([
    ["init"],
    ["ingest"],
    ["report"],
    ["explain"],
    ["plan-price"],
    ["plan-price set"],
    ["plan-price list"],
    ["uninstall"],
  ])("prints stable help for %s", (command) => {
    const { deps, out } = testDeps();
    expect(runCli([...command.split(" "), "--help"], deps)).toBe(0);
    expect(out.join("\n")).toMatchSnapshot();
  });

  it("exits non-zero for an unknown command and explains on stderr", () => {
    const { deps, err } = testDeps();
    expect(runCli(["frobnicate"], deps)).toBe(1);
    expect(err.join("\n")).toMatch(/unknown command/);
  });

  it("backfills from session logs after init and prints the summary", () => {
    const { deps, out } = testDeps();
    const settingsPath = join(deps.home, ".claude", "settings.json");
    mkdirSync(join(deps.home, ".claude", "projects", "-fixture-demo"), { recursive: true });
    writeFileSync(
      join(deps.home, ".claude", "projects", "-fixture-demo", "s.jsonl"),
      readFileSync(join(PACKAGE_ROOT, "fixtures/06-mixed-models/projects/-fixture-demo/s06.jsonl")),
    );
    expect(runCli(["init"], deps)).toBe(0);
    expect(out[0]).toBe(`Installed the status line hook in ${settingsPath}.`);
    expect(out).toContain("Backfill from session logs:");
    expect(out.some((line) => line.startsWith("Stored: 4 requests"))).toBe(true);
    expectNoBannedWording(out);
  });

  it("says the hook is installed when init's backfill fails, and exits 1", () => {
    // Before 2026-09-17 this printed only "<reason>. Nothing was changed." although settings.json
    // had already been changed and backed up.
    const { deps, out, err } = testDeps({ CLAUDE_CONFIG_DIR: "/definitely/not/here" });
    // CLAUDE_CONFIG_DIR also locates settings.json, so name one that exists.
    const settingsPath = join(deps.home, "settings.json");
    expect(runCli(["init", "--settings", settingsPath], deps)).toBe(1);
    expect(out[0]).toBe(`Installed the status line hook in ${settingsPath}.`);
    expect(out).not.toContain("Backfill from session logs:");
    expect(readFileSync(settingsPath, "utf8")).toContain("# nilometer-hook");
    expect(err).toEqual([
      "Session logs weren't imported: CLAUDE_CONFIG_DIR is set but none of its entries contains a projects/ directory: /definitely/not/here.",
      "The hook is installed. Fix that, then run `nilometer ingest`.",
    ]);
    expectNoBannedWording([...out, ...err]);
  });

  it("rethrows an unexpected error from init's backfill", () => {
    const { deps } = testDeps();
    let calls = 0;
    const flaky: CliDeps = {
      ...deps,
      // The install reads the clock once; the backfill's first read is a bug to surface.
      now: () => {
        calls += 1;
        if (calls > 1) {
          throw new RangeError("clock broke during backfill");
        }
        return new Date("2026-09-13T12:00:00Z");
      },
    };
    mkdirSync(join(deps.home, ".claude", "projects"), { recursive: true });
    expect(() => runCli(["init"], flaky)).toThrow("clock broke during backfill");
  });

  it("doesn't backfill when init refuses", () => {
    const { deps, out } = testDeps();
    mkdirSync(join(deps.home, ".claude"));
    writeFileSync(join(deps.home, ".claude", "settings.json"), '{"statusLine": "echo hi"}');
    expect(runCli(["init"], deps)).toBe(1);
    expect(out).not.toContain("Backfill from session logs:");
  });

  it("runs ingest with human output, then JSON output only", () => {
    const { deps, out } = testDeps();
    mkdirSync(join(deps.home, ".claude", "projects"), { recursive: true });
    expect(runCli(["ingest"], deps)).toBe(0);
    expect(out[0]).toBe(`Log roots read: ${join(deps.home, ".claude")}`);
    const jsonDeps = testDeps();
    mkdirSync(join(jsonDeps.deps.home, ".claude", "projects"), { recursive: true });
    expect(runCli(["ingest", "--json", "--full"], jsonDeps.deps)).toBe(0);
    expect(jsonDeps.out).toHaveLength(1);
    const parsed = JSON.parse(jsonDeps.out[0]!) as { run: { files: number } };
    expect(parsed.run.files).toBe(0);
  });

  it("reports an unusable CLAUDE_CONFIG_DIR from ingest with exit code 1", () => {
    const { deps, err } = testDeps({ CLAUDE_CONFIG_DIR: "/definitely/not/here" });
    expect(runCli(["ingest"], deps)).toBe(1);
    expect(err[0]).toMatch(/CLAUDE_CONFIG_DIR is set but none of its entries/);
  });

  it("runs init then uninstall against a temp home, restoring a custom status line", () => {
    const { deps, out } = testDeps();
    const settingsPath = join(deps.home, ".claude", "settings.json");
    mkdirSync(dirname(settingsPath));
    const original = '{\n  "statusLine": { "type": "command", "command": "echo hi" }\n}\n';
    writeFileSync(settingsPath, original);
    expect(runCli(["init"], deps)).toBe(0);
    expect(out[0]).toBe(`Installed the status line hook in ${settingsPath}.`);
    expect(runCli(["uninstall"], deps)).toBe(0);
    expect(readFileSync(settingsPath, "utf8")).toBe(original);
    expectNoBannedWording(out);
  });

  it("returns 1 with a message for an invalid settings file", () => {
    const { deps, err } = testDeps();
    const settingsPath = join(deps.home, "bad.json");
    writeFileSync(settingsPath, "{");
    expect(runCli(["init", "--settings", settingsPath], deps)).toBe(1);
    expect(err[0]).toMatch(/is not valid JSON/);
  });

  it("sets, replaces, and lists plan prices in the data directory", () => {
    const { deps, out } = testDeps();
    const dataDir = join(deps.home, "data");
    expect(runCli(["plan-price", "list", "--data-dir", dataDir], deps)).toBe(0);
    expect(
      runCli(
        ["plan-price", "set", "2026-09", "200", "--name", "Plan A", "--data-dir", dataDir],
        deps,
      ),
    ).toBe(0);
    expect(
      runCli(
        ["plan-price", "set", "2026-09", "100", "--name", "Plan B", "--data-dir", dataDir],
        deps,
      ),
    ).toBe(0);
    expect(runCli(["plan-price", "list", "--data-dir", dataDir], deps)).toBe(0);
    expect(out).toEqual([
      "No plan prices entered.",
      "Plan price from 2026-09: Plan A, $200.00 per month (USD list price).",
      `Stored in ${join(dataDir, "usage.db")}`,
      "Plan price from 2026-09: Plan B, $100.00 per month (USD list price).",
      "Replaced the entry for 2026-09: Plan A, $200.00 per month.",
      `Stored in ${join(dataDir, "usage.db")}`,
      "From 2026-09: Plan B, $100.00 per month",
    ]);
  });

  it("rejects an invalid plan price before creating anything, and requires a name", () => {
    const { deps, out, err } = testDeps();
    const dataDir = join(deps.home, "data");
    expect(
      runCli(["plan-price", "set", "Sept", "200", "--name", "A", "--data-dir", dataDir], deps),
    ).toBe(1);
    expect(err).toEqual(['month must be YYYY-MM, got "Sept". Nothing was changed.']);
    expect(existsSync(dataDir)).toBe(false);
    expect(runCli(["plan-price", "set", "2026-09", "200"], deps)).toBe(1);
    expect(err.join("\n")).toMatch(/required option '--name <plan>'/);
    expect(out).toEqual([]);
  });

  it("verifies against ccusage without reaching the network", () => {
    // The runner is injected, so this exercises the whole command — database read, comparison,
    // wording, exit code — with no npx and no download (D-064).
    const { deps, out } = testDeps();
    mkdirSync(join(deps.home, ".claude", "projects", "-fixture-demo"), { recursive: true });
    writeFileSync(
      join(deps.home, ".claude", "projects", "-fixture-demo", "s.jsonl"),
      readFileSync(join(PACKAGE_ROOT, "fixtures/06-mixed-models/projects/-fixture-demo/s06.jsonl")),
    );
    expect(runCli(["ingest"], deps)).toBe(0);
    out.length = 0;

    // ccusage seeing nothing at all: every day is one this tool has and it cannot.
    const empty = { ...deps, runCcusage: () => JSON.stringify({ daily: [] }) };
    expect(runCli(["verify"], empty)).toBe(1);
    expect(out.join("\n")).toMatch(/No day could be compared/);

    out.length = 0;
    const wrong = {
      ...deps,
      runCcusage: () =>
        JSON.stringify({
          daily: [
            {
              date: "2026-09-01",
              modelBreakdowns: [
                {
                  modelName: "claude-opus-5",
                  inputTokens: 1,
                  outputTokens: 999,
                  cacheReadTokens: 0,
                  cacheCreationTokens: 0,
                  cost: 0,
                },
              ],
            },
          ],
        }),
    };
    expect(runCli(["verify"], wrong)).toBe(1);
    expect(out.join("\n")).toMatch(/difference/);
    expect(out.join("\n")).toContain("claude-opus-5");
  });

  it("reports on the database after ingest, as a table or as JSON, and refuses before any ingest", () => {
    const { deps, out, err } = testDeps();
    expect(runCli(["report"], deps)).toBe(1);
    expect(err[0]).toMatch(
      /^No database at .*usage\.db; run init or ingest first\. Nothing was changed\.$/,
    );
    mkdirSync(join(deps.home, ".claude", "projects", "-fixture-demo"), { recursive: true });
    writeFileSync(
      join(deps.home, ".claude", "projects", "-fixture-demo", "s.jsonl"),
      readFileSync(join(PACKAGE_ROOT, "fixtures/06-mixed-models/projects/-fixture-demo/s06.jsonl")),
    );
    expect(runCli(["ingest"], deps)).toBe(0);
    out.length = 0;
    expect(runCli(["report"], deps)).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Times are in America/Chicago.");
    expect(out[0]).toContain(`Database: ${join("~", ".local", "share", "nilometer", "usage.db")}`);
    expectNoBannedWording(out[0]!.split("\n"));
    out.length = 0;
    expect(runCli(["report", "--json"], deps)).toBe(0);
    const parsed = JSON.parse(out[0]!) as { observed: { byModel: unknown[] }; projected: object };
    expect(parsed.observed.byModel).toHaveLength(3);
  });

  it("saves a dated copy with --save, keeping stdout pure JSON when combined with --json", () => {
    const { deps, out, err } = testDeps();
    mkdirSync(join(deps.home, ".claude", "projects", "-fixture-demo"), { recursive: true });
    writeFileSync(
      join(deps.home, ".claude", "projects", "-fixture-demo", "s.jsonl"),
      readFileSync(join(PACKAGE_ROOT, "fixtures/06-mixed-models/projects/-fixture-demo/s06.jsonl")),
    );
    expect(runCli(["ingest"], deps)).toBe(0);
    const reports = join(deps.home, ".local", "share", "nilometer", "reports");
    out.length = 0;
    expect(runCli(["report", "--save"], deps)).toBe(0);
    // The clock is 2026-09-13T12:00:00Z, 07:00:00 in America/Chicago.
    // Shown with the platform's separators after ~.
    const shown = join("~", ".local", "share", "nilometer", "reports");
    expect(out.at(-1)).toBe(
      `Saved: ${join(shown, "report_2026-09-13_070000.txt")} and ${join(shown, "report_2026-09-13_070000.json")}`,
    );
    expect(readFileSync(join(reports, "report_2026-09-13_070000.txt"), "utf8")).toBe(`${out[0]}\n`);
    out.length = 0;
    expect(runCli(["report", "--json", "--save"], deps)).toBe(0);
    expect(out).toHaveLength(1);
    expect(() => JSON.parse(out[0]!) as unknown).not.toThrow();
    expect(err.at(-1)).toBe(
      `Saved: ${join(shown, "report_2026-09-13_070000-2.txt")} and ${join(shown, "report_2026-09-13_070000-2.json")}`,
    );
    expectNoBannedWording(out);
  });

  it("explains a metric's events, lists all with --all, and rejects unknown metrics first", () => {
    const { deps, out, err } = testDeps();
    expect(runCli(["explain", "savings"], deps)).toBe(1);
    expect(err[0]).toMatch(/^Unknown metric "savings"; choose one of: limit-hits, /);
    expect(runCli(["explain", "by-model"], deps)).toBe(1);
    expect(err[1]).toMatch(/^No database at /);
    mkdirSync(join(deps.home, ".claude", "projects", "-fixture-demo"), { recursive: true });
    writeFileSync(
      join(deps.home, ".claude", "projects", "-fixture-demo", "s.jsonl"),
      readFileSync(join(PACKAGE_ROOT, "fixtures/06-mixed-models/projects/-fixture-demo/s06.jsonl")),
    );
    expect(runCli(["ingest"], deps)).toBe(0);
    out.length = 0;
    expect(runCli(["explain", "by-model", "--all"], deps)).toBe(0);
    expect(out[0]).toBe("Explain: Claude Code tokens by model (observed)");
    expect(
      out.some((line) => /projects\/-fixture-demo\/s\.jsonl:\d+ \(byte \d+\)$/.test(line)),
    ).toBe(true);
    expect(out.join("\n")).not.toContain("these don't match");
    expectNoBannedWording(out);
  });

  it.skipIf(!HAS_POSIX_MODES)(
    "tightens an older, world-readable install on ingest, report, explain, and plan-price (D-043)",
    () => {
      const { deps, out, err } = testDeps();
      mkdirSync(join(deps.home, ".claude", "projects", "-fixture-demo"), { recursive: true });
      writeFileSync(
        join(deps.home, ".claude", "projects", "-fixture-demo", "s.jsonl"),
        readFileSync(
          join(PACKAGE_ROOT, "fixtures/06-mixed-models/projects/-fixture-demo/s06.jsonl"),
        ),
      );
      const dataDir = join(deps.home, ".local", "share", "nilometer");
      /** Makes the data directory and database readable by other accounts, as a pre-D-043 install left them. */
      const loosen = (): void => {
        chmodSync(dataDir, 0o755);
        chmodSync(join(dataDir, "usage.db"), 0o644);
      };
      expect(runCli(["ingest"], deps)).toBe(0);
      expect(out.some((line) => line.startsWith("Made Nilometer's data owner-only"))).toBe(false);
      loosen();
      out.length = 0;
      expect(runCli(["ingest"], deps)).toBe(0);
      expect(out).toContain(
        "Made Nilometer's data owner-only: 2 paths were readable by other accounts on this computer.",
      );
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      for (const [args, expected] of [
        [["report"], 0],
        [["report", "--json"], 0],
        [["explain", "limit-hits"], 0],
        [["plan-price", "list"], 0],
        [["plan-price", "set", "2026-09", "100", "--name", "A"], 0],
      ] as const) {
        loosen();
        out.length = 0;
        err.length = 0;
        expect(runCli([...args], deps)).toBe(expected);
        // stderr only, so --json stdout stays parseable.
        expect(err).toEqual([
          "Made Nilometer's data owner-only: 2 paths were readable by other accounts on this computer.",
        ]);
        expect(out.join("\n")).not.toContain("owner-only");
        expect(statSync(join(dataDir, "usage.db")).mode & 0o777).toBe(0o600);
      }
    },
  );

  it("rethrows a non-commander error raised while parsing", () => {
    const { deps } = testDeps();
    const broken: CliDeps = {
      ...deps,
      now: () => {
        throw new RangeError("clock broke");
      },
    };
    expect(() => runCli(["init"], broken)).toThrow("clock broke");
  });
});
