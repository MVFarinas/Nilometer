/**
 * @file A usage window is open only until its reset, as of the report's own time (D-083, step G2.5).
 *
 * On the report fixture (fixture.ts), the last status line reading is 2026-09-02 19:00 UTC, and the
 * windows reset at 2026-09-02 17:00 (5-hour), 2026-09-02 22:00 (5-hour), and 2026-09-07 00:00
 * (weekly). The views call a window open when it resets after the last reading; the report also
 * requires that it reset after the report's time. Worked out by hand:
 *
 * | Report time | 17:00 window | 22:00 window | weekly | burn rate projects |
 * |---|---|---|---|---|
 * | none given | reset | open | open | as the views have it |
 * | 2026-09-02 20:00 | reset | open | open | the 22:00 window and the weekly one |
 * | 2026-09-02 23:00 | reset | reset | open | the weekly one only |
 */
import { describe, expect, it } from "vitest";

import { loadObserved, loadProjected } from "../../../viewer/queries.js";
import { renderReport } from "../../../viewer/render.js";
import { buildReportFixture } from "./fixture.js";

/**
 * Lists each window's reset and its status at a report time.
 * @param reportedAt - The report's time; omitted, the views' own rule.
 * @returns `[reset, open]` pairs, by reset.
 */
function statuses(reportedAt?: Date): [string, number][] {
  return loadObserved(buildReportFixture(), reportedAt)
    .windows.map((w): [string, number] => [w.reset_at_utc, w.open_at_report])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

describe("open until its reset, as of the report's time (D-083)", () => {
  it("keeps the views' rule when no report time is given", () => {
    expect(statuses()).toEqual([
      ["2026-09-02T17:00:00.000Z", 0],
      ["2026-09-02T22:00:00.000Z", 1],
      ["2026-09-07T00:00:00.000Z", 1],
    ]);
  });

  it("calls a window reset once its reset has passed, even with no reading after it", () => {
    expect(statuses(new Date("2026-09-02T20:00:00Z"))).toEqual([
      ["2026-09-02T17:00:00.000Z", 0],
      ["2026-09-02T22:00:00.000Z", 1],
      ["2026-09-07T00:00:00.000Z", 1],
    ]);
    expect(statuses(new Date("2026-09-02T23:00:00Z"))).toEqual([
      ["2026-09-02T17:00:00.000Z", 0],
      ["2026-09-02T22:00:00.000Z", 0],
      ["2026-09-07T00:00:00.000Z", 1],
    ]);
  });

  it("projects a burn rate only for windows still open at the report's time", () => {
    /**
     * Lists the open windows' resets.
     * @param at - The report's time.
     * @returns Resets of the rows open at it.
     */
    const open = (at: Date): string[] =>
      loadProjected(buildReportFixture(), at)
        .burnRate.filter((row) => row.open_at_report === 1)
        .map((row) => row.reset_at_utc)
        .sort();
    expect(open(new Date("2026-09-02T20:00:00Z"))).toEqual([
      "2026-09-02T22:00:00.000Z",
      "2026-09-07T00:00:00.000Z",
    ]);
    expect(open(new Date("2026-09-02T23:00:00Z"))).toEqual(["2026-09-07T00:00:00.000Z"]);
  });

  it("prints the same report for the same data and the same time", () => {
    const at = new Date("2026-09-02T23:00:00Z");
    /**
     * Renders the fixture's text report at the fixed time.
     * @returns The report text.
     */
    const render = (): string => {
      const db = buildReportFixture();
      return renderReport({
        observed: loadObserved(db, at),
        projected: loadProjected(db, at),
        timeZone: "UTC",
        lastIngestAt: null,
        databasePath: "usage.db",
        home: "",
      });
    };
    const first = render();
    expect(render()).toBe(first);
    // The 22:00 window reads reset, and only the weekly window is projected.
    expect(first).toMatch(/5-hour {2}2026-09-02 22:00 .* reset/);
    expect(first.match(/window resetting .*: .* at /g)).toHaveLength(1);
    expect(first).toContain(
      "Open: not reset as of this report. An open window's usage is its last reading's, at the time under Reading at.",
    );
  });
});
