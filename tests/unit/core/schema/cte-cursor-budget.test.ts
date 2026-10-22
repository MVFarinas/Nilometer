/**
 * @file Every view prepares inside SQLite 3.54's CTE cursor limit, with room to spare (D-094, step G5.2).
 *
 * SQLite 3.54.0 refuses a statement once a CTE's cursor number passes SQLITE_LIMIT_EXPR_DEPTH, with
 * "VIEWs and/or subqueries nested too deep". Node 26 bundles 3.54.0, and two views failed there before
 * migration 031. The test lowers that limit to 80% of its 1,000 default and prepares every view, on
 * whatever SQLite is running. It runs everywhere, as the audit requires (docs/development.md § Audits),
 * but guards the cursor margin only on 3.54 or later, where the limit also caps CTE cursors: there it
 * fails a view grown within 20% of the real limit, before Node 26 users see it. On 3.53 (Node 24) it
 * guards expression depth alone. CI runs it under Node 26 (D-094).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { type Db, openDatabase } from "../../../../core/db/database.js";

/** Repository root. */
const ROOT = join(import.meta.dirname, "../../../..");

/** The share of SQLite's 1,000 default that every view must fit inside. */
const BUDGET = 800;

/**
 * The part of a `node:sqlite` database that sets SQLite's limits. Node 24.21 has it at runtime, but the
 * pinned `@types/node` predates it.
 */
interface WithLimits {
  /** SQLite's run-time limits, by name. */
  limits: { exprDepth: number };
}

/**
 * Lists the views that don't prepare.
 * @param db - The database.
 * @param views - View names.
 * @returns The ones whose `SELECT *` throws.
 */
function failing(db: Db, views: readonly string[]): string[] {
  return views.filter((view) => {
    try {
      db.prepare(`SELECT * FROM ${view}`);
      return false;
    } catch {
      return true;
    }
  });
}

describe("the CTE cursor budget (D-094)", () => {
  const db = openDatabase(":memory:", join(ROOT, "core/schema"));
  const views = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);

  it("prepares every view at SQLite's default limits", () => {
    expect(failing(db, views)).toEqual([]);
  });

  it(`prepares every view with the expression-depth limit at ${BUDGET}, which caps CTE cursors on SQLite 3.54+`, () => {
    const { limits } = db as unknown as WithLimits;
    limits.exprDepth = BUDGET;
    try {
      expect(failing(db, views)).toEqual([]);
    } finally {
      limits.exprDepth = 1000;
    }
  });
});
