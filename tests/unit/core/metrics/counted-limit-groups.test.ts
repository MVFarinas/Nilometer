/**
 * @file A status-line-only limit hit starts from a reading before its window's reset (D-078, step G2.6).
 *
 * No session logs; two 5-hour windows, each read once at 100% by session `s` (no request in the
 * session, so each reading is dated by its capture, D-045). Worked out by hand:
 *
 * | Window resets | At-limit reading | Before its reset? | Status line hit | Lockout |
 * |---|---|---|---|---|
 * | 2026-09-01 10:00 | 10:00:30 | no, 30 s after | none (before D-078: one, of 0 s) | none |
 * | 2026-09-01 15:00 | 14:00:00 | yes | one | 14:00 to 15:00, 3,600 s |
 */
import { describe, expect, it } from "vitest";

import { ingest } from "./helpers.js";

describe("status line limit groups count only readings before the reset (D-078)", () => {
  const db = ingest({}, [
    {
      at: "2026-09-01T10:00:30Z",
      session: "s",
      window: "five_hour",
      used: 100,
      resets: "2026-09-01T10:00:00Z",
    },
    {
      at: "2026-09-01T14:00:00Z",
      session: "s",
      window: "five_hour",
      used: 100,
      resets: "2026-09-01T15:00:00Z",
    },
  ]);

  it("makes a group only from the window read at its limit before the reset", () => {
    const groups = db
      .prepare("SELECT reset_at_utc, first_at_utc, readings_at_limit FROM status_limit_groups")
      .all();
    expect(groups).toEqual([
      {
        reset_at_utc: "2026-09-01T15:00:00.000Z",
        first_at_utc: "2026-09-01T14:00:00.000Z",
        readings_at_limit: 1,
      },
    ]);
  });

  it("counts one status-line-only hit and one lockout of an hour, with no lockout of 0 s", () => {
    const hits = db.prepare("SELECT hits, status_line_only_hits FROM obs_limit_hits").get() as {
      hits: number;
      status_line_only_hits: number;
    };
    expect([hits.hits, hits.status_line_only_hits]).toEqual([1, 1]);
    const intervals = db
      .prepare(
        "SELECT locked_from_utc, locked_until_utc, lockout_seconds FROM obs_lockout_intervals",
      )
      .all();
    expect(intervals).toEqual([
      {
        locked_from_utc: "2026-09-01T14:00:00.000Z",
        locked_until_utc: "2026-09-01T15:00:00.000Z",
        lockout_seconds: 3600,
      },
    ]);
  });
});
