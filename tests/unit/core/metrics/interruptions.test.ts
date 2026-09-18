/**
 * @file Tests for the interruption metric views (docs/development.md P6.1, D-004, D-021, D-022, D-023).
 *
 * The scenario below was worked out on paper before running any view; each expected value's
 * arithmetic is written next to it. Four sessions:
 *
 * - **sa** (logs, before init): a prompt, a tool call, and a limit hit answering the tool result
 *   (mid-task). The user retries: a prompt and a second hit (turn start). The second hit line is
 *   also copied into another file. After the 11:00 reset, a prompt and a request (resumed).
 * - **sb** (logs): a weekly hit answering a meta line; its reset text has a date, so it stays
 *   unknown. Nothing follows (not resumed).
 * - **sc** (logs and status line): a request, readings at 90%, 100%, 100%, then a logged hit
 *   answering a tool result inside that 5-hour window (merged with the readings), then a request
 *   after the reset (resumed).
 * - **sd** (status line only, after the logs end): a weekly window at 100%, no requests.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../../../core/db/database.js";
import {
  type LogFiles,
  type Reading,
  hit,
  ingest,
  request,
  rows,
  summary,
  toolResult,
  user,
} from "./helpers.js";

/** The retried hit in session sa, written twice. */
const SA_RETRY_HIT = hit(
  "sa",
  "a6",
  "a5",
  "2026-09-01T09:10:05Z",
  "You've hit your session limit · resets 11am (UTC)",
);

/** The scenario's log files. */
const SCENARIO_FILES: LogFiles = {
  "-p/sa.jsonl": [
    user("sa", "a1", null, "2026-09-01T09:00:00Z"),
    request("sa", "a2", "a1", "2026-09-01T09:00:10Z"),
    toolResult("sa", "a3", "a2", "2026-09-01T09:00:20Z"),
    hit(
      "sa",
      "a4",
      "a3",
      "2026-09-01T09:00:30Z",
      "You've hit your session limit · resets 11am (UTC)",
    ),
    user("sa", "a5", "a4", "2026-09-01T09:10:00Z"),
    SA_RETRY_HIT,
    user("sa", "a7", "a6", "2026-09-01T11:30:00Z"),
    request("sa", "a8", "a7", "2026-09-01T11:30:05Z"),
  ],
  "-p/sa-copy.jsonl": [SA_RETRY_HIT],
  "-p/sb.jsonl": [
    user("sb", "b1", null, "2026-09-02T10:00:00Z", { isMeta: true, origin: undefined }),
    hit(
      "sb",
      "b2",
      "b1",
      "2026-09-02T10:00:01Z",
      "You've hit your weekly limit · resets Sep 5, 9am (UTC)",
    ),
  ],
  "-p/sc.jsonl": [
    user("sc", "c0", null, "2026-09-03T11:59:50Z"),
    request("sc", "c1", "c0", "2026-09-03T12:00:00Z"),
    // Each status line reading follows a response in its session (D-044): 12:30:00 and 12:40:00.
    request("sc", "c1b", "c1", "2026-09-03T12:29:59Z"),
    request("sc", "c1c", "c1b", "2026-09-03T12:39:59Z"),
    toolResult("sc", "c2", "c1c", "2026-09-03T12:44:59Z"),
    hit(
      "sc",
      "c3",
      "c2",
      "2026-09-03T12:45:00Z",
      "You've hit your session limit · resets 3pm (UTC)",
    ),
    user("sc", "c4", "c3", "2026-09-03T15:19:55Z"),
    request("sc", "c5", "c4", "2026-09-03T15:20:00Z"),
  ],
};

/** The scenario's status line readings. */
const SCENARIO_READINGS: readonly Reading[] = [
  {
    at: "2026-09-03T12:00:01Z",
    session: "sc",
    window: "five_hour",
    used: 90,
    resets: "2026-09-03T15:00:00Z",
  },
  {
    at: "2026-09-03T12:30:00Z",
    session: "sc",
    window: "five_hour",
    used: 100,
    resets: "2026-09-03T15:00:00Z",
  },
  {
    at: "2026-09-03T12:40:00Z",
    session: "sc",
    window: "five_hour",
    used: 100,
    resets: "2026-09-03T15:00:00Z",
  },
  {
    at: "2026-09-04T08:00:00Z",
    session: "sd",
    window: "seven_day",
    used: 100,
    resets: "2026-09-10T00:00:00Z",
  },
];

describe("interruption metrics: hand-computed scenario", () => {
  let db: Db;

  beforeAll(() => {
    db = ingest(SCENARIO_FILES, SCENARIO_READINGS);
  });

  it("covers the log span and the status line span separately", () => {
    // First log line sa/a1; last log line sc/c5. Status line observations (D-044) from sc's 12:00:00 response
    // to sd's 08:00 capture on 09-04 (sd has no logs, so capture time).
    expect(rows(db, "source_coverage")).toEqual([
      {
        source: "session_logs",
        covers_from: "2026-09-01T09:00:00.000Z",
        covers_to: "2026-09-03T15:20:00.000Z",
      },
      {
        source: "status_line",
        covers_from: "2026-09-03T12:00:00.000Z",
        covers_to: "2026-09-04T08:00:00.000Z",
      },
    ]);
  });

  it("lists each interruption once, merged across sources", () => {
    const events = rows(db, "obs_limit_hits_events", "hit_at_utc").map((e) => ({
      source: e["source"],
      session: e["session_id"],
      hit: e["hit_at_utc"],
      window: e["window"],
      reset: e["reset_at_utc"],
      resetSource: e["reset_source"],
      position: e["position"],
      toReset: e["hit_to_reset_seconds"],
      nextRequest: e["next_session_request_at_utc"],
      nextPromptOrigin: e["next_session_prompt_origin_kind"],
      afterCoverage: e["reset_after_coverage"],
    }));
    expect(events).toEqual([
      // 09:00:30 → 11:00:00 = 2h − 30s = 7170 s. Next request in sa: a8 at 11:30:05. Next prompt a5.
      {
        source: "session_log",
        session: "sa",
        hit: "2026-09-01T09:00:30.000Z",
        window: "five_hour",
        reset: "2026-09-01T11:00:00.000Z",
        resetSource: "log_text",
        position: "mid_task",
        toReset: 7170,
        nextRequest: "2026-09-01T11:30:05.000Z",
        nextPromptOrigin: "human",
        afterCoverage: 0,
      },
      // 09:10:05 → 11:00:00 = 1h 49m 55s = 6595 s. The copy in sa-copy.jsonl isn't a second row.
      {
        source: "session_log",
        session: "sa",
        hit: "2026-09-01T09:10:05.000Z",
        window: "five_hour",
        reset: "2026-09-01T11:00:00.000Z",
        resetSource: "log_text",
        position: "turn_start",
        toReset: 6595,
        nextRequest: "2026-09-01T11:30:05.000Z",
        nextPromptOrigin: "human",
        afterCoverage: 0,
      },
      // Reset text with a date isn't resolved; the parent is a meta line, so the position is unknown.
      {
        source: "session_log",
        session: "sb",
        hit: "2026-09-02T10:00:01.000Z",
        window: "seven_day",
        reset: null,
        resetSource: null,
        position: "unknown",
        toReset: null,
        nextRequest: null,
        nextPromptOrigin: null,
        afterCoverage: null,
      },
      // Inside (10:00, 15:00] of the five_hour group → merged; 12:45 → 15:00 = 8100 s. c4 has origin human.
      {
        source: "session_log",
        session: "sc",
        hit: "2026-09-03T12:45:00.000Z",
        window: "five_hour",
        reset: "2026-09-03T15:00:00.000Z",
        resetSource: "status_line",
        position: "mid_task",
        toReset: 8100,
        nextRequest: "2026-09-03T15:20:00.000Z",
        nextPromptOrigin: "human",
        afterCoverage: 0,
      },
      // Status line only: 09-04 08:00 → 09-10 00:00 = 5 d 16 h = 136 h = 489600 s; reset after logs end (09-03 15:20).
      // Its window is (09-03 00:00, 09-10 00:00], so sb's weekly hit on 09-02 is outside it and isn't merged.
      {
        source: "status_line",
        session: "sd",
        hit: "2026-09-04T08:00:00.000Z",
        window: "seven_day",
        reset: "2026-09-10T00:00:00.000Z",
        resetSource: "status_line",
        position: "unknown",
        toReset: 489600,
        nextRequest: null,
        nextPromptOrigin: null,
        afterCoverage: 1,
      },
    ]);
  });

  it("counts interruptions: 4 logged (one copy collapsed) + 1 status line only", () => {
    expect(summary(db, "obs_limit_hits")).toEqual({
      hits: 5,
      logged_hits: 4,
      status_line_only_hits: 1,
      five_hour_hits: 3, // sa ×2, sc
      seven_day_hits: 2, // sb, sd
      unknown_window_hits: 0,
      covers_from: "2026-09-01T09:00:00.000Z",
      covers_to: "2026-09-03T15:20:00.000Z",
      status_line_covers_from: "2026-09-03T12:00:00.000Z",
      status_line_covers_to: "2026-09-04T08:00:00.000Z",
    });
    // Traceability: the events re-count to the number.
    expect(rows(db, "obs_limit_hits_events")).toHaveLength(5);
  });

  it("counts the status line group once with its readings at 100%", () => {
    // Observed at c1b 12:29:59 and c1c 12:39:59, both 100% with resets_at 15:00; the 90% one (c1) isn't a hit.
    expect(
      rows(db, "status_limit_groups", "first_at_utc").map((g) => [
        g["window"],
        g["first_at_utc"],
        g["readings_at_limit"],
      ]),
    ).toEqual([
      ["five_hour", "2026-09-03T12:29:59.000Z", 2],
      ["seven_day", "2026-09-04T08:00:00.000Z", 1],
    ]);
  });

  it("counts mid-task interruptions beside turn-start and unknown positions", () => {
    expect(summary(db, "obs_mid_task_interruptions")).toEqual({
      mid_task: 2, // sa a4, sc c3
      turn_start: 1, // sa a6
      position_unknown: 2, // sb (meta parent), sd (status line only)
      covers_from: "2026-09-01T09:00:00.000Z",
      covers_to: "2026-09-03T15:20:00.000Z",
    });
    expect(rows(db, "obs_mid_task_interruptions_events").map((e) => e["session_id"])).toEqual([
      "sa",
      "sc",
    ]);
  });

  it("merges overlapping hit → reset spans into lockout intervals", () => {
    expect(rows(db, "obs_lockout_intervals", "interval_number")).toEqual([
      // sa: 09:00:30 → 11:00:00 (the 09:10:05 span lies inside) = 7170 s; next request 11:30:05 = +1805 s.
      {
        interval_number: 1,
        locked_from_utc: "2026-09-01T09:00:30.000Z",
        locked_until_utc: "2026-09-01T11:00:00.000Z",
        hits: 2,
        next_request_at_utc: "2026-09-01T11:30:05.000Z",
        lockout_seconds: 7170,
        reset_to_next_request_seconds: 1805,
        reset_after_coverage: 0,
      },
      // sc: 12:45:00 → 15:00:00 = 8100 s; next request 15:20:00 = +1200 s.
      {
        interval_number: 2,
        locked_from_utc: "2026-09-03T12:45:00.000Z",
        locked_until_utc: "2026-09-03T15:00:00.000Z",
        hits: 1,
        next_request_at_utc: "2026-09-03T15:20:00.000Z",
        lockout_seconds: 8100,
        reset_to_next_request_seconds: 1200,
        reset_after_coverage: 0,
      },
      // sd: 489600 s; no request after, and the reset is after the logs end.
      {
        interval_number: 3,
        locked_from_utc: "2026-09-04T08:00:00.000Z",
        locked_until_utc: "2026-09-10T00:00:00.000Z",
        hits: 1,
        next_request_at_utc: null,
        lockout_seconds: 489600,
        reset_to_next_request_seconds: null,
        reset_after_coverage: 1,
      },
    ]);
  });

  it("totals lockout time without double-counting, with unknown resets counted apart", () => {
    // 7170 + 8100 + 489600 = 504870 s. Known resets: sa ×2, sc, sd. Unknown: sb.
    expect(summary(db, "obs_lockout_time")).toEqual({
      intervals: 3,
      lockout_seconds: 504870,
      hits_with_known_reset: 4,
      hits_with_unknown_reset: 1,
      covers_from: "2026-09-01T09:00:00.000Z",
      covers_to: "2026-09-03T15:20:00.000Z",
    });
    // Traceability: intervals re-sum to the total, and each interval re-derives from its hits.
    const intervals = rows(db, "obs_lockout_intervals");
    expect(intervals.reduce((sum, i) => sum + (i["lockout_seconds"] as number), 0)).toBe(504870);
    const byInterval = db
      .prepare(
        "SELECT interval_number, MIN(start_utc) AS f, MAX(end_utc) AS u, COUNT(*) AS n FROM obs_lockout_interval_hits GROUP BY interval_number ORDER BY 1",
      )
      .all() as { f: string; u: string; n: number }[];
    expect(byInterval.map((i) => [i.f, i.u, i.n])).toEqual(
      intervals.map((i) => [i["locked_from_utc"], i["locked_until_utc"], i["hits"]]),
    );
  });

  it("lists sessions whose last hit has no later request", () => {
    expect(rows(db, "obs_sessions_not_resumed_events", "session_id")).toEqual([
      {
        session_id: "sb",
        last_hit_raw_line_id: expect.any(Number) as number,
        last_hit_at_utc: "2026-09-02T10:00:01.000Z",
        reset_at_utc: null,
        reset_after_coverage: null,
        hits: 1,
      },
      {
        session_id: "sd",
        last_hit_raw_line_id: expect.any(Number) as number,
        last_hit_at_utc: "2026-09-04T08:00:00.000Z",
        reset_at_utc: "2026-09-10T00:00:00.000Z",
        reset_after_coverage: 1,
        hits: 1,
      },
    ]);
    expect(summary(db, "obs_sessions_not_resumed")).toEqual({
      sessions_with_hits: 4, // sa, sb, sc, sd
      sessions_not_resumed: 2, // sb, sd
      reset_after_coverage: 1, // sd
      reset_unknown: 1, // sb
      covers_from: "2026-09-01T09:00:00.000Z",
      covers_to: "2026-09-03T15:20:00.000Z",
    });
  });
});

describe("interruption metrics: edge cases", () => {
  it("returns zero counts and unknown coverage for an empty database", () => {
    const db = ingest({});
    expect(summary(db, "obs_limit_hits")).toMatchObject({
      hits: 0,
      covers_from: null,
      covers_to: null,
    });
    expect(summary(db, "obs_mid_task_interruptions")).toMatchObject({
      mid_task: 0,
      covers_from: null,
    });
    expect(summary(db, "obs_lockout_time")).toMatchObject({
      intervals: 0,
      lockout_seconds: 0,
      covers_from: null,
    });
    expect(summary(db, "obs_sessions_not_resumed")).toMatchObject({
      sessions_with_hits: 0,
      sessions_not_resumed: 0,
    });
  });

  it("counts a single hit with no parent, no uuid, and no timestamp as unknown everywhere", () => {
    const db = ingest({
      "-p/s.jsonl": [
        user("s", "u1", null, "2026-09-01T09:00:00Z"),
        hit("s", null, null, null, "You've hit your session limit · resets 11am (UTC)"),
      ],
    });
    expect(rows(db, "obs_limit_hits_events")).toEqual([
      expect.objectContaining({
        hit_at_utc: null,
        reset_at_utc: null,
        position: "unknown",
        hit_to_reset_seconds: null,
      }),
    ]);
    expect(summary(db, "obs_lockout_time")).toMatchObject({
      intervals: 0,
      hits_with_unknown_reset: 1,
    });
    // A hit with no time can't be placed before or after a request, so no session is listed.
    expect(summary(db, "obs_sessions_not_resumed")).toMatchObject({ sessions_with_hits: 0 });
  });

  it("keeps hits without a uuid apart, and collapses copies only within one session", () => {
    const text = "You've hit your session limit · resets 11am (UTC)";
    const db = ingest({
      "-p/a.jsonl": [
        hit("s", null, null, "2026-09-01T09:00:00Z", text),
        hit("s", "same", null, "2026-09-01T09:05:00Z", text),
      ],
      "-p/b.jsonl": [
        hit("s", null, null, "2026-09-01T09:00:00Z", text),
        hit("other", "same", null, "2026-09-01T09:05:00Z", text),
      ],
    });
    // Two uuid-less lines (one per file) stay two; "same" in two sessions stays two.
    expect(summary(db, "obs_limit_hits")).toMatchObject({ hits: 4 });
  });

  it("merges a hit with an unknown window into the status line group it falls inside", () => {
    const db = ingest(
      { "-p/s.jsonl": [hit("s", "h", null, "2026-09-03T12:45:00Z", "Limit reached")] },
      [
        {
          at: "2026-09-03T12:30:00Z",
          session: "s",
          window: "seven_day",
          used: 100,
          resets: "2026-09-05T00:00:00Z",
        },
      ],
    );
    expect(rows(db, "obs_limit_hits_events")).toEqual([
      expect.objectContaining({
        source: "session_log",
        window: "seven_day",
        reset_source: "status_line",
      }),
    ]);
  });

  it("doesn't merge a hit outside the group's window, or of another window", () => {
    const text = "You've hit your session limit · resets 11am (UTC)";
    const db = ingest(
      {
        "-p/s.jsonl": [
          // 5 h before a 15:00 reset is 10:00; a hit exactly at 10:00 is outside (10:00, 15:00].
          hit("s", "early", null, "2026-09-03T10:00:00Z", text),
          // A five_hour hit can't merge with a seven_day group.
          hit("s", "weekly", null, "2026-09-03T12:00:00Z", text),
        ],
      },
      [
        {
          at: "2026-09-03T11:00:00Z",
          session: "s",
          window: "five_hour",
          used: 100,
          resets: "2026-09-03T15:00:00Z",
        },
        {
          at: "2026-09-03T11:00:00Z",
          session: "s",
          window: "spend_limit",
          used: 120,
          resets: "2026-09-03T15:00:00Z",
        },
      ],
    );
    // "weekly" (12:00, five_hour) is inside the five_hour group, so it merges; "early" doesn't.
    // The spend_limit window is never a hit. Total: early + weekly(merged) = 2, no status-only rows.
    expect(summary(db, "obs_limit_hits")).toMatchObject({
      hits: 2,
      logged_hits: 2,
      status_line_only_hits: 0,
    });
  });

  it("merges touching spans and keeps an empty span from a reset in the hit's minute", () => {
    const db = ingest({
      "-p/s.jsonl": [
        // 09:00:00 → 10:00 and 10:00:00 → 11:00 touch: one interval of 7200 s.
        hit(
          "s",
          "h1",
          null,
          "2026-09-01T09:00:00Z",
          "You've hit your session limit · resets 10am (UTC)",
        ),
        hit(
          "s",
          "h2",
          null,
          "2026-09-01T10:00:00Z",
          "You've hit your session limit · resets 11am (UTC)",
        ),
        // 12:00:40 with "resets 12pm": the reset resolves to 12:00:00, 40 s before the hit → 0 s.
        hit(
          "s",
          "h3",
          null,
          "2026-09-01T12:00:40Z",
          "You've hit your session limit · resets 12pm (UTC)",
        ),
      ],
    });
    expect(
      rows(db, "obs_lockout_intervals", "interval_number").map((i) => [
        i["hits"],
        i["lockout_seconds"],
      ]),
    ).toEqual([
      [2, 7200],
      [1, 0],
    ]);
  });
});
