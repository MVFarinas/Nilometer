/**
 * @file Tests for dating status line readings by the API response they came from (D-044).
 *
 * A payload's rate_limits repeat the numbers from the session's latest API response until that
 * session makes another request, however often the status line re-renders (observed 2026-09-14/15
 * with refreshInterval). Expected values are worked out by hand. All times are 2026-09-03 UTC.
 */
import { describe, expect, it } from "vitest";

import { explain } from "../../../../viewer/explain.js";
import { type Reading, ingest, request, rows, summary } from "./helpers.js";

/**
 * A reading for session "r" on 2026-09-03.
 * @param at - `HH:MM:SS` capture time.
 * @param used - used_percentage.
 * @param window - Window name; defaults to the 5-hour window resetting at 14:00.
 * @param resets - Full ISO reset instant.
 * @param session - Payload session.
 * @returns The reading.
 */
function reading(
  at: string,
  used: number,
  window = "five_hour",
  resets = "2026-09-03T14:00:00Z",
  session = "r",
): Reading {
  return { at: `2026-09-03T${at}Z`, session, window, used, resets };
}

describe("observed readings (D-044)", () => {
  it("collapses re-rendered readings of one response into one observation at the response's time", () => {
    const db = ingest({ "-p/r.jsonl": [request("r", "r1", null, "2026-09-03T10:00:00Z")] }, [
      reading("10:00:01", 5),
      reading("10:01:01", 5),
      reading("10:02:01", 5),
    ]);
    expect(
      rows(db, "window_readings").map((r) => [
        r["observed_at_utc"],
        r["observed_via"],
        r["captured_at_utc"],
      ]),
    ).toEqual([["2026-09-03T10:00:00.000Z", "last_request", "2026-09-03T10:02:01.000Z"]]);
    expect(summary(db, "obs_window_headroom")).toMatchObject({
      last_used_percentage: 5,
      last_reading_at_utc: "2026-09-03T10:00:00.000Z",
      readings: 1,
    });
    expect(rows(db, "source_coverage")[1]).toEqual({
      source: "status_line",
      covers_from: "2026-09-03T10:00:00.000Z",
      covers_to: "2026-09-03T10:00:00.000Z",
    });
  });

  it("starts a new observation at each new request, so stale repeats don't make usage look fresher or slower", () => {
    const db = ingest(
      {
        "-p/r.jsonl": [
          request("r", "r1", null, "2026-09-03T10:00:00Z"),
          request("r", "r2", "r1", "2026-09-03T11:00:00Z"),
        ],
      },
      [
        reading("10:00:01", 5),
        reading("10:30:01", 5),
        reading("11:00:01", 9),
        reading("11:30:01", 9),
      ],
    );
    expect(summary(db, "obs_window_headroom")).toMatchObject({
      last_used_percentage: 9,
      last_reading_at_utc: "2026-09-03T11:00:00.000Z",
      readings: 2,
      first_reading_at_utc: "2026-09-03T10:00:00.000Z",
    });
    // One pair: 5 → 9 = +4; [10:00:00, 11:00:01) holds r1 and r2.
    expect(
      rows(db, "window_reading_pairs").map((p) => [
        p["change_percentage_points"],
        p["requests_between"],
      ]),
    ).toEqual([[4, 2]]);
    // Window 09:00 → 14:00. At the observed 11:00, 9% over 2 h = 4.5 pp/h; the 11:30 capture would have said 3.6.
    // Projected 100%: 09:00 + 7200 s × 100 / 9 = +80000 s = 22 h 13 m 20 s → 09-04 07:13:20.
    expect(summary(db, "proj_burn_rate")).toMatchObject({
      projected_percentage_points_per_hour: 4.5,
      projected_limit_at_utc: "2026-09-04T07:13:20.000Z",
      projected_limit_before_reset: 0,
    });
  });

  it("keeps a reading captured after the reset when its response came before it", () => {
    const db = ingest({ "-p/r.jsonl": [request("r", "r1", null, "2026-09-03T13:58:00Z")] }, [
      reading("13:58:01", 80),
      reading("14:01:30", 80),
    ]);
    expect(summary(db, "obs_window_headroom")).toMatchObject({
      last_used_percentage: 80,
      last_reading_at_utc: "2026-09-03T13:58:00.000Z",
      readings: 1,
      readings_after_reset: 0,
    });
  });

  it("uses capture time when the session's last request is from before the window began, or from another session", () => {
    const db = ingest(
      {
        "-p/r.jsonl": [request("r", "r1", null, "2026-09-03T08:00:00Z")],
        "-p/o.jsonl": [request("o", "o1", null, "2026-09-03T10:00:00Z")],
      },
      [
        // 5-hour window 09:00 → 14:00: r1 at 08:00 is before it began → capture 10:00:00.
        reading("10:00:00", 3),
        // Weekly window from 09-03 00:00: r1 at 08:00 is inside it → observed at 08:00.
        reading("10:00:00", 2, "seven_day", "2026-09-10T00:00:00Z"),
        // Session "q" has no requests; o1 belongs to another session → capture 10:00:01.
        reading("10:00:01", 4, "five_hour", "2026-09-03T14:00:00Z", "q"),
      ],
    );
    expect(
      rows(db, "window_readings", "window, session_id").map((r) => [
        r["window"],
        r["session_id"],
        r["observed_via"],
        r["observed_at_utc"],
      ]),
    ).toEqual([
      ["five_hour", "q", "capture", "2026-09-03T10:00:01.000Z"],
      ["five_hour", "r", "capture", "2026-09-03T10:00:00.000Z"],
      ["seven_day", "r", "last_request", "2026-09-03T08:00:00.000Z"],
    ]);
  });

  it("treats readings during one streamed response as one observation, dated by its first line (D-045)", () => {
    const db = ingest(
      {
        "-p/r.jsonl": [
          // One response (message msg-m1) written as three cumulative snapshots.
          request("r", "m1", null, "2026-09-03T10:00:00.200Z", { usage: { output_tokens: 10 } }),
          request("r", "m1", null, "2026-09-03T10:00:02.000Z", { usage: { output_tokens: 20 } }),
          request("r", "m1", null, "2026-09-03T10:00:04.000Z", { usage: { output_tokens: 30 } }),
        ],
      },
      [reading("10:00:01", 5), reading("10:00:03", 5), reading("10:00:05", 5)],
    );
    expect(
      rows(db, "window_readings").map((r) => [r["observed_at_utc"], r["captured_at_utc"]]),
    ).toEqual([["2026-09-03T10:00:00.200Z", "2026-09-03T10:00:05.000Z"]]);
  });

  it("counts every response with a line between two observations, not only responses that finished inside", () => {
    const db = ingest(
      {
        "-p/r.jsonl": [
          request("r", "a", null, "2026-09-03T10:00:00Z", { usage: { output_tokens: 1 } }),
          request("r", "a", null, "2026-09-03T10:00:05Z", { usage: { output_tokens: 9 } }),
          request("r", "b", "a", "2026-09-03T11:00:00Z", { usage: { output_tokens: 1 } }),
          request("r", "b", "a", "2026-09-03T11:00:05Z", { usage: { output_tokens: 9 } }),
        ],
      },
      // Captured while b was still streaming: b's winning line (11:00:05) is after 11:00:01.
      [reading("10:00:01", 5), reading("11:00:01", 9)],
    );
    // [10:00:00, 11:00:01) holds lines of a and b: 2 responses.
    expect(
      rows(db, "window_reading_pairs").map((p) => [p["observed_at_utc"], p["requests_between"]]),
    ).toEqual([["2026-09-03T11:00:00.000Z", 2]]);
  });

  it("treats an unkeyed request line as its own response", () => {
    const db = ingest(
      {
        "-p/r.jsonl": [
          {
            type: "assistant",
            sessionId: "r",
            timestamp: "2026-09-03T10:00:00Z",
            message: { model: "claude-sonnet-5", usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ],
      },
      [reading("10:00:01", 5), reading("10:00:30", 5)],
    );
    expect(
      rows(db, "window_readings").map((r) => [r["observed_via"], r["observed_at_utc"]]),
    ).toEqual([["last_request", "2026-09-03T10:00:00.000Z"]]);
  });

  it("dates a status line limit group by its first observation at 100%", () => {
    const db = ingest({ "-p/r.jsonl": [request("r", "r1", null, "2026-09-03T12:00:00Z")] }, [
      reading("12:05:00", 100, "five_hour", "2026-09-03T15:00:00Z"),
      reading("12:10:00", 100, "five_hour", "2026-09-03T15:00:00Z"),
    ]);
    expect(
      rows(db, "status_limit_groups").map((g) => [g["first_at_utc"], g["readings_at_limit"]]),
    ).toEqual([["2026-09-03T12:00:00.000Z", 1]]);
  });

  it("says in explain whether an observation came from a response or a capture", () => {
    const db = ingest({ "-p/r.jsonl": [request("r", "r1", null, "2026-09-03T10:00:00Z")] }, [
      reading("10:00:01", 5),
      reading("10:00:02", 6, "five_hour", "2026-09-03T14:00:00Z", "q"),
    ]);
    const descriptions = explain(db, "peak").groups.flatMap((g) =>
      g.events.map((e) => e.description),
    );
    expect(descriptions).toEqual([
      "highest reading: 6% | session q | observed at capture (no request found in the logs)",
    ]);
    const headroom = explain(db, "headroom").groups.flatMap((g) => g.events);
    expect(headroom[0]?.at).toBe("2026-09-03T10:00:02.000Z");
    const r = rows(db, "window_readings").find((w) => w["session_id"] === "r");
    expect(r?.["observed_via"]).toBe("last_request");
    const one = ingest({ "-p/r.jsonl": [request("r", "r1", null, "2026-09-03T10:00:00Z")] }, [
      reading("10:00:01", 5),
    ]);
    expect(explain(one, "headroom").groups[0]?.events[0]?.description).toBe(
      "last reading before the reset: 5% | session r | observed at the session's request before capture 2026-09-03T10:00:01.000Z",
    );
  });
});
