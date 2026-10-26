/**
 * @file One transaction, nested as a savepoint (D-093). Its own module so `stored-views.ts` can use it
 * while `database.ts` calls `stored-views.ts` on every open, without the two importing each other.
 */
import type { DatabaseSync } from "node:sqlite";

/**
 * Runs `work` in one transaction: committed when it returns, rolled back when it throws. Inside another
 * transaction it becomes a savepoint, so an inner failure undoes only the inner work, as better-sqlite3's
 * `db.transaction()` did before D-093.
 * @param db - An open database.
 * @param work - The statements to run together.
 * @returns What `work` returns.
 * @throws {Error} Whatever `work` throws, after the rollback.
 */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  const nested = db.isTransaction;
  // A savepoint name only has to be unique among the ones open at once, and nesting is strictly LIFO.
  const begin = nested ? "SAVEPOINT nilometer_nested" : "BEGIN";
  db.exec(begin);
  try {
    const result = work();
    db.exec(nested ? "RELEASE nilometer_nested" : "COMMIT");
    return result;
  } catch (error) {
    if (nested) {
      // ROLLBACK TO keeps the savepoint open, so it's released too, leaving the outer transaction as it was.
      db.exec("ROLLBACK TO nilometer_nested");
      db.exec("RELEASE nilometer_nested");
    } else if (db.isTransaction) {
      // SQLite may already have rolled back on its own (a full disk, an interrupt); rolling back twice errors.
      db.exec("ROLLBACK");
    }
    throw error;
  }
}
