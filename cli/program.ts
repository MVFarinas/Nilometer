/**
 * @file Command-line program: the `init`, `ingest`, `report`, `explain`, `plan-price`, and
 * `uninstall` commands and their messages.
 *
 * Implements docs/development.md P1.3, P4.8, P7.1, P7.2, and the plan price entry D-027 needs. Logic lives in core/install/install.ts; this module only parses flags,
 * calls it, and turns outcomes into words. All wording here follows CLAUDE.md "Wording is part of
 * correctness": messages state what happened, never advice or judgment.
 */
import { dirname } from "node:path";

import { Command, CommanderError } from "commander";

import { type IngestCommandOutcome, runIngestCommand } from "../core/ingest/command.js";
import { DiscoveryError } from "../core/ingest/discover.js";
import { describeTightened } from "../core/install/private-files.js";
import { InstallRecordError } from "../core/install/record.js";
import {
  type PlanDatabaseOptions,
  type PlanPriceEntry,
  PlanPriceError,
  type PlanPriceRow,
  listPlanPrices,
  setPlanPrice,
  validatePlanPrice,
  withPlanDatabase,
} from "../core/plans/plan-prices.js";
import { PriceTableError } from "../core/pricing/prices.js";
import {
  type InitOutcome,
  type InstallOptions,
  type UninstallOutcome,
  runInit,
  runUninstall,
} from "../core/install/install.js";
import { SettingsError } from "../core/settings/settings-file.js";
import { METRIC_NAMES, UnknownMetricError, explain, renderExplanation } from "../viewer/explain.js";
import { NoDatabaseError, loadReport, withReportDatabase } from "../viewer/report.js";
import { saveReport } from "../viewer/save.js";
import { displayPath, renderReport, reportJson } from "../viewer/render.js";

/** Everything the program needs from its environment, injected so tests never touch real homes. */
export interface CliDeps {
  /** The user's home directory. */
  readonly home: string;
  /** Process environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Package root containing `hooks/statusline.sh`. */
  readonly packageRoot: string;
  /** Current time. */
  readonly now: () => Date;
  /** Writes a line to stdout. */
  readonly print: (line: string) => void;
  /** Writes a line to stderr. */
  readonly printError: (line: string) => void;
  /** IANA zone the report shows times in: the machine's zone (D-007). */
  readonly timeZone: string;
}

/** Flags shared by `init` and `uninstall`. */
interface LocationFlags {
  /** `--settings <path>` */
  readonly settings?: string;
  /** `--data-dir <path>` */
  readonly dataDir?: string;
}

/** Flags of the `ingest` command. */
interface IngestFlags {
  /** `--data-dir <path>` */
  readonly dataDir?: string | undefined;
  /** `--full`: reread every file from the start. */
  readonly full?: boolean;
  /** `--json`: print the outcome as JSON on stdout and nothing else. */
  readonly json?: boolean;
}

/** Readings need a terminal session (D-029); said at install so empty usage windows aren't a surprise. */
export const TERMINAL_ONLY_NOTE =
  "Readings are recorded only when Claude Code runs in a terminal; the VS Code extension doesn't run the status line.";

/** Flags of the `report` command. */
interface ReportFlags {
  /** `--data-dir <path>` */
  readonly dataDir?: string | undefined;
  /** `--json`: print unrounded rows and labels as JSON. */
  readonly json?: boolean;
  /** `--save`: also write a dated text and JSON copy to the data directory (D-030). */
  readonly save?: boolean;
}

/** Flags of the `explain` command. */
interface ExplainFlags {
  /** `--data-dir <path>` */
  readonly dataDir?: string | undefined;
  /** `--all`: list every event instead of the first few per number. */
  readonly all?: boolean;
}

/** Events listed per number by `explain` without `--all`. */
export const EXPLAIN_EVENT_LIMIT = 20;

/** Flags of the `plan-price` commands. */
interface PlanPriceFlags {
  /** `--data-dir <path>` */
  readonly dataDir?: string | undefined;
  /** `--name <plan>` (`set` only). */
  readonly name?: string;
}

/**
 * Builds the options for opening the plan price database.
 * @param flags - Parsed `plan-price` flags.
 * @param deps - Program dependencies.
 * @returns Options for `withPlanDatabase`.
 */
export function toPlanDatabaseOptions(flags: PlanPriceFlags, deps: CliDeps): PlanDatabaseOptions {
  return {
    home: deps.home,
    env: {
      NILOMETER_HOME: deps.env["NILOMETER_HOME"],
      XDG_DATA_HOME: deps.env["XDG_DATA_HOME"],
    },
    dataDirOverride: flags.dataDir,
    packageRoot: deps.packageRoot,
  };
}

/**
 * Turns an optional message into zero or one output lines.
 * @param line - The message, or null.
 * @returns An array holding the message, or an empty array.
 */
function optionalLine(line: string | null): string[] {
  return line === null ? [] : [line];
}

/**
 * Tells the user, on stderr so stdout stays clean, that data paths were made owner-only (D-043).
 * @param deps - Program dependencies.
 * @param tightened - Paths that were tightened; nothing is printed when empty.
 */
export function noteTightened(deps: CliDeps, tightened: readonly string[]): void {
  const note = describeTightened(tightened);
  if (note !== null) {
    deps.printError(note);
  }
}

/**
 * Formats a USD amount for plan price messages.
 * @param usd - Dollars.
 * @returns E.g. `$200.00`.
 */
function formatUsd(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * Describes a stored plan price.
 * @param entry - What was stored.
 * @param previous - The row it replaced, if any.
 * @param databasePath - Where it was stored.
 * @returns Lines for stdout.
 */
export function describePlanPriceSet(
  entry: PlanPriceEntry,
  previous: PlanPriceRow | null,
  databasePath: string,
): string[] {
  return [
    `Plan price from ${entry.month}: ${entry.planName}, ${formatUsd(entry.usdPerMonth)} per month (USD list price).`,
    ...(previous === null
      ? []
      : [
          `Replaced the entry for ${previous.month}: ${previous.planName}, ${formatUsd(previous.usdPerMonth)} per month.`,
        ]),
    `Stored in ${databasePath}`,
  ];
}

/**
 * Describes the stored plan prices.
 * @param rows - Rows from `listPlanPrices`.
 * @returns Lines for stdout.
 */
export function describePlanPriceList(rows: readonly PlanPriceRow[]): string[] {
  if (rows.length === 0) {
    return ["No plan prices entered."];
  }
  return rows.map(
    (row) => `From ${row.month}: ${row.planName}, ${formatUsd(row.usdPerMonth)} per month`,
  );
}

/**
 * Builds ingest options from flags and dependencies.
 * @param flags - Parsed `ingest` flags (or `init`'s location flags for the backfill).
 * @param deps - Program dependencies.
 * @returns Options for `runIngestCommand`.
 */
export function toIngestOptions(
  flags: IngestFlags,
  deps: CliDeps,
): Parameters<typeof runIngestCommand>[0] {
  return {
    home: deps.home,
    env: {
      CLAUDE_CONFIG_DIR: deps.env["CLAUDE_CONFIG_DIR"],
      XDG_CONFIG_HOME: deps.env["XDG_CONFIG_HOME"],
      NILOMETER_HOME: deps.env["NILOMETER_HOME"],
      XDG_DATA_HOME: deps.env["XDG_DATA_HOME"],
    },
    dataDirOverride: flags.dataDir,
    full: flags.full === true,
    packageRoot: deps.packageRoot,
    now: deps.now,
  };
}

/**
 * Turns an ingest outcome into output lines. Counts only: what was read and what is stored.
 * @param outcome - Result of `runIngestCommand`.
 * @returns Lines for stdout.
 */
export function describeIngest(outcome: IngestCommandOutcome): string[] {
  const { run, totals } = outcome;
  const span =
    totals.firstRequestUtc === null || totals.lastRequestUtc === null
      ? "no requests stored yet"
      : `requests stored from ${totals.firstRequestUtc} to ${totals.lastRequestUtc} (UTC)`;
  return [
    `Log roots read: ${outcome.roots.length === 0 ? "none found" : outcome.roots.join(", ")}`,
    `This run: ${run.files} files, ${run.linesRead} complete lines read, ${run.linesStored} new, ${run.filesRewritten} rewritten files reread${run.spoolRead ? ", status line spool read" : ""}.`,
    `Stored: ${totals.requests} requests (${totals.unkeyedRequests} without IDs), ${totals.limitHits} limit hits, ${totals.otherEvents} other error or retry events; ${span}.`,
    `Status line: ${totals.statusReadings} readings, ${totals.malformedReadings} undecodable spool lines, ${totals.invalidWindows} flagged window values, ${totals.hookErrors} hook append failures.`,
    `Reported for review: ${totals.malformedLines} malformed log lines${run.unreadable === 0 ? "" : `, ${run.unreadable} files or folders that couldn't be read this run (skipped)`}.`,
    ...optionalLine(describeTightened(outcome.permissionsTightened)),
    `Database: ${outcome.databasePath}`,
  ];
}

/**
 * Builds install options from flags and dependencies.
 * @param flags - Parsed command flags.
 * @param deps - Program dependencies.
 * @returns Options for `runInit` or `runUninstall`.
 */
export function toInstallOptions(flags: LocationFlags, deps: CliDeps): InstallOptions {
  return {
    home: deps.home,
    env: {
      CLAUDE_CONFIG_DIR: deps.env["CLAUDE_CONFIG_DIR"],
      NILOMETER_HOME: deps.env["NILOMETER_HOME"],
      XDG_DATA_HOME: deps.env["XDG_DATA_HOME"],
    },
    settingsOverride: flags.settings,
    dataDirOverride: flags.dataDir,
    packageRoot: deps.packageRoot,
    now: deps.now(),
  };
}

/**
 * Turns an `init` outcome into output lines and an exit code.
 * @param outcome - Result of `runInit`.
 * @returns Lines for stdout and the process exit code.
 */
export function describeInit(outcome: InitOutcome): { lines: string[]; exitCode: number } {
  const { settingsPath, dataDir, backupPath, wrappedCommand } = outcome;
  switch (outcome.action) {
    case "installed":
      return {
        exitCode: 0,
        lines: [
          `Installed the status line hook in ${settingsPath}.`,
          backupPath === null
            ? "There was no settings file before; it was created."
            : `Backup of the previous settings: ${backupPath}`,
          wrappedCommand === null
            ? "There was no status line command before; the hook shows the model name."
            : `Your status line command still runs, unchanged: ${wrappedCommand}`,
          `Status line readings are recorded in ${dataDir}.`,
          TERMINAL_ONLY_NOTE,
        ],
      };
    case "updated":
      return {
        exitCode: 0,
        lines: [
          `Updated the hook command in ${settingsPath}: the hook's location had changed.`,
          `Backup of the previous settings: ${backupPath ?? "none"}`,
        ],
      };
    case "already-installed":
      return {
        exitCode: 0,
        lines: outcome.hookRefreshed
          ? [
              `The hook is already installed in ${settingsPath}.`,
              // Pulling a new version leaves the settings command right but the installed copy old.
              `The hook script in ${dataDir} was updated to this version's.`,
            ]
          : [`The hook is already installed in ${settingsPath}. Nothing was changed.`],
      };
    case "refused-unsupported":
      return {
        exitCode: 1,
        lines: [
          `statusLine in ${settingsPath} is not a command entry, so it was left unchanged.`,
          "Only command status lines can be wrapped.",
        ],
      };
    case "refused-other-install":
      return {
        exitCode: 1,
        lines: [
          `The hook in ${settingsPath} was installed with a different data directory than ${dataDir}.`,
          "Nothing was changed. Run uninstall with the original --data-dir first.",
        ],
      };
  }
}

/**
 * Turns an `uninstall` outcome into output lines and an exit code.
 * @param outcome - Result of `runUninstall`.
 * @returns Lines for stdout and the process exit code.
 */
export function describeUninstall(outcome: UninstallOutcome): {
  lines: string[];
  exitCode: number;
} {
  const { settingsPath, dataDir, backupPath, recordMissing, restoredCommand } = outcome;
  const kept = `Recorded data in ${dataDir} was kept.`;
  // The command comes from the install record on disk, so show what's going back in (D-050).
  const restored =
    restoredCommand === null ? [] : [`Status line command restored: ${restoredCommand}`];
  switch (outcome.action) {
    case "restored":
      return {
        exitCode: 0,
        lines: [
          recordMissing
            ? `Removed the hook from ${settingsPath}. No install record was found, so no earlier status line could be restored.`
            : `Removed the hook from ${settingsPath} and restored the earlier status line setting.`,
          ...restored,
          `Backup of the settings before this change: ${backupPath ?? "none"}`,
          kept,
        ],
      };
    case "removed-settings-file":
      return {
        exitCode: 0,
        lines: [
          `Removed ${settingsPath}: init had created it and it held nothing else.`,
          `Backup of the removed file: ${backupPath ?? "none"}`,
          kept,
        ],
      };
    case "not-installed":
      return {
        exitCode: 0,
        lines: [`The hook is not installed in ${settingsPath}. Nothing was changed.`],
      };
    case "replaced-by-user":
      return {
        exitCode: 0,
        lines: [
          `statusLine in ${settingsPath} is no longer the hook; it was changed after install.`,
          "It was left unchanged.",
        ],
      };
  }
}

/**
 * Tells a known, safe-to-report error (bad input or environment) from a bug.
 * @param error - Anything thrown.
 * @returns True for a `SettingsError`, `InstallRecordError`, `DiscoveryError`, `PriceTableError`,
 *   `PlanPriceError`, `NoDatabaseError`, or `UnknownMetricError`.
 */
export function isReportedError(error: unknown): error is Error {
  return (
    error instanceof SettingsError ||
    error instanceof InstallRecordError ||
    error instanceof DiscoveryError ||
    error instanceof PriceTableError ||
    error instanceof PlanPriceError ||
    error instanceof NoDatabaseError ||
    error instanceof UnknownMetricError
  );
}

/**
 * Describes a backfill that failed after `init` had already installed the hook.
 * @param error - The reported error from the ingest.
 * @returns Lines for stderr. They never say "Nothing was changed": the settings file was.
 */
export function describeBackfillFailure(error: Error): string[] {
  return [
    `Session logs weren't imported: ${error.message}.`,
    "The hook is installed. Fix that, then run `nilometer ingest`.",
  ];
}

/**
 * Runs an operation and converts known, safe-to-report errors into an exit code.
 * @param deps - Program dependencies, for error output.
 * @param operation - Returns stdout lines, an exit code, and optionally stderr lines printed after them.
 * @returns The exit code: the operation's, or 1 for a reported error.
 * @throws {unknown} Any error {@link isReportedError} doesn't recognize: those are bugs, and hiding
 *   their stack would hide the bug.
 */
export function report(
  deps: CliDeps,
  operation: () => { lines: string[]; exitCode: number; errors?: string[] },
): number {
  try {
    const { lines, exitCode, errors = [] } = operation();
    lines.forEach((line) => {
      deps.print(line);
    });
    errors.forEach((line) => {
      deps.printError(line);
    });
    return exitCode;
  } catch (error) {
    if (isReportedError(error)) {
      deps.printError(`${error.message}. Nothing was changed.`);
      return 1;
    }
    throw error;
  }
}

/**
 * Builds the command-line program.
 * @param deps - Program dependencies.
 * @param setExitCode - Receives the exit code chosen by the command that ran.
 * @returns A commander program that never calls `process.exit` itself.
 */
export function buildProgram(deps: CliDeps, setExitCode: (code: number) => void): Command {
  const program = new Command("nilometer")
    .description("Reports the observed cost of a Claude subscription.")
    // Tests and embedding need errors as exceptions, not an exiting process.
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        deps.print(text.replace(/\n$/, ""));
      },
      writeErr: (text) => {
        deps.printError(text.replace(/\n$/, ""));
      },
    });

  program
    .command("init")
    .description(
      "Register the status line hook in Claude Code's settings, keeping any existing status line, then backfill from session logs.",
    )
    .option("--settings <path>", "settings file to change (default: ~/.claude/settings.json)")
    .option("--data-dir <path>", "where readings are recorded (default: ~/.local/share/nilometer)")
    .action((flags: LocationFlags) => {
      setExitCode(
        report(deps, () => {
          const described = describeInit(runInit(toInstallOptions(flags, deps)));
          if (described.exitCode !== 0) {
            return described;
          }
          // Backfill right away: session logs are deleted after 30 days, so waiting loses history.
          try {
            const backfill = runIngestCommand(toIngestOptions({ dataDir: flags.dataDir }, deps));
            return {
              exitCode: 0,
              lines: [
                ...described.lines,
                "Backfill from session logs:",
                ...describeIngest(backfill),
              ],
            };
          } catch (error) {
            // The hook is already installed, so report()'s "Nothing was changed" would be false.
            // Show what init did, then why the backfill didn't run; exit 1 because it didn't finish.
            if (!isReportedError(error)) {
              throw error;
            }
            return { exitCode: 1, lines: described.lines, errors: describeBackfillFailure(error) };
          }
        }),
      );
    });

  program
    .command("ingest")
    .description("Read new session log lines and status line readings into the database.")
    .option("--data-dir <path>", "data directory holding the database and spool")
    .option("--full", "reread every file from the start instead of resuming")
    .option("--json", "print the outcome as JSON on stdout")
    .action((flags: IngestFlags) => {
      setExitCode(
        report(deps, () => {
          const outcome = runIngestCommand(toIngestOptions(flags, deps));
          return {
            exitCode: 0,
            lines:
              flags.json === true ? [JSON.stringify(outcome, null, 2)] : describeIngest(outcome),
          };
        }),
      );
    });

  program
    .command("report")
    .description(
      "Print what was observed, then projections in a separate section, from the database. Run ingest first for the latest data.",
    )
    .option("--data-dir <path>", "data directory holding the database")
    .option("--json", "print unrounded rows and the report's labels as JSON")
    .option(
      "--save",
      "also save a dated copy (text and JSON) in the data directory's reports folder",
    )
    .action((flags: ReportFlags) => {
      setExitCode(
        report(deps, () => {
          const input = loadReport(
            { ...toPlanDatabaseOptions(flags, deps), timeZone: deps.timeZone },
            (tightened) => {
              noteTightened(deps, tightened);
            },
          );
          const printed =
            flags.json === true ? JSON.stringify(reportJson(input), null, 2) : renderReport(input);
          if (flags.save !== true) {
            return { exitCode: 0, lines: [printed] };
          }
          const saved = saveReport(dirname(input.databasePath), input, deps.now());
          const note = `Saved: ${displayPath(saved.textPath, deps.home)} and ${displayPath(saved.jsonPath, deps.home)}`;
          if (flags.json === true) {
            // stdout must stay pure JSON for tools reading it.
            deps.printError(note);
            return { exitCode: 0, lines: [printed] };
          }
          return { exitCode: 0, lines: [printed, "", note] };
        }),
      );
    });

  program
    .command("explain <metric>")
    .description(
      `List the events behind a number in the report, with where each was read from, and re-add them. Metrics: ${METRIC_NAMES.join(", ")}.`,
    )
    .option("--data-dir <path>", "data directory holding the database")
    .option("--all", `list every event, not only the first ${EXPLAIN_EVENT_LIMIT} per number`)
    .action((metric: string, flags: ExplainFlags) => {
      setExitCode(
        report(deps, () => {
          const options = toPlanDatabaseOptions(flags, deps);
          // An unknown name fails before the database is opened.
          if (!(METRIC_NAMES as readonly string[]).includes(metric)) {
            throw new UnknownMetricError(metric);
          }
          const explanation = withReportDatabase(
            options,
            (db) => explain(db, metric),
            (tightened) => {
              noteTightened(deps, tightened);
            },
          );
          return {
            exitCode: 0,
            lines: renderExplanation(
              explanation,
              deps.timeZone,
              deps.home,
              flags.all === true ? Number.POSITIVE_INFINITY : EXPLAIN_EVENT_LIMIT,
            ),
          };
        }),
      );
    });

  const planPrice = program
    .command("plan-price")
    .description("Enter or list the plan's USD list price, shown beside API list price.");

  planPrice
    .command("set <month> <usd>")
    .description(
      "Record the plan's USD list price per month from <month> (YYYY-MM) on. Re-entering a month replaces it.",
    )
    .requiredOption("--name <plan>", "the plan's name")
    .option("--data-dir <path>", "data directory holding the database")
    .action((month: string, usd: string, flags: PlanPriceFlags) => {
      setExitCode(
        report(deps, () => {
          // Validate before opening the database, so a typo creates nothing.
          const entry = validatePlanPrice(month, usd, flags.name ?? "");
          const { databasePath, result, tightened } = withPlanDatabase(
            toPlanDatabaseOptions(flags, deps),
            (db) => setPlanPrice(db, entry, deps.now),
          );
          noteTightened(deps, tightened);
          return { exitCode: 0, lines: describePlanPriceSet(entry, result, databasePath) };
        }),
      );
    });

  planPrice
    .command("list")
    .description("List the entered plan prices.")
    .option("--data-dir <path>", "data directory holding the database")
    .action((flags: PlanPriceFlags) => {
      setExitCode(
        report(deps, () => {
          const { result, tightened } = withPlanDatabase(
            toPlanDatabaseOptions(flags, deps),
            listPlanPrices,
          );
          noteTightened(deps, tightened);
          return { exitCode: 0, lines: describePlanPriceList(result) };
        }),
      );
    });

  program
    .command("uninstall")
    .description(
      "Remove the hook and restore the status line setting it replaced. Recorded data is kept.",
    )
    .option("--settings <path>", "settings file to change, if no install record names it")
    .option("--data-dir <path>", "data directory holding the install record")
    .action((flags: LocationFlags) => {
      setExitCode(
        report(deps, () => describeUninstall(runUninstall(toInstallOptions(flags, deps)))),
      );
    });

  return program;
}

/**
 * Parses arguments and runs the chosen command.
 * @param argv - User arguments, without the node binary and script path.
 * @param deps - Program dependencies.
 * @returns The process exit code.
 * @throws {unknown} Errors from commands that aren't reportable (see {@link report}).
 */
export function runCli(argv: readonly string[], deps: CliDeps): number {
  let exitCode = 0;
  const program = buildProgram(deps, (code) => {
    exitCode = code;
  });
  // With no command, show help rather than doing nothing silently.
  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }
  try {
    program.parse([...argv], { from: "user" });
  } catch (error) {
    // commander signals --help and --version as errors with exit code 0 under exitOverride.
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    throw error;
  }
  return exitCode;
}
