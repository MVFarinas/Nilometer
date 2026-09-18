/**
 * @file Tests for the projection views (docs/development.md P6.4, D-020, D-026, D-027).
 *
 * Expected values were worked out on paper before running any view. Costs use the pricing page
 * rates in core/pricing/prices.json: Sonnet 5 $2 input, $10 output, $2.50 5-minute cache write;
 * Opus 5 $5 input, $25 output (USD per million tokens).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IS_WINDOWS } from "../../../setup/platform.js";

import type { Db } from "../../../../core/db/database.js";
import { setPlanPrice } from "../../../../core/plans/plan-prices.js";
import { type Reading, ingest, now, request, rows } from "./helpers.js";

/**
 * A reading with a full timestamp.
 * @param at - ISO-8601 capture instant.
 * @param window - Window name.
 * @param used - used_percentage.
 * @param resets - ISO-8601 reset instant.
 * @returns The reading.
 */
function reading(at: string, window: string, used: number, resets: string): Reading {
  return { at, session: "s", window, used, resets };
}

describe("proj_burn_rate: hand-computed", () => {
  let db: Db;

  beforeAll(() => {
    db = ingest({}, [
      // Window 10:00 → 15:00; last reading 12:30 at 25%.
      reading("2026-09-03T11:00:00Z", "five_hour", 10, "2026-09-03T15:00:00Z"),
      reading("2026-09-03T12:30:00Z", "five_hour", 25, "2026-09-03T15:00:00Z"),
      // Window 15:00 → 20:00; 40% at 16:00.
      reading("2026-09-03T16:00:00Z", "five_hour", 40, "2026-09-03T20:00:00Z"),
      // Window 20:00 → 01:00; 100% at 21:00.
      reading("2026-09-03T21:00:00Z", "five_hour", 100, "2026-09-04T01:00:00Z"),
      // Window 09-03 00:00 → 09-10 00:00; 0% at 12:00.
      reading("2026-09-03T12:00:00Z", "seven_day", 0, "2026-09-10T00:00:00Z"),
    ]);
  });

  it("projects each window's limit time at its average rate since the window began", () => {
    expect(
      rows(db, "proj_burn_rate", "window, reset_at_utc").map((r) => ({
        reset: r["reset_at_utc"],
        start: r["window_start_utc"],
        rate: r["projected_percentage_points_per_hour"],
        at: r["projected_limit_at_utc"],
        before: r["projected_limit_before_reset"],
        reached: r["limit_reached"],
      })),
    ).toEqual([
      // 25% over 2.5 h = 10 pp/h; 100% after 2.5 h × 100 / 25 = 10 h → 20:00, after the 15:00 reset.
      {
        reset: "2026-09-03T15:00:00.000Z",
        start: "2026-09-03T10:00:00.000Z",
        rate: 10,
        at: "2026-09-03T20:00:00.000Z",
        before: 0,
        reached: 0,
      },
      // 40% over 1 h = 40 pp/h; 100% after 1 h × 100 / 40 = 2.5 h → 17:30, before the 20:00 reset.
      {
        reset: "2026-09-03T20:00:00.000Z",
        start: "2026-09-03T15:00:00.000Z",
        rate: 40,
        at: "2026-09-03T17:30:00.000Z",
        before: 1,
        reached: 0,
      },
      // Already 100%: reached, not projected. 100% over 1 h = 100 pp/h.
      {
        reset: "2026-09-04T01:00:00.000Z",
        start: "2026-09-03T20:00:00.000Z",
        rate: 100,
        at: null,
        before: null,
        reached: 1,
      },
      // 0% over 12 h = 0 pp/h; no limit time can be projected from 0%.
      {
        reset: "2026-09-10T00:00:00.000Z",
        start: "2026-09-03T00:00:00.000Z",
        rate: 0,
        at: null,
        before: null,
        reached: 0,
      },
    ]);
  });

  it("leaves the projection unknown for a reading at the window start", () => {
    const edge = ingest({}, [
      reading("2026-09-05T10:00:00Z", "five_hour", 5, "2026-09-05T15:00:00Z"),
    ]);
    expect(rows(edge, "proj_burn_rate")).toEqual([
      expect.objectContaining({
        projected_percentage_points_per_hour: null,
        projected_limit_at_utc: null,
      }),
    ]);
  });
});

describe("proj_api_list_price: hand-computed, bucketed in America/Chicago", () => {
  let db: Db;
  const originalTz = process.env["TZ"];

  beforeAll(() => {
    // CDT is UTC−5 throughout August to October 2026.
    process.env["TZ"] = "America/Chicago";
    db = ingest({
      "-p/s.jsonl": [
        // 2026-08 local. m1: 1,000,000 × $2 = $2.00.
        request("s", "m1", null, "2026-08-31T12:00:00Z", {
          usage: { input_tokens: 1_000_000, output_tokens: 0 },
        }),
        // 2026-09-01 03:00 UTC is 2026-08-31 22:00 local → 2026-08. m2: 100,000 × $10 = $1.00.
        request("s", "m2", null, "2026-09-01T03:00:00Z", {
          usage: { input_tokens: 0, output_tokens: 100_000 },
        }),
        // 2026-09. m3 Opus 5: 200,000 × $5 + 20,000 × $25 = $1.00 + $0.50 = $1.50.
        request("s", "m3", null, "2026-09-15T12:00:00Z", {
          model: "claude-opus-5",
          usage: { input_tokens: 200_000, output_tokens: 20_000 },
        }),
        // 2026-09. m7: 1,000,000 unsplit cache writes × $2.50 = $2.50, a lower bound.
        request("s", "m7", null, "2026-09-16T00:00:00Z", {
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 },
        }),
        // 2026-09, unpriced model.
        request("s", "m4", null, "2026-09-20T12:00:00Z", { model: "claude-unknown-9" }),
        // 2026-10-01 04:59:59 UTC is 2026-09-30 23:59:59 local → 2026-09, unpriced.
        request("s", "m5", null, "2026-10-01T04:59:59Z", { model: "claude-unknown-9" }),
        // 2026-10-01 05:00:00 UTC is local midnight → 2026-10, the month's only request, unpriced.
        request("s", "m6", null, "2026-10-01T05:00:00Z", { model: "claude-unknown-9" }),
      ],
    });
    setPlanPrice(db, { month: "2026-08", planName: "Plan A", usdPerMonth: 100 }, now);
    setPlanPrice(db, { month: "2026-10", planName: "Plan B", usdPerMonth: 200 }, now);
  });

  afterAll(() => {
    if (originalTz === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = originalTz;
    }
  });

  // SQLite's 'localtime' on Windows ignores TZ set while the process runs, so these fixed-zone
  // expectations can only hold elsewhere. With the machine's own zone, Node and SQLite agree there (D-049).
  it.skipIf(IS_WINDOWS)(
    "sums priced requests per local month beside the plan price in effect",
    () => {
      expect(rows(db, "proj_api_list_price", "month")).toEqual([
        // m1 + m2 = $3.00; both dated before verified_on 2026-09-13.
        {
          month: "2026-08",
          requests: 2,
          priced_requests: 2,
          unpriced_requests: 0,
          lower_bound_requests: 0,
          priced_before_verified_requests: 2,
          verified_on: "2026-09-13",
          api_list_price_usd: 3,
          plan_name: "Plan A",
          plan_usd_per_month: 100,
          covers_from: "2026-08-31T12:00:00.000Z",
          covers_to: "2026-09-01T03:00:00.000Z",
        },
        // m3 + m7 = $1.50 + $2.50 = $4.00; m4 and m5 unpriced; Plan A still in effect.
        {
          month: "2026-09",
          requests: 4,
          priced_requests: 2,
          unpriced_requests: 2,
          lower_bound_requests: 1,
          priced_before_verified_requests: 0,
          verified_on: "2026-09-13",
          api_list_price_usd: 4,
          plan_name: "Plan A",
          plan_usd_per_month: 100,
          covers_from: "2026-09-15T12:00:00.000Z",
          covers_to: "2026-10-01T04:59:59.000Z",
        },
        // Only an unpriced request: cost unknown, not $0.
        {
          month: "2026-10",
          requests: 1,
          priced_requests: 0,
          unpriced_requests: 1,
          lower_bound_requests: 0,
          priced_before_verified_requests: 0,
          verified_on: null,
          api_list_price_usd: null,
          plan_name: "Plan B",
          plan_usd_per_month: 200,
          covers_from: "2026-10-01T05:00:00.000Z",
          covers_to: "2026-10-01T05:00:00.000Z",
        },
      ]);
    },
  );

  it.skipIf(IS_WINDOWS)("traces each month's cost to its requests", () => {
    const costs = db
      .prepare(
        "SELECT strftime('%Y-%m', timestamp_utc, 'localtime') AS month, TOTAL(total_usd) AS usd, COUNT(*) AS n FROM request_costs GROUP BY month ORDER BY month",
      )
      .all() as { month: string; usd: number; n: number }[];
    const months = rows(db, "proj_api_list_price", "month");
    expect(costs.map((c) => [c.month, c.n])).toEqual(
      months.map((m) => [m["month"], m["requests"]]),
    );
    expect(costs.map((c) => c.usd)).toEqual([3, 4, 0]);
  });

  it("shows no plan price for months before the first entry", () => {
    const early = ingest({ "-p/s.jsonl": [request("s", "e", null, "2026-07-10T12:00:00Z")] });
    setPlanPrice(early, { month: "2026-08", planName: "Plan A", usdPerMonth: 100 }, now);
    expect(rows(early, "proj_api_list_price")).toEqual([
      expect.objectContaining({ month: "2026-07", plan_name: null, plan_usd_per_month: null }),
    ]);
  });
});
