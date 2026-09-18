/**
 * @file Plan prices the user enters, shown beside API list price (D-027).
 *
 * Nothing on disk records which plan the user pays for or its price, so the user enters it with
 * `plan-price set`. One row per month from which a price applies; entering the same month again
 * replaces that row. These rows are user data: rebuilds never touch them, and they never belong in
 * the repository.
 */
import { join } from "node:path";

import { type Db, openDatabase } from "../db/database.js";
import { DATABASE_FILE } from "../ingest/command.js";
import { resolveDataDir } from "../install/locations.js";
import { securePrivateDataDir } from "../install/private-files.js";

/** A plan price entry. */
export interface PlanPriceEntry {
  /** Local calendar month from which the price applies, `YYYY-MM`. */
  readonly month: string;
  /** The plan's name as the user writes it. */
  readonly planName: string;
  /** The plan's USD list price per month. */
  readonly usdPerMonth: number;
}

/** A stored plan price. */
export interface PlanPriceRow extends PlanPriceEntry {
  /** ISO-8601 UTC time the row was written. */
  readonly enteredAt: string;
}

/** An entry that can't be stored; its message names the field. */
export class PlanPriceError extends Error {
  /**
   * Creates the error.
   * @param message - What's wrong with the entry.
   */
  constructor(message: string) {
    super(message);
    this.name = "PlanPriceError";
  }
}

/** `YYYY-MM` with a real month. */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Longest accepted plan name, so a pasted paragraph isn't stored as a name. */
export const MAX_PLAN_NAME_LENGTH = 100;

/**
 * Validates an entry from user input.
 * @param month - `YYYY-MM`.
 * @param usd - Price text or number, e.g. `"200"` or `"17.50"`.
 * @param planName - Plan name.
 * @returns The entry with the name trimmed and the price as a number.
 * @throws {PlanPriceError} If the month isn't `YYYY-MM`, the price isn't a finite non-negative
 *   decimal number, or the name is empty or longer than {@link MAX_PLAN_NAME_LENGTH}.
 */
export function validatePlanPrice(
  month: string,
  usd: string | number,
  planName: string,
): PlanPriceEntry {
  if (!MONTH.test(month)) {
    throw new PlanPriceError(`month must be YYYY-MM, got "${month}"`);
  }
  // Plain decimals only: "1e3", "0x10", and "" are numbers to Number() but not prices anyone types.
  const text = String(usd).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new PlanPriceError(
      `price must be a non-negative USD amount like 200 or 17.50, got "${text}"`,
    );
  }
  const name = planName.trim();
  if (name === "" || name.length > MAX_PLAN_NAME_LENGTH) {
    throw new PlanPriceError(`plan name must be 1 to ${MAX_PLAN_NAME_LENGTH} characters`);
  }
  return { month, planName: name, usdPerMonth: Number(text) };
}

/**
 * Stores an entry, replacing any row for the same month.
 * @param db - Open, migrated database.
 * @param entry - A validated entry.
 * @param now - Clock for `entered_at`.
 * @returns The row it replaced, or null when the month had none.
 */
export function setPlanPrice(db: Db, entry: PlanPriceEntry, now: () => Date): PlanPriceRow | null {
  return db.transaction(() => {
    const previous = readRow(db, entry.month);
    db.prepare(
      `INSERT INTO plan_prices (effective_month, plan_name, usd_per_month, entered_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (effective_month) DO UPDATE SET
         plan_name = excluded.plan_name, usd_per_month = excluded.usd_per_month, entered_at = excluded.entered_at`,
    ).run(entry.month, entry.planName, entry.usdPerMonth, now().toISOString());
    return previous;
  })();
}

/**
 * Lists every stored plan price, oldest month first.
 * @param db - Open, migrated database.
 * @returns The rows.
 */
export function listPlanPrices(db: Db): PlanPriceRow[] {
  return (
    db
      .prepare(
        "SELECT effective_month, plan_name, usd_per_month, entered_at FROM plan_prices ORDER BY effective_month",
      )
      .all() as StoredRow[]
  ).map(toRow);
}

/** A `plan_prices` row as SQLite returns it. */
interface StoredRow {
  /** `effective_month` column. */
  readonly effective_month: string;
  /** `plan_name` column. */
  readonly plan_name: string;
  /** `usd_per_month` column. */
  readonly usd_per_month: number;
  /** `entered_at` column. */
  readonly entered_at: string;
}

/**
 * Converts a stored row to its API shape.
 * @param row - The row from SQLite.
 * @returns The plan price.
 */
function toRow(row: StoredRow): PlanPriceRow {
  return {
    month: row.effective_month,
    planName: row.plan_name,
    usdPerMonth: row.usd_per_month,
    enteredAt: row.entered_at,
  };
}

/**
 * Reads one month's row.
 * @param db - Open, migrated database.
 * @param month - `YYYY-MM`.
 * @returns The row, or null.
 */
function readRow(db: Db, month: string): PlanPriceRow | null {
  const row = db
    .prepare(
      "SELECT effective_month, plan_name, usd_per_month, entered_at FROM plan_prices WHERE effective_month = ?",
    )
    .get(month) as StoredRow | undefined;
  return row === undefined ? null : toRow(row);
}

/** Inputs for opening the database a plan-price command works on. */
export interface PlanDatabaseOptions {
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
}

/**
 * Opens the data directory's database, runs an operation on it, and closes it.
 * @param options - Where the database lives.
 * @param use - The operation.
 * @returns The database path, the operation's result, and any data paths made owner-only.
 */
export function withPlanDatabase<T>(
  options: PlanDatabaseOptions,
  use: (db: Db) => T,
): { databasePath: string; result: T; tightened: readonly string[] } {
  const dataDir = resolveDataDir({
    home: options.home,
    env: options.env,
    override: options.dataDirOverride,
  });
  // A plan price can be entered before init or the first ingest has created the directory; either
  // way the directory and its files end up owner-only (D-043).
  const tightened = securePrivateDataDir(dataDir);
  const databasePath = join(dataDir, DATABASE_FILE);
  const db = openDatabase(databasePath, join(options.packageRoot, "core", "schema"));
  try {
    return { databasePath, result: use(db), tightened };
  } finally {
    db.close();
  }
}
