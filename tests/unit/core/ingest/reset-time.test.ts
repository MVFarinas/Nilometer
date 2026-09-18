/**
 * @file Unit tests for core/ingest/reset-time.ts (D-023).
 *
 * Expected instants are worked out by hand. America/Chicago in 2026: CST (UTC−6) until
 * 2026-03-08 02:00 local, when clocks jump to 03:00 CDT (UTC−5); CDT until 2026-11-01 02:00
 * local, when clocks fall back to 01:00 CST.
 */
import { describe, expect, it } from "vitest";

import { RESET_SEARCH_MINUTES, resolveResetTime } from "../../../../core/ingest/reset-time.js";

describe("resolveResetTime", () => {
  it.each([
    ["later the same day", "6:10am (UTC)", "2026-09-01T03:00:00.000Z", "2026-09-01T06:10:00.000Z"],
    [
      "the next day once the time has passed",
      "6:10am (UTC)",
      "2026-09-01T07:00:00.000Z",
      "2026-09-02T06:10:00.000Z",
    ],
    // Text has minute precision, so a reset in the hit's own minute is that minute, not tomorrow.
    [
      "the hit's own minute",
      "6:10am (UTC)",
      "2026-09-01T06:10:45.000Z",
      "2026-09-01T06:10:00.000Z",
    ],
    [
      "an hour without minutes",
      "4pm (UTC)",
      "2026-09-01T03:00:00.000Z",
      "2026-09-01T16:00:00.000Z",
    ],
    ["12am as midnight", "12am (UTC)", "2026-09-01T01:00:00.000Z", "2026-09-02T00:00:00.000Z"],
    ["12pm as noon", "12pm (UTC)", "2026-09-01T01:00:00.000Z", "2026-09-01T12:00:00.000Z"],
    [
      "uppercase and spacing",
      " 6:10 PM  (UTC) ",
      "2026-09-01T03:00:00.000Z",
      "2026-09-01T18:10:00.000Z",
    ],
    // 05:00 CDT at the hit; 06:10 CDT is 11:10Z.
    [
      "a named zone in daylight time",
      "6:10am (America/Chicago)",
      "2026-09-01T10:00:00.000Z",
      "2026-09-01T11:10:00.000Z",
    ],
    // 00:00 CDT at the hit; 01:30 happens twice, first at 01:30 CDT = 06:30Z.
    [
      "a repeated local time at its first occurrence",
      "1:30am (America/Chicago)",
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ],
    // 01:00 CST at the hit; 02:30 doesn't exist on 03-08, so 02:30 CDT on 03-09 = 07:30Z.
    [
      "a skipped local time on the next day",
      "2:30am (America/Chicago)",
      "2026-03-08T07:00:00.000Z",
      "2026-03-09T07:30:00.000Z",
    ],
  ])("resolves %s", (_name, text, hit, expected) => {
    expect(resolveResetTime(text, hit)).toBe(expected);
  });

  it.each([
    ["no reset text", null, "2026-09-01T03:00:00.000Z"],
    ["no hit time", "6am (UTC)", null],
    ["a hit time that doesn't parse", "6am (UTC)", "yesterday"],
    ["a date in the text", "Sep 20, 9am (UTC)", "2026-09-01T03:00:00.000Z"],
    ["no zone", "6am", "2026-09-01T03:00:00.000Z"],
    ["a 24-hour time", "18:10 (UTC)", "2026-09-01T03:00:00.000Z"],
    ["hour 0", "0am (UTC)", "2026-09-01T03:00:00.000Z"],
    ["hour 13", "13pm (UTC)", "2026-09-01T03:00:00.000Z"],
    ["minute 60", "6:60am (UTC)", "2026-09-01T03:00:00.000Z"],
    ["an unknown zone", "6am (Mars/Olympus_Mons)", "2026-09-01T03:00:00.000Z"],
  ])("leaves the reset unknown for %s", (_name, text, hit) => {
    expect(resolveResetTime(text, hit)).toBeNull();
  });

  it("searches two days ahead, enough for any time of day across a DST change", () => {
    expect(RESET_SEARCH_MINUTES).toBe(2880);
  });
});
