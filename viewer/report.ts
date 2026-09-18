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
    (db, databasePath) => ({
      observed: loadObserved(db),
      projected: loadProjected(db),
      timeZone: options.timeZone,
      lastIngestAt: lastIngestAt(db),
      databasePath,
      home: options.home,
    }),
    onTightened,
  );
}
