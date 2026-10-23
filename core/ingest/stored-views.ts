/**
 * @file Stored copies of the two views every report statement is built on (D-096, step G6.1).
 *
 * `requests_dedup` and `window_readings` are tables filled from `requests_dedup_computed` and
 * `window_readings_computed`, which keep the definitions the views had. Recomputing them in each of
 * the report's statements took the report and page to 45-50 s on real data. Their inputs are written
 * only by ingest, so ingest refreshes the tables after deriving, and only when an input changed.
 * The computed views stay the source of truth: a test fails if a table ever differs from its view.
 */
import type { Db } from "../db/database.js";
import { transaction } from "../db/database.js";

/** Each stored table and the view whose rows it holds. */
export const STORED_VIEWS = [
  { table: "requests_dedup", view: "requests_dedup_computed" },
  { table: "window_readings", view: "window_readings_computed" },
] as const;

/** Where the inputs' signature from the last refresh is kept, in `derive_meta`. */
const SIGNATURE_KEY = "stored_views_input";

/** Tables the computed views read, each written only by ingest. */
const INPUT_TABLES = [
  "raw_lines",
  "parsed_lines",
  "requests",
  "status_readings",
  "rate_limit_windows",
] as const;

/**
 * Describes the computed views' inputs cheaply enough to check on every ingest: each input table's
 * row count and highest rowid, and every source file's root and path (requests_dedup carries them).
 * Rows in those tables are only inserted, or all deleted and derived again, which a rebuild forces
 * a refresh for anyway; a path changes only when Windows separators are normalized.
 * @param db - Open, migrated database.
 * @returns A string that changes whenever an input does.
 */
export function inputSignature(db: Db): string {
  const counts = INPUT_TABLES.map((table) => {
    const row = db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS top FROM ${table}`)
      .get() as { n: number; top: number };
    return `${table}:${row.n}:${row.top}`;
  });
  const paths = db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(group_concat(id || '|' || root || '|' || relative_path, '\n'), '') AS list FROM (SELECT id, root, relative_path FROM source_files ORDER BY id)",
    )
    .get() as { n: number; list: string };
  return [...counts, `source_files:${paths.n}:${paths.list}`].join("\n");
}

/**
 * Refills each stored table from its view when an input changed since the last refresh.
 * @param db - Open, migrated database.
 * @param force - Refill even if the inputs look unchanged (after a full rebuild of derived rows).
 * @returns Whether the tables were refilled.
 */
export function refreshStoredViews(db: Db, force = false): boolean {
  const signature = inputSignature(db);
  const stored = db.prepare("SELECT value FROM derive_meta WHERE key = ?").get(SIGNATURE_KEY) as
    { value: string } | undefined;
  if (!force && stored?.value === signature) {
    return false;
  }
  transaction(db, () => {
    for (const { table, view } of STORED_VIEWS) {
      // Named columns, in the table's order, so the copy can't depend on the view's column order.
      const columns = (
        db.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(table) as {
          name: string;
        }[]
      )
        .map((c) => c.name)
        .join(", ");
      db.exec(`DELETE FROM ${table}`);
      db.exec(`INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${view}`);
    }
    db.prepare(
      "INSERT INTO derive_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run(SIGNATURE_KEY, signature);
  });
  // Table statistics for the query planner: on real data they halved the page's queries again, for
  // about 0.4 s here. They change how a query runs, never what it returns.
  db.exec("ANALYZE");
  return true;
}
