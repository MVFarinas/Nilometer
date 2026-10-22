/**
 * @file When each weekly window was first read at or above 75% and 90% (D-087, step G3.2).
 *
 * No session logs, so each reading is dated by its capture (D-044's fallback). Worked out by hand:
 *
 * | Window | Reading | Value | Counts? | 75% | 90% |
 * |---|---|---|---|---|---|
 * | weekly, resets 09-08 00:00 | 09-02 10:00 | 50 | yes | | |
 * | | 09-03 12:00 | 76 | yes | first: 4 d 12 h = 388,800 s left | |
 * | | 09-04 08:00 | 80 | yes | | |
 * | | 09-05 18:00 | 92 | yes | | first: 2 d 6 h = 194,400 s left |
 * | | 09-06 09:00 | 95 | yes | | |
 * | | 09-08 00:30 | 99 | no, after its reset | | |
 * | weekly, resets 09-15 00:00 | 09-10 00:00 | 80 | yes | first: 5 d = 432,000 s left | not reached |
 * | 5-hour, resets 09-02 12:00 | 09-02 11:00 | 95 | weekly only | | |
 */
import { describe, expect, it } from "vitest";

import { loadHtmlData } from "../../../../viewer/html-data.js";
import { renderHtmlReport } from "../../../../viewer/html.js";
import { loadObserved, loadProjected } from "../../../../viewer/queries.js";
import { LABELS, renderReport, reportJson } from "../../../../viewer/render.js";
import { ingest } from "./helpers.js";

/**
 * A reading of session `s`.
 * @param at - Capture time, ISO-8601 UTC without the zone letter.
 * @param window - Window name.
 * @param used - used_percentage.
 * @param resets - Reset, ISO-8601 UTC without the zone letter.
 * @returns The reading.
 */
const reading = (at: string, window: string, used: number, resets: string) => ({
  at: `${at}Z`,
  session: "s",
  window,
  used,
  resets: `${resets}Z`,
});

describe("the first weekly reading at or above 75% and 90% (D-087)", () => {
  const A = "2026-09-08T00:00:00";
  const B = "2026-09-15T00:00:00";
  const db = ingest({}, [
    reading("2026-09-02T10:00:00", "seven_day", 50, A),
    reading("2026-09-03T12:00:00", "seven_day", 76, A),
    reading("2026-09-04T08:00:00", "seven_day", 80, A),
    reading("2026-09-05T18:00:00", "seven_day", 92, A),
    reading("2026-09-06T09:00:00", "seven_day", 95, A),
    reading("2026-09-08T00:30:00", "seven_day", 99, A),
    reading("2026-09-10T00:00:00", "seven_day", 80, B),
    reading("2026-09-02T11:00:00", "five_hour", 95, "2026-09-02T12:00:00"),
  ]);

  it("lists each level a weekly window reached, with the time left before its reset", () => {
    const rows = db
      .prepare(
        "SELECT window, reset_at_utc, threshold, first_at_utc, used_percentage, seconds_before_reset FROM obs_weekly_crossings ORDER BY reset_at_utc, threshold",
      )
      .all();
    expect(rows).toEqual([
      {
        window: "seven_day",
        reset_at_utc: "2026-09-08T00:00:00.000Z",
        threshold: 75,
        first_at_utc: "2026-09-03T12:00:00.000Z",
        used_percentage: 76,
        seconds_before_reset: 388_800,
      },
      {
        window: "seven_day",
        reset_at_utc: "2026-09-08T00:00:00.000Z",
        threshold: 90,
        first_at_utc: "2026-09-05T18:00:00.000Z",
        used_percentage: 92,
        seconds_before_reset: 194_400,
      },
      {
        window: "seven_day",
        reset_at_utc: "2026-09-15T00:00:00.000Z",
        threshold: 75,
        first_at_utc: "2026-09-10T00:00:00.000Z",
        used_percentage: 80,
        seconds_before_reset: 432_000,
      },
    ]);
  });

  it("resolves every row to the reading it was computed from (principle 4)", () => {
    const traced = db
      .prepare(
        `SELECT c.threshold, w.used_percentage, w.observed_at_utc
         FROM obs_weekly_crossings c
         JOIN window_readings w ON w.raw_line_id = c.raw_line_id AND w.window = c.window
           AND w.reset_at_utc = c.reset_at_utc
         ORDER BY c.reset_at_utc, c.threshold`,
      )
      .all();
    // The reading behind each row carries the row's value and time.
    expect(traced).toEqual([
      { threshold: 75, used_percentage: 76, observed_at_utc: "2026-09-03T12:00:00.000Z" },
      { threshold: 90, used_percentage: 92, observed_at_utc: "2026-09-05T18:00:00.000Z" },
      { threshold: 75, used_percentage: 80, observed_at_utc: "2026-09-10T00:00:00.000Z" },
    ]);
  });

  it("has no row for a database with no readings", () => {
    expect(ingest({}).prepare("SELECT COUNT(*) AS n FROM obs_weekly_crossings").get()).toEqual({
      n: 0,
    });
  });
});

describe("the crossings in the text report, JSON and page (D-087)", () => {
  const db = ingest({}, [
    reading("2026-09-03T12:00:00", "seven_day", 76, "2026-09-08T00:00:00"),
    reading("2026-09-05T18:00:00", "seven_day", 92, "2026-09-08T00:00:00"),
    reading("2026-09-10T00:00:00", "seven_day", 80, "2026-09-15T00:00:00"),
  ]);
  const input = {
    observed: loadObserved(db),
    projected: loadProjected(db),
    timeZone: "UTC",
    lastIngestAt: null,
    databasePath: "/home/example/.local/share/nilometer/usage.db",
    home: "/home/example",
  };

  it("prints one line per weekly window, newest first, under the windows table", () => {
    const lines = renderReport(input).split("\n");
    const at = lines.indexOf(`  ${LABELS.crossings}`);
    expect(at).toBeGreaterThan(lines.indexOf(LABELS.windows));
    expect(lines.slice(at + 1, at + 4)).toEqual([
      "    weekly window resetting 2026-09-15 00:00: 75% first read 2026-09-10 00:00 (5 d 0 h before the reset); 90% not reached",
      "    weekly window resetting 2026-09-08 00:00: 75% first read 2026-09-03 12:00 (4 d 12 h before the reset); 90% first read 2026-09-05 18:00 (2 d 6 h before the reset)",
      `    ${LABELS.crossingsCaveat}`,
    ]);
  });

  it("says so when no weekly window reached 75%", () => {
    const quiet = ingest({}, [
      reading("2026-09-03T12:00:00", "seven_day", 40, "2026-09-08T00:00:00"),
    ]);
    const text = renderReport({
      ...input,
      observed: loadObserved(quiet),
      projected: loadProjected(quiet),
    });
    expect(text).toContain(`  ${LABELS.noCrossings}`);
    expect(text).not.toContain(LABELS.crossings);
  });

  it("carries the unrounded rows in JSON, inside the observed section", () => {
    const json = reportJson(input) as { observed: { weeklyCrossings: unknown[] } };
    expect(json.observed.weeklyCrossings).toHaveLength(3);
    expect(json.observed.weeklyCrossings[0]).toMatchObject({
      reset_at_utc: "2026-09-15T00:00:00.000Z",
      threshold: 75,
      seconds_before_reset: 432_000,
    });
  });

  it("shows the same rows on the page, each value resolving to its reading", () => {
    const data = loadHtmlData(db, {
      timeZone: "UTC",
      generatedAt: new Date("2026-09-16T00:00:00Z"),
    });
    expect(data.crossings.map((c) => [c.threshold, c.firstAtUtc, c.secondsBeforeReset])).toEqual([
      [75, "2026-09-10T00:00:00.000Z", 432_000],
      [75, "2026-09-03T12:00:00.000Z", 388_800],
      [90, "2026-09-05T18:00:00.000Z", 194_400],
    ]);
    // Every reading a row names is in the page's event table.
    for (const c of data.crossings) {
      expect(data.events[c.events[0] ?? -1]).toBeDefined();
    }
    const html = renderHtmlReport(data);
    const section = html.slice(
      html.indexOf('id="nm-crossings"'),
      html.indexOf("</section>", html.indexOf('id="nm-crossings"')),
    );
    // What the table shows is behind the heading's "i"; the lower-bound caveat stays (D-091).
    expect(section).toContain(`<span>${LABELS.crossingsWhat}</span>`);
    expect(section).toContain(`<p class="caveat">${LABELS.crossingsCaveat}</p>`);
    expect(section).toContain("<td>2026-09-08 00:00</td><td>90%</td><td>2026-09-05 18:00</td>");
    expect(section).toContain(">2 d 6 h</td>");
  });
});
