/**
 * @file Unit tests for core/verify/compare.ts: the comparison rules shared by the fixture audit
 * and `nilometer verify`, so the two can never answer "do these agree" differently.
 */
import { describe, expect, it } from "vitest";

import { FIELDS, dayOf, diffTotals, sameValue } from "../../../../core/verify/compare.js";

describe("sameValue", () => {
  it("compares tokens exactly and costs within floating-point noise", () => {
    expect(sameValue("output", 1, 1)).toBe(true);
    expect(sameValue("output", 1, 2)).toBe(false);
    expect(sameValue("cost_usd", 0.0017560000000000002, 0.0017559999999999997)).toBe(true);
    expect(sameValue("cost_usd", 0.000098, 0.000096)).toBe(false);
  });
});

describe("diffTotals", () => {
  /**
   * One day and model with the given output count.
   * @param output - Output tokens.
   * @returns Totals in the shape diffTotals takes.
   */
  const totals = (output: number): Record<string, Record<string, number>> => ({
    "2026-09-01|m": { input: 0, output, cache_read: 0, cache_write: 0, cost_usd: 0 },
  });

  it("compares every field by default", () => {
    expect(diffTotals(totals(1) as never, totals(1) as never)).toEqual([]);
    expect(diffTotals(totals(1) as never, totals(2) as never)).toEqual([
      { key: "2026-09-01|m", field: "output", ours: 1, theirs: 2 },
    ]);
    expect(FIELDS).toContain("cost_usd");
  });

  it("compares only the fields it is given", () => {
    // `verify` passes tokens only: cost depends on two price tables agreeing (D-064).
    expect(diffTotals(totals(1) as never, totals(1) as never, ["cost_usd"])).toEqual([]);
    expect(diffTotals(totals(1) as never, totals(2) as never, ["cost_usd"])).toEqual([]);
  });

  it("treats a key missing on one side as zero, so it shows up", () => {
    expect(diffTotals(totals(5) as never, {}, ["output"])).toEqual([
      { key: "2026-09-01|m", field: "output", ours: 5, theirs: 0 },
    ]);
  });
});

describe("dayOf", () => {
  it("takes the day out of a key, and copes with one that has no model", () => {
    expect(dayOf("2026-09-01|claude-opus-5")).toBe("2026-09-01");
    expect(dayOf("2026-09-01")).toBe("2026-09-01");
  });
});
