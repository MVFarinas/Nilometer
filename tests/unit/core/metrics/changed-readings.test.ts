/**
 * @file A reading whose value changed without a new response is its own observation (D-086, step G3.1).
 *
 * One session `s`, one 5-hour window resetting 2026-09-01 14:00. Request r1 at 10:00:00, then seven
 * captures, then request r2 at 12:30:00. Worked out by hand:
 *
 * | Capture | Value | Response | Run | Observation |
 * |---|---|---|---|---|
 * | 10:00:05 | 20 | r1 | 1 | 1: dated 10:00:00 (r1's first line) |
 * | 10:30:00 | 20.000000000000004 | r1 | 1 | same number, within 0.01 |
 * | 11:00:00 | 20 | r1 | 1 | latest capture of run 1: the row's raw line |
 * | 11:15:00 | 35 | r1 | 2 | 2: dated 11:15:00 (its first capture) |
 * | 11:45:00 | 35 | r1 | 2 | latest capture of run 2 |
 * | 12:00:00 | 50 | r1 | 3 | 3: dated 12:00:00 |
 * | 12:30:05 | 55 | r2 | 1 | 4: dated 12:30:00 (r2's first line) |
 *
 * Before D-086 the four captures of r1 were one observation dated 10:00:00, valued 50 (the latest
 * capture): a value first seen at 12:00 drawn two hours early, and r1's own 20 gone.
 */
import { describe, expect, it } from "vitest";

import { explain } from "../../../../viewer/explain.js";
import { ingest, request } from "./helpers.js";

/** The window every capture reports. */
const FIVE = { window: "five_hour", resets: "2026-09-01T14:00:00Z" } as const;

/**
 * A capture of session `s`.
 * @param time - `HH:MM:SS` UTC on 2026-09-01.
 * @param used - used_percentage.
 * @returns The reading.
 */
const capture = (time: string, used: number) =>
  ({ at: `2026-09-01T${time}Z`, session: "s", used, ...FIVE }) as const;

describe("a value that changed without a new response is its own observation (D-086)", () => {
  const db = ingest(
    {
      "-p/s.jsonl": [
        request("s", "r1", null, "2026-09-01T10:00:00Z"),
        request("s", "r2", "r1", "2026-09-01T12:30:00Z"),
      ],
    },
    [
      capture("10:00:05", 20),
      capture("10:30:00", 20.000000000000004),
      capture("11:00:00", 20),
      capture("11:15:00", 35),
      capture("11:45:00", 35),
      capture("12:00:00", 50),
      capture("12:30:05", 55),
    ],
  );

  it("splits one response's captures into runs of the same value, each dated where it starts", () => {
    const rows = db
      .prepare(
        "SELECT used_percentage, observed_at_utc, captured_at_utc, observed_via FROM window_readings ORDER BY observed_at_s",
      )
      .all();
    expect(rows).toEqual([
      {
        used_percentage: 20,
        observed_at_utc: "2026-09-01T10:00:00.000Z",
        captured_at_utc: "2026-09-01T11:00:00.000Z",
        observed_via: "last_request",
      },
      {
        used_percentage: 35,
        observed_at_utc: "2026-09-01T11:15:00.000Z",
        captured_at_utc: "2026-09-01T11:45:00.000Z",
        observed_via: "changed_capture",
      },
      {
        used_percentage: 50,
        observed_at_utc: "2026-09-01T12:00:00.000Z",
        captured_at_utc: "2026-09-01T12:00:00.000Z",
        observed_via: "changed_capture",
      },
      {
        used_percentage: 55,
        observed_at_utc: "2026-09-01T12:30:00.000Z",
        captured_at_utc: "2026-09-01T12:30:05.000Z",
        observed_via: "last_request",
      },
    ]);
  });

  it("keeps the window's peak and last value, which never depended on the dating", () => {
    const peak = db.prepare("SELECT peak_used_percentage FROM obs_window_peak").get() as {
      peak_used_percentage: number;
    };
    expect(peak.peak_used_percentage).toBe(55);
    const head = db
      .prepare("SELECT last_used_percentage, last_reading_at_utc FROM obs_window_headroom")
      .get();
    expect(head).toEqual({
      last_used_percentage: 55,
      last_reading_at_utc: "2026-09-01T12:30:00.000Z",
    });
  });

  it("sees the 35 to 50 rise as usage with no Claude Code request between, as D-025 defined it", () => {
    // Pairs: 20→35 spans r1's line at 10:00:00 (the interval starts at the earlier observation,
    // inclusive), 35→50 spans no request line, 50→55 spans r2's.
    const events = db
      .prepare(
        "SELECT previous_observed_at_utc, observed_at_utc, change_percentage_points FROM obs_unattributed_usage_events",
      )
      .all();
    expect(events).toEqual([
      {
        previous_observed_at_utc: "2026-09-01T11:15:00.000Z",
        observed_at_utc: "2026-09-01T12:00:00.000Z",
        change_percentage_points: 15,
      },
    ]);
  });
});

describe("explain says a changed value was observed at its capture (D-086)", () => {
  // r1 at 10:00:00; captures 20 at 10:00:05 and 40 at 11:00:00. The peak is the 40, first seen at
  // its 11:00:00 capture, not at r1.
  const db = ingest({ "-p/s.jsonl": [request("s", "r1", null, "2026-09-01T10:00:00Z")] }, [
    capture("10:00:05", 20),
    capture("11:00:00", 40),
  ]);

  it("dates the peak's event at the capture and says why", () => {
    const [group] = explain(db, "peak").groups;
    expect(group?.events).toHaveLength(1);
    expect(group?.events[0]?.at).toBe("2026-09-01T11:00:00.000Z");
    expect(group?.events[0]?.description).toContain(
      "observed at capture (changed since the session's last request)",
    );
  });
});
