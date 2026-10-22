/**
 * @file A reading below an earlier one in its window is stale: kept, counted, and used for no value
 * (D-089, step G4.1).
 *
 * No session logs, so each reading is dated by its capture. Shaped on the 2026-10-19 window, where a
 * session showed 73% while the window was locked at 100%. Worked out by hand:
 *
 * | Window resets | At | Session | Value | Highest earlier | Stale? |
 * |---|---|---|---|---|---|
 * | 09-01 14:00 | 10:00 | a | 40 | none | no |
 * | | 11:00 | a | 90 | 40 | no |
 * | | 11:30 | b | 100 | 90 | no |
 * | | 12:00 | a | 73 | 100 | yes, 27 below |
 * | | 12:30 | b | 99.5 | 100 | no, within 1 point |
 * | | 13:00 | a | 101 | 100 | no: the last reading, 101 |
 * | 09-01 19:00 | 15:00 | a | 50 | none | no |
 * | | 16:00 | a | 60 | 50 | no: the last reading that isn't stale |
 * | | 16:30 | b | 30 | 60 | yes, 30 below, and the latest reading |
 */
import { describe, expect, it } from "vitest";

import type { WindowSeries } from "../../../../viewer/html-contract.js";
import { renderWindowSeries } from "../../../../viewer/html-charts.js";
import { loadHtmlData } from "../../../../viewer/html-data.js";
import { renderHtmlReport } from "../../../../viewer/html.js";
import { explain } from "../../../../viewer/explain.js";
import { loadObserved, loadProjected } from "../../../../viewer/queries.js";
import { LABELS, renderReport } from "../../../../viewer/render.js";
import { ingest } from "./helpers.js";

/**
 * A 5-hour reading on 2026-09-01.
 * @param time - `HH:MM` UTC.
 * @param session - Payload session.
 * @param used - used_percentage.
 * @param resets - `HH:MM` UTC reset on the same day.
 * @returns The reading.
 */
const reading = (time: string, session: string, used: number, resets: string) => ({
  at: `2026-09-01T${time}:00Z`,
  session,
  window: "five_hour",
  used,
  resets: `2026-09-01T${resets}:00Z`,
});

describe("stale readings (D-089)", () => {
  const db = ingest({}, [
    reading("10:00", "a", 40, "14:00"),
    reading("11:00", "a", 90, "14:00"),
    reading("11:30", "b", 100, "14:00"),
    reading("12:00", "a", 73, "14:00"),
    reading("12:30", "b", 99.5, "14:00"),
    reading("13:00", "a", 101, "14:00"),
    reading("15:00", "a", 50, "19:00"),
    reading("16:00", "a", 60, "19:00"),
    reading("16:30", "b", 30, "19:00"),
  ]);

  it("marks a reading more than 1 point below an earlier one in its window, from any session", () => {
    const flags = db
      .prepare(
        "SELECT strftime('%H:%M', observed_at_utc) AS at, used_percentage AS used, stale FROM window_readings ORDER BY observed_at_s",
      )
      .all();
    expect(flags).toEqual([
      { at: "10:00", used: 40, stale: 0 },
      { at: "11:00", used: 90, stale: 0 },
      { at: "11:30", used: 100, stale: 0 },
      { at: "12:00", used: 73, stale: 1 },
      { at: "12:30", used: 99.5, stale: 0 },
      { at: "13:00", used: 101, stale: 0 },
      { at: "15:00", used: 50, stale: 0 },
      { at: "16:00", used: 60, stale: 0 },
      { at: "16:30", used: 30, stale: 1 },
    ]);
  });

  it("gives each window the last reading that isn't stale, and still counts every reading", () => {
    const rows = db
      .prepare(
        "SELECT reset_at_utc, last_used_percentage, last_reading_at_utc, readings, readings_stale FROM obs_window_headroom ORDER BY reset_at_utc",
      )
      .all();
    expect(rows).toEqual([
      {
        reset_at_utc: "2026-09-01T14:00:00.000Z",
        last_used_percentage: 101,
        last_reading_at_utc: "2026-09-01T13:00:00.000Z",
        readings: 6,
        readings_stale: 1,
      },
      {
        // The latest reading, 30 at 16:30, is stale, so 60 at 16:00 is the last one used.
        reset_at_utc: "2026-09-01T19:00:00.000Z",
        last_used_percentage: 60,
        last_reading_at_utc: "2026-09-01T16:00:00.000Z",
        readings: 3,
        readings_stale: 1,
      },
    ]);
  });

  it("leaves the peaks alone, since a stale reading is below an earlier one", () => {
    const peaks = db
      .prepare("SELECT peak_used_percentage FROM obs_window_peak ORDER BY reset_at_utc")
      .all();
    expect(peaks).toEqual([{ peak_used_percentage: 101 }, { peak_used_percentage: 60 }]);
  });

  it("pairs only readings that aren't stale, so a stale dip makes no change of its own", () => {
    const changes = db
      .prepare(
        "SELECT change_percentage_points AS change FROM window_reading_pairs ORDER BY reset_at_utc, observed_at_utc",
      )
      .all()
      .map((r) => (r as { change: number }).change);
    // 40→90, 90→100, 100→99.5, 99.5→101; then 50→60. Neither 73 nor 30 appears.
    expect(changes).toEqual([50, 10, -0.5, 1.5, 10]);
  });
});

describe("stale readings in explain, the text report and the page (D-089)", () => {
  const db = ingest({}, [
    reading("10:00", "a", 40, "14:00"),
    reading("11:30", "b", 100, "14:00"),
    reading("12:00", "a", 73, "14:00"),
    reading("13:00", "a", 101, "14:00"),
  ]);

  it("lists the stale reading under headroom, adding nothing to the value", () => {
    const [group] = explain(db, "headroom").groups;
    expect(group?.measures[0]?.reported).toBe(101);
    expect(group?.events.map((e) => [e.at, e.contributions[0]])).toEqual([
      ["2026-09-01T13:00:00.000Z", 101],
      ["2026-09-01T12:00:00.000Z", null],
    ]);
    expect(group?.events[1]?.description).toContain("stale reading, not used: 73%");
  });

  it("counts it under the windows table, and draws it hollow and off the line on the page", () => {
    const text = renderReport({
      observed: loadObserved(db),
      projected: loadProjected(db),
      timeZone: "UTC",
      lastIngestAt: null,
      databasePath: "/home/example/.local/share/nilometer/usage.db",
      home: "/home/example",
    });
    expect(text).toContain(`  ${LABELS.staleReadings}: 1`);
    const data = loadHtmlData(db, {
      timeZone: "UTC",
      generatedAt: new Date("2026-09-01T15:00:00Z"),
    });
    const points = data.series[0]?.points ?? [];
    expect(points.map((p) => [p.used, p.stale])).toEqual([
      [40, false],
      [100, false],
      [73, true],
      [101, false],
    ]);
    const svg = renderWindowSeries(data.series[0] as WindowSeries, { timeZone: "UTC", width: 596 });
    // The line has three vertices (M, L, L): 40, 100, 101. The stale 73 is a hollow circle.
    const line = /class="nm-data nm-line"[^>]*\sd="([^"]+)"/.exec(svg)?.[1] ?? "";
    expect(line.match(/[ML]/g)).toEqual(["M", "L", "L"]);
    expect(svg).toContain(
      "Stale reading 73% at 2026-09-01 12:00: below an earlier reading in this window, so not used",
    );
    const html = renderHtmlReport(data);
    expect(html).toContain(`${LABELS.staleReadings}: 1`);
  });
});
