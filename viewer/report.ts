/**
 * @file Opening the database and assembling the report's input (docs/development.md P7.1).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { type Db, openDatabase } from "../core/db/database.js";
import { DATABASE_FILE } from "../core/ingest/command.js";
import { resolveDataDir } from "../core/install/locations.js";
import { securePrivateDataDir } from "../core/install/private-files.js";
import { lastIngestAt, loadObserved, loadProjected } from "./queries.js";
import type { ReportInput } from "./render.js";

/** There is no database to report on yet. */
export class NoDatabaseError extends Error {
  /**
   * Creates the error.
   * @param databasePath - The path that doesn't exist.
   */
  constructor(databasePath: string) {
    super(`No database at ${databasePath}; run init or ingest first`);
    this.name = "NoDatabaseError";
  }
}

/** Where to read the report from and how to show times. */
export interface ReportOptions {
  /** The user's home directory. */
  readonly home: string;
  /** Environment variables consulted for the data directory. */
  readonly env: {
    readonly NILOMETER_HOME?: string | undefined;
    readonly XDG_DATA_HOME?: string | undefined;
  };
  /** `--data-dir` flag value, if given. */
  readonly dataDirOverride?: string | undefined;
  /** Package root containing `core/schema/`. */
  readonly packageRoot: string;
  /** IANA zone every time is shown in; month buckets in SQL use the process's zone (D-007). */
  readonly timeZone: string;
}

/** Where the report's database lives. */
export type ReportDatabaseOptions = Omit<ReportOptions, "timeZone">;

/**
 * Opens the data directory's existing database, runs an operation on it, and closes it.
 * @param options - Where the database lives.
 * @param use - The operation.
 * @param onTightened - Called with any data paths made owner-only before reading (D-043).
 * @returns The operation's result.
 * @throws {NoDatabaseError} If the data directory has no database yet. Nothing is created.
 */
export function withReportDatabase<T>(
  options: ReportDatabaseOptions,
  use: (db: Db, databasePath: string) => T,
  onTightened: (tightened: readonly string[]) => void = () => undefined,
): T {
  const databasePath = join(
    resolveDataDir({ home: options.home, env: options.env, override: options.dataDirOverride }),
    DATABASE_FILE,
  );
  // Reading must not create an empty database and then describe it as "no data yet".
  if (!existsSync(databasePath)) {
    throw new NoDatabaseError(databasePath);
  }
  // Even a read tightens: an install from before D-043 may still be readable by other accounts.
  const tightened = securePrivateDataDir(dirname(databasePath));
  if (tightened.length > 0) {
    onTightened(tightened);
  }
  const db = openDatabase(databasePath, join(options.packageRoot, "core", "schema"));
  try {
    return use(db, databasePath);
  } finally {
    db.close();
  }
}

/**
 * Reads everything the report shows from a database that's already open, so a caller can read more
 * from the same connection (the HTML page, D-070) inside one transaction.
 * @param db - The open, migrated database.
 * @param databasePath - Where it lives, carried into the input for the saved copies.
 * @param options - Display zone and home directory.
 * @returns The report input.
 */
export function readReport(db: Db, databasePath: string, options: ReportOptions): ReportInput {
  return {
    observed: loadObserved(db),
    projected: loadProjected(db),
    timeZone: options.timeZone,
    lastIngestAt: lastIngestAt(db),
    databasePath,
    home: options.home,
  };
}

/**
 * Reads everything the report shows.
 * @param options - Data directory and display zone.
 * @param onTightened - Called with any data paths made owner-only before reading (D-043).
 * @returns The report input.
 * @throws {NoDatabaseError} If the data directory has no database yet. Nothing is created.
 */
export function loadReport(
  options: ReportOptions,
  onTightened: (tightened: readonly string[]) => void = () => undefined,
): ReportInput {
  return withReportDatabase(
    options,
    (db, databasePath) => readReport(db, databasePath, options),
    onTightened,
  );
}

/** What the data directory holds, read before anything deletes it (R2.5). */
export interface StoredDataSummary {
  /** Deduplicated requests. */
  readonly requests: number;
  /** Status line readings that decoded. */
  readonly readings: number;
  /** Earliest request timestamp, or null when there are none. */
  readonly firstRequestUtc: string | null;
  /** Latest request timestamp, or null when there are none. */
  readonly lastRequestUtc: string | null;
}

/**
 * Summarizes what is recorded, so a command that deletes it can say what it removed.
 *
 * The same sources `ingest` counts from, so the two agree. Deleting this data is not reversible:
 * it holds copies of session logs Claude Code removes after 30 days, which is the whole reason
 * ingestion copies them (R2.5).
 * @param options - Home, environment, package root, and any `--data-dir` override.
 * @returns The summary, or null when there is no database to read.
 * @throws {unknown} Whatever opening or reading the database throws, other than a missing one.
 */
export function summarizeStoredData(options: ReportDatabaseOptions): StoredDataSummary | null {
  try {
    return withReportDatabase(
      options,
      (db) =>
        db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM requests_dedup) AS requests,
               (SELECT COUNT(*) FROM status_readings WHERE status = 'ok') AS readings,
               (SELECT MIN(timestamp_utc) FROM requests_dedup) AS firstRequestUtc,
               (SELECT MAX(timestamp_utc) FROM requests_dedup) AS lastRequestUtc`,
          )
          .get() as StoredDataSummary,
    );
  } catch (error) {
    // Nothing recorded yet is not a failure: there is simply nothing to describe.
    if (error instanceof NoDatabaseError) {
      return null;
    }
    throw error;
  }
}
