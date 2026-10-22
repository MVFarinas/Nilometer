/**
 * @file Interruptions per plan period (D-075, step G2.2): `plan_periods`, the two tagged event
 * views, and `obs_interruptions_by_plan`.
 *
 * Every expected value is worked out by hand from the scenario below, in UTC (the process zone is
 * fixed to UTC, so SQLite's 'localtime' months are UTC months). Plans entered: Pro from 2026-08,
 * Max 5x from 2026-10.
 *
 * | Line | At (UTC) | Kind | Details | Period |
 * |---|---|---|---|---|
 * | r1 | 2026-07-15 10:00 | request | | before the first plan |
 * | h1 | 2026-07-20 12:00 | limit hit | resets 1pm: lockout 1 h (3,600 s) | before the first plan |
 * | r2 | 2026-08-05 09:00 | request | | Pro |
 * | h2 | 2026-08-31 23:30 | limit hit | resets 2am, Sep 1: 2 h 30 m (9,000 s) | Pro |
 * | h3 | 2026-09-30 23:00 | limit hit | resets 1am, Oct 1: 2 h (7,200 s), ending in Max 5x's months | Pro, where it began |
 * | h4 | 2026-10-02 10:00 | limit hit | resets 11am: 1 h (3,600 s) | Max 5x |
 * | r3 | 2026-10-03 08:00 | request | | Max 5x |
 * | h5 | none | limit hit | no time, so no reset and no lockout | time unknown |
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../../../core/db/database.js";
import { setPlanPrice } from "../../../../core/plans/plan-prices.js";
import { type PlanPeriodRow, loadObserved } from "../../../../viewer/queries.js";
import { planPeriodMonths, planPeriodName, renderObserved } from "../../../../viewer/render.js";
import { IS_WINDOWS } from "../../../setup/platform.js";
import { hit, ingest, request } from "./helpers.js";

/** The zone the process ran in before this file set its own. */
const originalTz = process.env["TZ"];

/**
 * A fixed clock for entered_at.
 * @returns 2026-10-13 00:00 UTC.
 */
const NOW = (): Date => new Date("2026-10-13T00:00:00Z");

/**
 * Builds the scenario in this file's header.
 * @param plans - Whether to enter the two plans.
 * @returns The database.
 */
function scenario(plans: boolean): Db {
  const db = ingest({
    "-p/s.jsonl": [
      request("s", "r1", null, "2026-07-15T10:00:00Z"),
      hit(
        "s",
        "h1",
        null,
        "2026-07-20T12:00:00Z",
        "You've hit your session limit · resets 1pm (UTC)",
      ),
      request("s", "r2", null, "2026-08-05T09:00:00Z"),
      hit(
        "s",
        "h2",
        null,
        "2026-08-31T23:30:00Z",
        "You've hit your session limit · resets 2am (UTC)",
      ),
      hit(
        "s",
        "h3",
        null,
        "2026-09-30T23:00:00Z",
        "You've hit your session limit · resets 1am (UTC)",
      ),
      hit(
        "s",
        "h4",
        null,
        "2026-10-02T10:00:00Z",
        "You've hit your session limit · resets 11am (UTC)",
      ),
      request("s", "r3", null, "2026-10-03T08:00:00Z"),
      hit("s", "h5", null, null, "You've hit your session limit · resets 1pm (UTC)"),
    ],
  });
  if (plans) {
    setPlanPrice(db, { month: "2026-08", planName: "Pro", usdPerMonth: 20 }, NOW);
    setPlanPrice(db, { month: "2026-10", planName: "Max 5x", usdPerMonth: 100 }, NOW);
  }
  return db;
}

/**
 * Reads the per-plan rows in the report's order.
 * @param db - The database.
 * @returns The rows.
 */
function byPlan(db: Db): PlanPeriodRow[] {
  return loadObserved(db).interruptionsByPlan as PlanPeriodRow[];
}

// SQLite's 'localtime' on Windows ignores TZ set while the process runs (D-049), so the months
// here are only fixed where the zone can be set.
describe.skipIf(IS_WINDOWS)("interruptions per plan period (D-075)", () => {
  beforeAll(() => {
    process.env["TZ"] = "UTC";
  });

  afterAll(() => {
    if (originalTz === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = originalTz;
    }
  });

  it("splits hits, lockouts, and elapsed lockout time by the plan in effect", () => {
    const db = scenario(true);
    const rows = byPlan(db);
    expect(
      rows.map((r) => [r.period_kind, r.from_month, r.to_month, r.until_month, r.plan_name]),
    ).toEqual([
      ["none", null, "2026-07", "2026-08", null],
      ["plan", "2026-08", "2026-09", "2026-10", "Pro"],
      ["plan", "2026-10", null, null, "Max 5x"],
      ["unknown", null, null, null, null],
    ]);
    // h1 alone before Pro; h2 and h3 on Pro; h4 on Max 5x; h5 with no time.
    expect(rows.map((r) => [r.hits, r.five_hour_hits, r.lockouts, r.lockout_seconds])).toEqual([
      [1, 1, 1, 3600],
      // h3's lockout ends on 2026-10-01, in Max 5x's months, and stays with Pro, where it began.
      [2, 2, 2, 9000 + 7200],
      [1, 1, 1, 3600],
      // h5's text names the session limit, so it is a 5-hour hit; with no time, it has no reset
      // and no lockout.
      [1, 1, 0, 0],
    ]);
  });

  it("adds up to the totals, so no hit or lockout is lost or counted twice", () => {
    const db = scenario(true);
    const rows = byPlan(db);
    const totals = loadObserved(db);
    expect(rows.reduce((sum, r) => sum + r.hits, 0)).toBe(totals.limitHits.hits);
    expect(rows.reduce((sum, r) => sum + r.lockouts, 0)).toBe(totals.lockout.intervals);
    // 3,600 + 16,200 + 3,600 = 23,400 s.
    expect(rows.reduce((sum, r) => sum + r.lockout_seconds, 0)).toBe(23400);
    expect(totals.lockout.lockout_seconds).toBe(23400);
  });

  it("gives each period the span of the requests and hits inside it (principle 5)", () => {
    const rows = byPlan(scenario(true));
    expect(
      rows.map((r) => [r.covers_from, r.covers_to].map((t) => (t === null ? null : Date.parse(t)))),
    ).toEqual([
      // r1 to h1.
      [Date.parse("2026-07-15T10:00:00Z"), Date.parse("2026-07-20T12:00:00Z")],
      // r2 to h3.
      [Date.parse("2026-08-05T09:00:00Z"), Date.parse("2026-09-30T23:00:00Z")],
      // h4 to r3.
      [Date.parse("2026-10-02T10:00:00Z"), Date.parse("2026-10-03T08:00:00Z")],
      // No time, no span.
      [null, null],
    ]);
  });

  it("names each period and its months as the report shows them", () => {
    const rows = byPlan(scenario(true));
    expect(rows.map((r) => `${planPeriodName(r)} | ${planPeriodMonths(r)}`)).toEqual([
      "no plan entered | before 2026-08",
      "Pro | 2026-08 to 2026-09",
      "Max 5x | 2026-10 onward",
      "time unknown | no time",
    ]);
    // A plan that applies for one month names just that month.
    expect(
      planPeriodMonths({
        period_kind: "plan",
        from_month: "2026-07",
        to_month: "2026-07",
        until_month: "2026-08",
      }),
    ).toBe("2026-07");
  });

  it("prints the table under the interruptions, with each period's span", () => {
    const db = scenario(true);
    const lines = renderObserved(loadObserved(db), "UTC");
    const start = lines.findIndex((line) => line.startsWith("  By plan period:"));
    expect(start).toBeGreaterThan(0);
    expect(lines.slice(start + 1, start + 7)).toEqual([
      // Months is as wide as "2026-08 to 2026-09" (18); counts right-align under "Limit hits" (10,
      // D-090) and durations under their 20-wide header.
      "    Plan             Months              Limit hits  Lockouts  Elapsed lockout time  Covers",
      "    ---------------  ------------------  ----------  --------  --------------------  ------------------------------------",
      "    no plan entered  before 2026-08               1         1               1 h 0 m  2026-07-15 10:00 to 2026-07-20 12:00",
      "    Pro              2026-08 to 2026-09           2         2              4 h 30 m  2026-08-05 09:00 to 2026-09-30 23:00",
      "    Max 5x           2026-10 onward               1         1               1 h 0 m  2026-10-02 10:00 to 2026-10-03 08:00",
      "    time unknown     no time                      1         0                   0 s",
    ]);
  });

  it("has one row of everything, and prints no table, when no plan was entered", () => {
    const db = scenario(false);
    const rows = byPlan(db);
    expect(rows.map((r) => [r.period_kind, r.until_month, r.hits, r.lockouts])).toEqual([
      ["none", null, 4, 4],
      ["unknown", null, 1, 0],
    ]);
    expect(planPeriodMonths(rows[0] as PlanPeriodRow)).toBe("every month");
    expect(renderObserved(loadObserved(db), "UTC").some((l) => l.includes("By plan period"))).toBe(
      false,
    );
  });

  it("leaves out a plan entered for months with no data, and returns no rows for an empty database", () => {
    const db = scenario(true);
    setPlanPrice(db, { month: "2027-01", planName: "Max 20x", usdPerMonth: 200 }, NOW);
    expect(byPlan(db).map((r) => r.plan_name)).not.toContain("Max 20x");
    expect(byPlan(ingest({}))).toEqual([]);
  });

  it("reads plans only through plan_periods, which carries no price", () => {
    const db = scenario(true);
    const columns = (
      db.prepare("SELECT * FROM plan_periods ORDER BY from_month").all() as object[]
    ).map(Object.keys);
    expect(columns[0]).toEqual(["from_month", "until_month", "plan_name"]);
  });
});
