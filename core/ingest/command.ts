/**
 * @file The `ingest` operation behind the CLI command and `init`'s backfill (docs/development.md P4.8).
 *
 * One call: open the database in the data directory, read new session-log lines and spool lines,
 * bring derived tables and repository attribution up to date, and summarize what's stored. The
 * summary counts come from SQL over the stored data, so a second run reports the same totals.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { openDatabase } from "../db/database.js";
import { resolveDataDir } from "../install/locations.js";
import { securePrivateDataDir } from "../install/private-files.js";
import { loadPriceTable, syncPrices } from "../pricing/prices.js";
import { resolveRepositories } from "./attribution.js";
import { ensureDerived } from "./derive.js";
import { resolveRoots } from "./discover.js";
import { type IngestSummary, ingestLogs } from "./ingest.js";

/** File name of the database inside the data directory. */
export const DATABASE_FILE = "usage.db";

/** File name of the hook's error log inside the data directory (hooks/statusline.sh). */
export const HOOK_ERRORS_FILE = "hook-errors.log";

/** Inputs to {@link runIngestCommand}. */
export interface IngestCommandOptions {
  /** The user's home directory. */
  readonly home: string;
  /** Environment variables consulted for log roots and the data directory. */
  readonly env: {
    readonly CLAUDE_CONFIG_DIR?: string | undefined;
    readonly XDG_CONFIG_HOME?: string | undefined;
    readonly NILOMETER_HOME?: string | undefined;
    readonly XDG_DATA_HOME?: string | undefined;
  };
  /** `--data-dir` flag value, if given. */
  readonly dataDirOverride?: string | undefined;
  /** Reread every file from the start (`--full`). */
  readonly full: boolean;
  /** Package root containing `core/schema/`. */
  readonly packageRoot: string;
  /** Clock. */
  readonly now: () => Date;
}

/** Totals over everything stored so far. */
export interface StoredTotals {
  /** Distinct API responses after dedup, plus unkeyed request lines. */
  readonly requests: number;
  /** Request lines with neither message.id nor requestId. */
  readonly unkeyedRequests: number;
  /** Limit-hit events from logs. */
  readonly limitHits: number;
  /** API error, synthetic, and retry-notice events. */
  readonly otherEvents: number;
  /** Log lines that aren't valid JSON objects. */
  readonly malformedLines: number;
  /** Status line readings decoded from the spool. */
  readonly statusReadings: number;
  /** Spool lines that failed to decode (malformed line, encoding, or payload). */
  readonly malformedReadings: number;
  /** Rate-limit window values flagged as invalid or unknown. */
  readonly invalidWindows: number;
  /** Lines in the hook's error log (failed spool appends). */
  readonly hookErrors: number;
  /** Earliest request timestamp stored, UTC, or null when there are none. */
  readonly firstRequestUtc: string | null;
  /** Latest request timestamp stored, UTC, or null when there are none. */
  readonly lastRequestUtc: string | null;
}

/** Result of one `ingest`. */
export interface IngestCommandOutcome {
  /** Database file used. */
  readonly databasePath: string;
  /** Log roots read, in order. */
  readonly roots: readonly string[];
  /** What this run read and stored. */
  readonly run: IngestSummary;
  /** Raw lines derived this run, and whether a parser-version rebuild happened. */
  readonly derived: { readonly lines: number; readonly rebuilt: boolean };
  /** Working directories resolved to repositories this run. */
  readonly repositoriesResolved: number;
  /** Totals over everything stored. */
  readonly totals: StoredTotals;
  /** Data paths this run made owner-only because other accounts could read them (D-043). */
  readonly permissionsTightened: readonly string[];
}

/**
 * Counts lines in the hook's error log.
 * @param dataDir - The data directory.
 * @returns Number of non-empty lines; 0 when the log doesn't exist.
 */
export function countHookErrors(dataDir: string): number {
  const path = join(dataDir, HOOK_ERRORS_FILE);
  if (!existsSync(path)) {
    return 0;
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
}

/**
 * Runs one ingest and summarizes the stored data.
 * @param options - Locations, environment, mode, and clock.
 * @returns Paths, this run's counts, and totals over everything stored.
 * @throws {import("./discover.js").DiscoveryError} If `CLAUDE_CONFIG_DIR` names no usable directory.
 * @throws {import("../pricing/prices.js").PriceTableError} If `core/pricing/prices.json` is invalid.
 * @throws {Error} Whatever opening the database or reading a file throws.
 */
export function runIngestCommand(options: IngestCommandOptions): IngestCommandOutcome {
  const dataDir = resolveDataDir({
    home: options.home,
    env: options.env,
    override: options.dataDirOverride,
  });
  const roots = resolveRoots(options.env, options.home);
  // Load prices before opening the database, so an invalid price file fails before anything is written.
  const prices = loadPriceTable(join(options.packageRoot, "core", "pricing", "prices.json"));
  // Before anything is read or written: the data directory holds copies of session content (D-043).
  const permissionsTightened = securePrivateDataDir(dataDir);
  const databasePath = join(dataDir, DATABASE_FILE);
  const db = openDatabase(databasePath, join(options.packageRoot, "core", "schema"));
  try {
    const run = ingestLogs(db, {
      roots,
      mode: options.full ? "full" : "incremental",
      now: options.now,
      spoolDir: dataDir,
    });
    syncPrices(db, prices);
    const derived = ensureDerived(db);
    const repositoriesResolved = resolveRepositories(db, options.now);
    const row = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM requests_dedup) AS requests,
           (SELECT COUNT(*) FROM requests WHERE dedup_key IS NULL) AS unkeyedRequests,
           (SELECT COUNT(*) FROM events WHERE class = 'limit_hit') AS limitHits,
           (SELECT COUNT(*) FROM events WHERE class <> 'limit_hit') AS otherEvents,
           (SELECT COUNT(*) FROM parsed_lines WHERE class = 'malformed') AS malformedLines,
           (SELECT COUNT(*) FROM status_readings WHERE status = 'ok') AS statusReadings,
           (SELECT COUNT(*) FROM status_readings WHERE status <> 'ok') AS malformedReadings,
           (SELECT COUNT(*) FROM rate_limit_windows WHERE validity <> 'valid') AS invalidWindows,
           (SELECT MIN(timestamp_utc) FROM requests_dedup) AS firstRequestUtc,
           (SELECT MAX(timestamp_utc) FROM requests_dedup) AS lastRequestUtc`,
      )
      .get() as Omit<StoredTotals, "hookErrors">;
    return {
      databasePath,
      roots,
      run,
      derived: { lines: derived.derived, rebuilt: derived.rebuilt },
      repositoriesResolved,
      totals: { ...row, hookErrors: countHookErrors(dataDir) },
      permissionsTightened,
    };
  } finally {
    db.close();
  }
}
