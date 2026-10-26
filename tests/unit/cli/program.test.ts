/**
 * @file Unit tests for cli/program.ts, including `report --save --html` (step G1.4, D-070).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  BAD_PORT,
  type CliDeps,
  describeIngest,
  describeInit,
  describePlanPriceList,
  describePlanPriceSet,
  describeDeletion,
  describeVerify,
  describeUninstall,
  HTML_NEEDS_SAVE,
  OPEN_NEEDS_HTML,
  TERMINAL_ONLY_NOTE,
  parsePort,
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
import { renderHtmlReport } from "../../../viewer/html.js";
import { loadHtmlData } from "../../../viewer/html-data.js";
import { NoDatabaseError, withReportDatabase } from "../../../viewer/report.js";
import { PriceTableError } from "../../../core/pricing/prices.js";
import { SettingsError } from "../../../core/settings/settings-file.js";
import { buildHookCommand } from "../../../core/settings/statusline.js";
import { LABELS } from "../../../viewer/render.js";
import type { ListenOptions } from "../../../core/view/server.js";
import { BUILT_SCHEMA_VERSION } from "../../../core/db/database.js";
import { DatabaseSync } from "node:sqlite";

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
      // A test that reaches the real opener would launch a browser (D-082); fail it instead.
      openPage: () => {
        throw new Error("a test reached the real page opener");
      },
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

/**
 * Copies fixture 06 (one session, three models) into the test home's logs and ingests it, so
 * `report` has a database to read.
 * @param deps - Dependencies from {@link testDeps}.
 */
function ingestFixture06(deps: CliDeps): void {
  mkdirSync(join(deps.home, ".claude", "projects", "-fixture-demo"), { recursive: true });
  writeFileSync(
    join(deps.home, ".claude", "projects", "-fixture-demo", "s.jsonl"),
    readFileSync(join(PACKAGE_ROOT, "fixtures/06-mixed-models/projects/-fixture-demo/s06.jsonl")),
  );
  expect(runCli(["ingest"], deps)).toBe(0);
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
      modelFallbacks: 2,
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
      "Stored: 12 requests (2 without IDs), 4 limit hits, 5 other error or retry events, 2 requests refused and retried with another model; requests stored from 2026-09-01T00:00:00.000Z to 2026-09-02T00:00:00.000Z (UTC).",
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
        modelFallbacks: 0,
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
    expect(lines[0]).toContain("Compared 12 UTC days against ccusage");
    expect(lines.join("\n")).toContain("Every one matched");
    expect(exitCode).toBe(0);
  });

  it("names the skipped day as the current UTC day, since it can be tomorrow's local date (D-085)", () => {
    // Found on a machine at UTC-6, at 19:00 local on 2026-10-14: verify skipped
    // 2026-10-15 and called it "today".
    const { lines } = describeVerify({ ...clean, skippedToday: "2026-10-15" });
    expect(lines).toContain(
      "2026-10-15 (the current UTC day) was not compared: both sides are still being written to, so a difference there would be the clock.",
    );
    expect(lines.join("\n")).not.toMatch(/\btoday\b/);
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
    // Every branch's wording, the clean result's too, is held to the banned list (D-085).
    expectNoBannedWording([...lines, ...describeVerify(clean).lines]);
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

  it("prints the installed version for --version and -v, and exits 0 (G5.5)", () => {
    const version = (
      JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    for (const flag of ["--version", "-v"]) {
      const { deps, out } = testDeps();
      expect(runCli([flag], deps)).toBe(0);
      expect(out).toEqual([version]);
    }
  });

  it.each([
    ["init"],
    ["ingest"],
    ["report"],
    ["explain"],
    ["plan-price"],
    ["plan-price set"],
    ["plan-price list"],
    ["alias set"],
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

  it("sets, lists, and removes a repository alias, and the report names it (D-092)", () => {
    const { deps, out, err } = testDeps();
    ingestFixture06(deps);
    // Fixture 06's one repository, as attributed: its cwd, which doesn't exist here.
    out.length = 0;
    expect(runCli(["report", "--json"], deps)).toBe(0);
    const from = (JSON.parse(out.join("\n")) as { observed: { byRepo: { repository: string }[] } })
      .observed.byRepo[0]?.repository as string;
    const to = join(deps.home, "Projects", "renamed");
    out.length = 0;
    expect(runCli(["alias", "list"], deps)).toBe(0);
    expect(runCli(["alias", "set", from, `${to}/`], deps)).toBe(0);
    expect(runCli(["alias", "list"], deps)).toBe(0);
    const shownTo = join("~", "Projects", "renamed");
    expect(out.slice(0, 2)).toEqual([
      "No aliases entered.",
      `${from} now counts under ${shownTo}.`,
    ]);
    expect(out[2]).toMatch(/^Stored in /);
    expect(out[3]).toBe(`${from} counts under ${shownTo}`);
    // The report counts the requests under the new path and names the alias under the table.
    out.length = 0;
    expect(runCli(["report"], deps)).toBe(0);
    expect(out.join("\n")).toContain(`  ${LABELS.alias}: ${from} counts under ${shownTo}`);
    out.length = 0;
    expect(runCli(["alias", "remove", from], deps)).toBe(0);
    expect(out).toEqual([`${from} no longer counts under ${shownTo}.`]);
    expectNoBannedWording(out);
    // Refused with exit 1 and "Nothing was changed": a relative path, a second removal.
    expect(runCli(["alias", "set", "relative/path", to], deps)).toBe(1);
    expect(runCli(["alias", "remove", from], deps)).toBe(1);
    expect(err.slice(-2)).toEqual([
      'a repository path must be absolute, got "relative/path". Nothing was changed.',
      `there's no alias for ${from}. Nothing was changed.`,
    ]);
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
    // Without --html, no page is written by either save.
    expect(readdirSync(reports).filter((name) => name.endsWith(".html"))).toEqual([]);
  });

  it("refuses --html without --save before opening anything, naming both flags", () => {
    // With no database at all, the flag error comes first, not "No database at ...": the check
    // runs before anything is opened.
    const fresh = testDeps();
    expect(runCli(["report", "--html"], fresh.deps)).toBe(1);
    expect(fresh.err).toEqual([HTML_NEEDS_SAVE]);
    expect(existsSync(join(fresh.deps.home, ".local"))).toBe(false);

    const { deps, out, err } = testDeps();
    ingestFixture06(deps);
    const dataDir = join(deps.home, ".local", "share", "nilometer");
    const before = readdirSync(dataDir).sort();
    out.length = 0;
    for (const args of [
      ["report", "--html"],
      ["report", "--html", "--json"],
    ]) {
      err.length = 0;
      expect(runCli(args, deps)).toBe(1);
      expect(err).toEqual([HTML_NEEDS_SAVE]);
      expect(out).toEqual([]);
    }
    expect(HTML_NEEDS_SAVE).toMatch(/--html/);
    expect(HTML_NEEDS_SAVE).toMatch(/--save/);
    expectNoBannedWording([HTML_NEEDS_SAVE]);
    // Nothing was written: no reports folder, and the data directory holds what ingest left.
    expect(readdirSync(dataDir).sort()).toEqual(before);
    expect(existsSync(join(dataDir, "reports"))).toBe(false);
  });

  it("writes the HTML page beside the text and JSON with --save --html, and names all three", () => {
    const { deps, out } = testDeps();
    ingestFixture06(deps);
    const reports = join(deps.home, ".local", "share", "nilometer", "reports");
    out.length = 0;
    expect(runCli(["report", "--save", "--html"], deps)).toBe(0);
    // The clock is 2026-09-13T12:00:00Z, 07:00:00 in America/Chicago (CDT, UTC-5).
    const shown = join("~", ".local", "share", "nilometer", "reports");
    expect(out.at(-1)).toBe(
      `Saved: ${join(shown, "report_2026-09-13_070000.txt")}, ${join(shown, "report_2026-09-13_070000.json")}, and ${join(shown, "report_2026-09-13_070000.html")}`,
    );
    expect(readdirSync(reports).sort()).toEqual([
      "report_2026-09-13_070000.html",
      "report_2026-09-13_070000.json",
      "report_2026-09-13_070000.txt",
    ]);
    // The page is whatever the HTML report draws from this database at the command's clock, so
    // this holds for any implementation of the two G1 functions.
    const expected = withReportDatabase(toPlanDatabaseOptions({}, deps), (db) =>
      renderHtmlReport(loadHtmlData(db, { timeZone: "America/Chicago", generatedAt: deps.now() })),
    );
    expect(readFileSync(join(reports, "report_2026-09-13_070000.html"), "utf8")).toBe(expected);
  });

  it("warns in the text, JSON, and page when the status line's hook file is missing, writing no settings (D-081)", () => {
    const { deps, out } = testDeps();
    ingestFixture06(deps);
    // Settings as init would leave them, pointing at a checkout that has since moved.
    const settingsPath = join(deps.home, ".claude", "settings.json");
    const gone = join(deps.home, "gone", "hooks", "statusline.sh");
    const settings = JSON.stringify({
      statusLine: { type: "command", command: buildHookCommand(gone, "/data") },
    });
    writeFileSync(settingsPath, settings);
    out.length = 0;
    expect(runCli(["report", "--save", "--html"], deps)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(LABELS.hookMissing);
    expect(text).toContain(`Missing hook file: ${join("~", "gone", "hooks", "statusline.sh")}`);
    const reports = join(deps.home, ".local", "share", "nilometer", "reports");
    const page = readFileSync(join(reports, "report_2026-09-13_070000.html"), "utf8");
    expect(page).toContain('<div class="hook-warning" role="note">');
    const saved = JSON.parse(
      readFileSync(join(reports, "report_2026-09-13_070000.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(saved["missingHookPath"]).toBe(gone);
    // Read only: the settings file is byte-for-byte what was written.
    expect(readFileSync(settingsPath, "utf8")).toBe(settings);
  });

  it("checks the settings file under CLAUDE_CONFIG_DIR, where init would look (D-081)", () => {
    const config = mkdtempSync(join(tmpdir(), "aua-cli-config-"));
    const { deps, out } = testDeps({ CLAUDE_CONFIG_DIR: config });
    mkdirSync(join(config, "projects"));
    expect(runCli(["ingest"], deps)).toBe(0);
    const gone = join(config, "gone", "statusline.sh");
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: buildHookCommand(gone, "/data") } }),
    );
    out.length = 0;
    expect(runCli(["report"], deps)).toBe(0);
    expect(out.join("\n")).toContain(LABELS.hookMissing);
    // The home directory's settings aren't the ones Claude Code reads here.
    expect(existsSync(join(deps.home, ".claude", "settings.json"))).toBe(false);
  });

  it("opens the saved page with --open, passing its full path once (D-082)", () => {
    const base = testDeps();
    ingestFixture06(base.deps);
    const opened: string[] = [];
    const deps: CliDeps = {
      ...base.deps,
      openPage: (path) => {
        opened.push(path);
        return { opened: true };
      },
    };
    base.out.length = 0;
    base.err.length = 0;
    expect(runCli(["report", "--save", "--html", "--open"], deps)).toBe(0);
    const page = join(
      deps.home,
      ".local",
      "share",
      "nilometer",
      "reports",
      "report_2026-09-13_070000.html",
    );
    expect(opened).toEqual([page]);
    expect(existsSync(page)).toBe(true);
    // Nothing extra is printed when it opens: the Saved line already names the page.
    expect(base.out.at(-1)).toMatch(/^Saved: .*report_2026-09-13_070000\.html$/);
    expect(base.err).toEqual([]);
  });

  it("prints where the page is and still succeeds when it can't be opened, keeping --json stdout pure", () => {
    const base = testDeps();
    ingestFixture06(base.deps);
    const deps: CliDeps = {
      ...base.deps,
      openPage: () => ({ opened: false, reason: "xdg-open exited with 3" }),
    };
    const shown = join("~", ".local", "share", "nilometer", "reports");
    for (const [args, name] of [
      [["report", "--save", "--html", "--open"], "report_2026-09-13_070000.html"],
      [["report", "--json", "--save", "--html", "--open"], "report_2026-09-13_070000-2.html"],
    ] as const) {
      base.out.length = 0;
      base.err.length = 0;
      expect(runCli([...args], deps)).toBe(0);
      expect(base.err.at(-1)).toBe(
        `Couldn't open the page (xdg-open exited with 3). It's saved at ${join(shown, name)}`,
      );
      expectNoBannedWording(base.err);
    }
    // The --json run's stdout is one JSON document and nothing else.
    expect(() => JSON.parse(base.out.join("\n")) as unknown).not.toThrow();
  });

  it("refuses --open without --save --html before opening anything", () => {
    const fresh = testDeps();
    for (const args of [
      ["report", "--open"],
      ["report", "--save", "--open"],
      ["report", "--html", "--open"],
      ["report", "--json", "--open"],
    ]) {
      fresh.err.length = 0;
      expect(runCli(args, fresh.deps)).toBe(1);
      expect(fresh.err).toEqual([OPEN_NEEDS_HTML]);
      expect(fresh.out).toEqual([]);
    }
    // Nothing was created, not even the data directory.
    expect(existsSync(join(fresh.deps.home, ".local"))).toBe(false);
    expect(OPEN_NEEDS_HTML).toMatch(/--save --html/);
    expectNoBannedWording([OPEN_NEEDS_HTML]);
  });

  it.skipIf(!HAS_POSIX_MODES)("writes the HTML page readable only by the owner", () => {
    const { deps } = testDeps();
    ingestFixture06(deps);
    expect(runCli(["report", "--save", "--html"], deps)).toBe(0);
    const page = join(
      deps.home,
      ".local",
      "share",
      "nilometer",
      "reports",
      "report_2026-09-13_070000.html",
    );
    expect(statSync(page).mode & 0o777).toBe(0o600);
  });

  it("keeps stdout pure JSON with --json --save --html, and names the page on stderr", () => {
    const { deps, out, err } = testDeps();
    ingestFixture06(deps);
    out.length = 0;
    err.length = 0;
    expect(runCli(["report", "--json", "--save", "--html"], deps)).toBe(0);
    expect(out).toHaveLength(1);
    expect(() => JSON.parse(out[0]!) as unknown).not.toThrow();
    const shown = join("~", ".local", "share", "nilometer", "reports");
    expect(err).toEqual([
      `Saved: ${join(shown, "report_2026-09-13_070000.txt")}, ${join(shown, "report_2026-09-13_070000.json")}, and ${join(shown, "report_2026-09-13_070000.html")}`,
    ]);
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

describe("parsePort (D-097)", () => {
  it("reads a port from 1 to 65535, and 0 (any free port) when none is given", () => {
    expect(parsePort(undefined)).toBe(0);
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort("65535")).toBe(65_535);
    for (const bad of ["0", "65536", "abc", "1e3", "-1", "80.5", "123456"]) {
      expect(parsePort(bad)).toBeUndefined();
    }
  });
});

describe("view (D-097)", () => {
  /**
   * Deps that keep the server's options instead of opening a port, and record what opened.
   * @returns The deps, the captured options, what was opened, and the output.
   */
  function viewDeps(): {
    deps: CliDeps;
    served: ListenOptions[];
    opened: string[];
    out: string[];
    err: string[];
  } {
    const base = testDeps();
    ingestFixture06(base.deps);
    base.out.length = 0;
    const served: ListenOptions[] = [];
    const opened: string[] = [];
    const deps: CliDeps = {
      ...base.deps,
      viewToken: () => "tok",
      serveView: (options) => {
        served.push(options);
      },
      openPage: (path) => {
        opened.push(path);
        return { opened: true };
      },
    };
    return { deps, served, opened, out: base.out, err: base.err };
  }

  it("ingests, serves the page with a Refresh button, and opens it once listening", () => {
    const { deps, served, opened, out } = viewDeps();
    expect(runCli(["view"], deps)).toBe(0);
    expect(served).toHaveLength(1);
    const options = served[0] as ListenOptions;
    expect([options.token, options.port]).toEqual(["tok", 0]);
    expect(options.page()).toContain('data-path="/tok/refresh"');
    expect(options.page()).toContain(LABELS.title);
    // Nothing is printed or opened until the server is listening.
    expect([out, opened]).toEqual([[], []]);
    options.onListening("http://127.0.0.1:4000/tok/");
    expect(out).toEqual([
      "Showing the report at http://127.0.0.1:4000/tok/",
      "Refresh on the page reads new log lines and rebuilds it. Press Ctrl+C here to stop.",
    ]);
    expect(opened).toEqual(["http://127.0.0.1:4000/tok/"]);
  });

  it("reads new log lines and rebuilds the page on refresh", () => {
    const { deps, served } = viewDeps();
    runCli(["view", "--port", "4000"], deps);
    const options = served[0] as ListenOptions;
    expect(options.port).toBe(4000);
    expect(options.refresh()).toEqual({ ok: true, message: "0 new lines read" });
    const before = options.page();
    writeFileSync(
      join(deps.home, ".claude", "projects", "-fixture-demo", "t.jsonl"),
      `${JSON.stringify({
        type: "assistant",
        sessionId: "s-new",
        uuid: "u-new",
        timestamp: "2026-09-12T23:00:00Z",
        message: {
          id: "m-new",
          model: "claude-sonnet-5",
          usage: { input_tokens: 1, output_tokens: 7 },
        },
      })}\n`,
    );
    expect(options.refresh()).toEqual({ ok: true, message: "1 new line read" });
    expect(options.page()).not.toBe(before);
  });

  it("prints the address without opening anything with --no-open, and says when a browser can't open", () => {
    const quiet = viewDeps();
    runCli(["view", "--no-open"], quiet.deps);
    (quiet.served[0] as ListenOptions).onListening("http://127.0.0.1:4000/tok/");
    expect(quiet.opened).toEqual([]);
    const blocked = viewDeps();
    const deps: CliDeps = {
      ...blocked.deps,
      openPage: () => ({ opened: false, reason: "xdg-open exited with 3" }),
    };
    runCli(["view"], deps);
    (blocked.served[0] as ListenOptions).onListening("http://127.0.0.1:4000/tok/");
    expect(blocked.err).toEqual([
      "Couldn't open a browser (xdg-open exited with 3). Open the address above.",
    ]);
  });

  it("refuses a bad --port before reading anything, and reports a server that stops", () => {
    const { deps, served, err } = viewDeps();
    expect(runCli(["view", "--port", "99999"], deps)).toBe(1);
    expect(served).toEqual([]);
    expect(err).toEqual([BAD_PORT]);
    err.length = 0;
    const exitCode = process.exitCode;
    try {
      runCli(["view"], deps);
      (served[0] as ListenOptions).onError("port 4000 on 127.0.0.1 is in use");
      expect(err).toEqual(["nilometer view stopped: port 4000 on 127.0.0.1 is in use"]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCode;
    }
  });

  it("defaults to a fresh random token each run", () => {
    const { deps, served } = viewDeps();
    const random: CliDeps = { ...deps, viewToken: undefined };
    runCli(["view"], random);
    runCli(["view"], random);
    const [a, b] = served.map((o) => o.token);
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("a database newer than this build (M15)", () => {
  it("is refused with what to do, and nothing changes", () => {
    const { deps, err } = testDeps();
    const dir = join(deps.home, ".local", "share", "nilometer");
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "usage.db"));
    db.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES (999, '999_future.sql', 'x');",
    );
    db.close();
    expect(runCli(["report"], deps)).toBe(1);
    // The data folder made here isn't owner-only, so a tightening note may come first (D-043).
    expect(err.slice(-1)).toEqual([
      `this database was updated by a newer Nilometer (schema 999), and this build knows schema ${BUILT_SCHEMA_VERSION}. Update Nilometer, or in a clone run npm run build. Nothing was changed.`,
    ]);
  });
});
