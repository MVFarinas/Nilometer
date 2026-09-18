/**
 * @file Tests for the headroom and peak views (docs/development.md P6.2, D-024).
 *
 * The scenario was worked out on paper before running any view. All readings are on 2026-09-03 UTC
 * unless stated. The logs hold one prompt on 2026-09-01, before any reading, so status line
 * coverage and log coverage differ (the init boundary).
 *
 * | Reading | At | Window | used | resets | Note |
 * |---|---|---|---|---|---|
 * | r0 | 10:30:00 | five_hour | 99 | 10:00 | captured after its reset |
 * | r1 | 11:00:00 | five_hour | 10 | 15:00 | |
 * | r8 | 11:00:00 | seven_day | 30 | 09-10 00:00 | |
 * | r2 | 12:00:00 | five_hour | 55 | 15:00 | the peak |
 * | r3 | 12:00:00 | five_hour | 50 | 15:00 | same second as r2, later line: the last reading |
 * | r4 | 14:30:00 | five_hour | 101 | 15:00 | invalid percentage, excluded |
 * | r5 | 15:00:05 | five_hour | 3 | 15:00 | captured after its reset |
 * | r6 | 15:10:00 | five_hour | 4 | 20:00 | |
 * | r7 | 16:00:00 | five_hour | 20 | 20:00 | last reading overall |
 * | r9 | 16:00:00 | seven_day | 42 | 09-10 00:00 | |
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../../../core/db/database.js";
import { type Reading, ingest, rows, user } from "./helpers.js";

/**
 * Builds a reading on 2026-09-03.
 * @param at - `HH:MM:SS` UTC.
 * @param window - Window name.
 * @param used - used_percentage.
 * @param resets - Full ISO-8601 reset instant.
 * @returns The reading.
 */
function reading(at: string, window: string, used: number, resets: string): Reading {
  return { at: `2026-09-03T${at}Z`, session: "s", window, used, resets };
}

/** Readings in capture order, as in the table above. */
const READINGS: readonly Reading[] = [
  reading("10:30:00", "five_hour", 99, "2026-09-03T10:00:00Z"),
  reading("11:00:00", "five_hour", 10, "2026-09-03T15:00:00Z"),
  reading("11:00:00", "seven_day", 30, "2026-09-10T00:00:00Z"),
  reading("12:00:00", "five_hour", 55, "2026-09-03T15:00:00Z"),
  reading("12:00:00", "five_hour", 50, "2026-09-03T15:00:00Z"),
  reading("14:30:00", "five_hour", 101, "2026-09-03T15:00:00Z"),
  reading("15:00:05", "five_hour", 3, "2026-09-03T15:00:00Z"),
  reading("15:10:00", "five_hour", 4, "2026-09-03T20:00:00Z"),
  reading("16:00:00", "five_hour", 20, "2026-09-03T20:00:00Z"),
  reading("16:00:00", "seven_day", 42, "2026-09-10T00:00:00Z"),
];

/** Status line coverage: r0 to r7/r9. The r4 reading is a valid reading with an invalid window. */
const COVERS = { covers_from: "2026-09-03T10:30:00.000Z", covers_to: "2026-09-03T16:00:00.000Z" };

describe("headroom and peak: hand-computed scenario", () => {
  let db: Db;

  beforeAll(() => {
    db = ingest({ "-p/s.jsonl": [user("s", "u", null, "2026-09-01T09:00:00Z")] }, READINGS);
  });

  it("gives each window's last reading before its reset, and marks open windows", () => {
    expect(rows(db, "obs_window_headroom", "window, reset_at_utc")).toEqual([
      // Only r0, captured after its 10:00 reset: no usable reading, so the value is unknown, not 0.
      {
        window: "five_hour",
        reset_at_utc: "2026-09-03T10:00:00.000Z",
        last_used_percentage: null,
        last_reading_at_utc: null,
        last_reading_raw_line_id: null,
        readings: 0,
        readings_after_reset: 1,
        first_reading_at_utc: null,
        window_open: 0,
        ...COVERS,
      },
      // r1, r2, r3 count (r4 invalid, r5 after reset). r2 and r3 share 12:00:00; r3 is the later line.
      // Closed: the last reading overall (16:00) is after 15:00.
      {
        window: "five_hour",
        reset_at_utc: "2026-09-03T15:00:00.000Z",
        last_used_percentage: 50,
        last_reading_at_utc: "2026-09-03T12:00:00.000Z",
        last_reading_raw_line_id: expect.any(Number) as number,
        readings: 3,
        readings_after_reset: 1,
        first_reading_at_utc: "2026-09-03T11:00:00.000Z",
        window_open: 0,
        ...COVERS,
      },
      // r6, r7; 20:00 is after the last reading, so still open.
      {
        window: "five_hour",
        reset_at_utc: "2026-09-03T20:00:00.000Z",
        last_used_percentage: 20,
        last_reading_at_utc: "2026-09-03T16:00:00.000Z",
        last_reading_raw_line_id: expect.any(Number) as number,
        readings: 2,
        readings_after_reset: 0,
        first_reading_at_utc: "2026-09-03T15:10:00.000Z",
        window_open: 1,
        ...COVERS,
      },
      {
        window: "seven_day",
        reset_at_utc: "2026-09-10T00:00:00.000Z",
        last_used_percentage: 42,
        last_reading_at_utc: "2026-09-03T16:00:00.000Z",
        last_reading_raw_line_id: expect.any(Number) as number,
        readings: 2,
        readings_after_reset: 0,
        first_reading_at_utc: "2026-09-03T11:00:00.000Z",
        window_open: 1,
        ...COVERS,
      },
    ]);
  });

  it("gives each window's highest reading, the earliest when tied", () => {
    expect(
      rows(db, "obs_window_peak", "window, reset_at_utc").map((r) => [
        r["window"],
        r["reset_at_utc"],
        r["peak_used_percentage"],
        r["peak_reading_at_utc"],
      ]),
    ).toEqual([
      ["five_hour", "2026-09-03T10:00:00.000Z", null, null],
      ["five_hour", "2026-09-03T15:00:00.000Z", 55, "2026-09-03T12:00:00.000Z"], // r2, not the invalid 101
      ["five_hour", "2026-09-03T20:00:00.000Z", 20, "2026-09-03T16:00:00.000Z"],
      ["seven_day", "2026-09-10T00:00:00.000Z", 42, "2026-09-03T16:00:00.000Z"],
    ]);
  });

  it("traces each value to a reading that re-derives it", () => {
    const readings = rows(db, "window_readings");
    for (const row of rows(db, "obs_window_headroom")) {
      const instance = readings.filter(
        (r) =>
          r["window"] === row["window"] &&
          r["reset_at_utc"] === row["reset_at_utc"] &&
          r["after_reset"] === 0,
      );
      expect(instance).toHaveLength(row["readings"] as number);
      if (instance.length === 0) {
        continue;
      }
      const last = readings.find((r) => r["raw_line_id"] === row["last_reading_raw_line_id"]);
      expect(last?.["used_percentage"]).toBe(row["last_used_percentage"]);
      const latest = Math.max(...instance.map((r) => r["observed_at_s"] as number));
      expect(last?.["observed_at_s"]).toBe(latest);
    }
    for (const row of rows(db, "obs_window_peak").filter((r) => r["readings"] !== 0)) {
      const peak = readings.find((r) => r["raw_line_id"] === row["peak_reading_raw_line_id"]);
      const instance = readings.filter(
        (r) =>
          r["window"] === row["window"] &&
          r["reset_at_utc"] === row["reset_at_utc"] &&
          r["after_reset"] === 0,
      );
      expect(peak?.["used_percentage"]).toBe(
        Math.max(...instance.map((r) => r["used_percentage"] as number)),
      );
    }
  });
});

describe("headroom and peak: edge cases", () => {
  it("returns no windows for logs alone, before any reading exists", () => {
    const db = ingest({ "-p/s.jsonl": [user("s", "u", null, "2026-09-01T09:00:00Z")] });
    expect(rows(db, "obs_window_headroom")).toEqual([]);
    expect(rows(db, "obs_window_peak")).toEqual([]);
  });

  it("reports a single reading as both last and peak, and ignores the spend limit", () => {
    const db = ingest({}, [
      reading("11:00:00", "five_hour", 0, "2026-09-03T15:00:00Z"),
      reading("11:00:00", "spend_limit", 80, "2026-09-03T15:00:00Z"),
    ]);
    expect(rows(db, "obs_window_headroom")).toEqual([
      expect.objectContaining({
        window: "five_hour",
        last_used_percentage: 0,
        readings: 1,
        window_open: 1,
      }),
    ]);
    expect(rows(db, "obs_window_peak")).toEqual([
      expect.objectContaining({ window: "five_hour", peak_used_percentage: 0 }),
    ]);
  });

  it("counts a reading captured exactly at the reset as before it", () => {
    const db = ingest({}, [reading("15:00:00", "five_hour", 97, "2026-09-03T15:00:00Z")]);
    // Captured at the reset instant, and that reading is the latest, so the window is closed.
    expect(rows(db, "obs_window_headroom")).toEqual([
      expect.objectContaining({
        last_used_percentage: 97,
        readings: 1,
        readings_after_reset: 0,
        window_open: 0,
      }),
    ]);
  });
});
