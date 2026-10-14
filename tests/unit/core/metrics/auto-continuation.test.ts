/**
 * @file Claude Code's logged resumption after a lockout (D-077, step G2.4).
 *
 * Every value is worked out by hand from this scenario (UTC). A marker is a user line with isMeta
 * true and origin.kind "auto-continuation" (D-022). It belongs to the latest hit before it in its
 * own session, and through that hit to the hit's lockout interval.
 *
 * | Session | Lines | Expected |
 * |---|---|---|
 * | s1 | hit 2026-09-01 10:00:30 (resets 11:00), marker 11:00:46 | interval 1, 46 s after the reset |
 * | s2 | hit 10:30:00 (resets 11:00, merges into interval 1), marker 11:02:00 | interval 1, 120 s after |
 * | s3 | a marker with no hit in its session | not counted |
 * | s4 | a weekly hit whose reset text doesn't parse (no interval), then a marker | not counted |
 * | s5 | hit 2026-09-02 10:00:00 (resets 11:00), the marker 11:04:15 written in two files | interval 2, counted once, 255 s after |
 */
import { describe, expect, it } from "vitest";

import { explain, resum } from "../../../../viewer/explain.js";
import { loadObserved } from "../../../../viewer/queries.js";
import { autoContinuedText, renderObserved } from "../../../../viewer/render.js";
import { hit, ingest, request, user } from "./helpers.js";

/**
 * Builds Claude Code's own resumption marker.
 * @param session - Session ID.
 * @param uuid - The line's uuid.
 * @param parent - Its parent's uuid.
 * @param at - When it was written.
 * @returns The log line.
 */
function marker(session: string, uuid: string, parent: string, at: string): object {
  return user(session, uuid, parent, at, { isMeta: true, origin: { kind: "auto-continuation" } });
}

/** The 5-hour limit, resetting at 11am UTC. */
const FIVE_HOUR = "You've hit your session limit · resets 11am (UTC)";

describe("Claude Code's logged resumption after a lockout (D-077)", () => {
  const db = ingest({
    "-p/s1.jsonl": [
      user("s1", "s1-u", null, "2026-09-01T10:00:00Z"),
      request("s1", "s1-r", "s1-u", "2026-09-01T10:00:05Z"),
      hit("s1", "s1-h", "s1-r", "2026-09-01T10:00:30Z", FIVE_HOUR),
      marker("s1", "s1-m", "s1-h", "2026-09-01T11:00:46Z"),
      request("s1", "s1-r2", "s1-m", "2026-09-01T11:01:00Z"),
    ],
    "-p/s2.jsonl": [
      hit("s2", "s2-h", null, "2026-09-01T10:30:00Z", FIVE_HOUR),
      marker("s2", "s2-m", "s2-h", "2026-09-01T11:02:00Z"),
    ],
    "-p/s3.jsonl": [marker("s3", "s3-m", "s3-x", "2026-09-01T09:00:00Z")],
    "-p/s4.jsonl": [
      hit(
        "s4",
        "s4-h",
        null,
        "2026-09-01T10:00:00Z",
        "You've hit your weekly limit · resets Sep 6, 7pm (America/Chicago)",
      ),
      marker("s4", "s4-m", "s4-h", "2026-09-01T10:30:00Z"),
    ],
    "-p/s5.jsonl": [
      hit("s5", "s5-h", null, "2026-09-02T10:00:00Z", FIVE_HOUR),
      marker("s5", "s5-m", "s5-h", "2026-09-02T11:04:15Z"),
    ],
    // The same marker line written in a second file of session s5: a copy, counted once.
    "-p/s5-copy.jsonl": [marker("s5", "s5-m", "s5-h", "2026-09-02T11:04:15Z")],
  });

  it("places each marker after the reset of the lockout its session's hit belongs to", () => {
    const events = db
      .prepare(
        "SELECT session_id, interval_number, seconds_after_reset FROM obs_auto_continuation_events ORDER BY continued_at_utc",
      )
      .all();
    expect(events).toEqual([
      // 11:00:46 - 11:00:00.
      { session_id: "s1", interval_number: 1, seconds_after_reset: 46 },
      // 11:02:00 - 11:00:00.
      { session_id: "s2", interval_number: 1, seconds_after_reset: 120 },
      // 11:04:15 - 11:00:00, once though written twice; s3 and s4 follow no lockout.
      { session_id: "s5", interval_number: 2, seconds_after_reset: 255 },
    ]);
  });

  it("counts each lockout's resumed sessions and the first one's delay", () => {
    expect(
      loadObserved(db).lockoutIntervals.map((i) => [
        i.interval_number,
        i.hits,
        i.auto_continuations,
        i.first_auto_continuation_seconds,
      ]),
    ).toEqual([
      [1, 2, 2, 46],
      [2, 1, 1, 255],
    ]);
  });

  it("says so in the report only where a marker was logged", () => {
    const lines = renderObserved(loadObserved(db), "UTC");
    expect(lines.filter((line) => line.includes("resumed by Claude Code"))).toEqual([
      expect.stringContaining(
        "; resumed by Claude Code (logged auto-continuation): 2 sessions, the first 46 s after the reset",
      ),
      expect.stringContaining(
        "; resumed by Claude Code (logged auto-continuation): 1 session, 4 m 15 s after the reset",
      ),
    ]);
    expect(
      autoContinuedText({ auto_continuations: 0, first_auto_continuation_seconds: null }),
    ).toBe("");
  });
  it("lists the markers under explain lockout, adding up to the count the report shows", () => {
    const group = explain(db, "lockout").groups[1];
    expect(group?.title).toBe(
      "Sessions Claude Code resumed by itself after a reset (logged auto-continuation)",
    );
    // s1, s2, and s5's markers: 3, as interval 1 (2) and interval 2 (1) add up to.
    expect(group?.measures[0]?.reported).toBe(3);
    expect(group === undefined ? null : resum(group, 0)).toBe(3);
    expect(group?.events.map((e) => e.description)).toEqual([
      "auto-continuation | 46 s after the reset at 2026-09-01T11:00:00.000Z | session s1",
      "auto-continuation | 2 m 0 s after the reset at 2026-09-01T11:00:00.000Z | session s2",
      "auto-continuation | 4 m 15 s after the reset at 2026-09-02T11:00:00.000Z | session s5",
    ]);
  });
});
