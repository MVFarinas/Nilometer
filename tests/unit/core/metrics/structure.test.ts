/**
 * @file Structural checks on metric views (docs/development.md P6.4, README principle 2, add-metric §1).
 *
 * Observations and projections must stay structurally separate: no observed view may read, even
 * indirectly, from a projection or from cost data. Every view is either a named helper or carries
 * the obs_ or proj_ prefix, so a new metric can't slip in unclassified.
 */
import { describe, expect, it } from "vitest";

import { ingest } from "./helpers.js";

/** Views that aren't metrics themselves: building blocks shared by metric views. */
const HELPER_VIEWS = new Set([
  "requests_dedup",
  "request_repositories",
  "request_costs",
  "unpriced_requests",
  "source_coverage",
  "logged_limit_hits",
  "status_limit_groups",
  "window_readings",
  "window_instances",
  "window_reading_pairs",
]);

/** Names an observed view must never depend on: cost data and user-entered plan prices. */
const PROJECTION_INPUTS = ["request_costs", "unpriced_requests", "prices", "plan_prices"];

/**
 * Reads every view and table name with its SQL.
 * @returns Views and the names of all tables and views.
 */
function schema(): { views: Map<string, string>; names: string[] } {
  const db = ingest({});
  const objects = db
    .prepare("SELECT name, type, sql FROM sqlite_master WHERE type IN ('view', 'table')")
    .all() as { name: string; type: string; sql: string }[];
  return {
    views: new Map(objects.filter((o) => o.type === "view").map((o) => [o.name, o.sql])),
    names: objects.map((o) => o.name),
  };
}

/**
 * Lists the tables and views a view's SQL names. Whole-word matching also matches a column alias
 * spelled like a view (proj_api_list_price has a column named unpriced_requests), which errs toward
 * reporting a leak, never toward hiding one.
 * @param sql - The view definition.
 * @param names - Every table and view name.
 * @returns Names referenced as whole words.
 */
function references(sql: string, names: readonly string[]): string[] {
  return names.filter((name) => new RegExp(`\\b${name}\\b`).test(sql));
}

/**
 * Collects every table and view a view depends on, directly or through other views.
 * @param view - The starting view.
 * @param views - All view definitions.
 * @param names - Every table and view name.
 * @returns The transitive dependency names.
 */
function dependencies(
  view: string,
  views: Map<string, string>,
  names: readonly string[],
): Set<string> {
  const seen = new Set<string>();
  const pending = [view];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const name of references(views.get(current) ?? "", names)) {
      if (name !== current && !seen.has(name)) {
        seen.add(name);
        if (views.has(name)) {
          pending.push(name);
        }
      }
    }
  }
  return seen;
}

describe("metric view structure", () => {
  it("classifies every view as a helper, an observation, or a projection", () => {
    const { views } = schema();
    const unclassified = [...views.keys()].filter(
      (name) => !HELPER_VIEWS.has(name) && !name.startsWith("obs_") && !name.startsWith("proj_"),
    );
    expect(unclassified).toEqual([]);
    expect([...views.keys()].filter((name) => name.startsWith("proj_")).sort()).toEqual([
      "proj_api_list_price",
      "proj_burn_rate",
    ]);
  });

  it("keeps every observed view free of projections and cost data, transitively", () => {
    const { views, names } = schema();
    const leaks = [...views.keys()]
      .filter((name) => name.startsWith("obs_"))
      .flatMap((name) =>
        [...dependencies(name, views, names)]
          .filter((dep) => dep.startsWith("proj_") || PROJECTION_INPUTS.includes(dep))
          .map((dep) => `${name} → ${dep}`),
      );
    expect(leaks).toEqual([]);
  });

  it("finds a dependency through an intermediate view", () => {
    const views = new Map([
      ["obs_a", "SELECT * FROM helper_b"],
      ["helper_b", "SELECT * FROM proj_c"],
      ["proj_c", "SELECT 1"],
    ]);
    expect([...dependencies("obs_a", views, ["obs_a", "helper_b", "proj_c"])]).toEqual([
      "helper_b",
      "proj_c",
    ]);
  });
});
