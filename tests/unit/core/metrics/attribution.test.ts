/**
 * @file Tests for the attribution views (docs/development.md P6.3, D-001, D-007, D-010, D-025).
 *
 * The scenario was worked out on paper before running any view. Requests on 2026-09-03 UTC:
 *
 * | Request | At | Model | cwd | input / output / cache read | cache writes |
 * |---|---|---|---|---|---|
 * | q1 | 11:59:59.500 | opus-5 | /work/app | 100 / 40 / 1000 | 5m 200, 1h 300 (an earlier snapshot has output 10) |
 * | q2 | 12:30:00 | sonnet-5 | /work/app/sub | 10 / 5 / 0 | unsplit 50 |
 * | q3 | 13:00:00 | sonnet-5 | /work/app-wt | 7 / 3 / 0 | unsplit 0 |
 * | q4 | 14:00:00 | opus-5 | /scratch | 1 / 1 / 0 | unsplit 0 |
 * | q5 | no timestamp | sonnet-5 | none | 2 / 2 / 0 | unsplit 0 |
 * | q6 | 14:30:00 | haiku-4-5 | /gone | 4 / 4 / 0 | unsplit 0 |
 *
 * Repositories (resolver injected): /work/app, its subdirectory, and the worktree /work/app-wt
 * resolve to /work/app; /scratch isn't a git repository; /gone no longer exists.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../../../core/db/database.js";
import { type RepoResolution, resolveRepositories } from "../../../../core/ingest/attribution.js";
import { type Reading, ingest, now, request, rows, summary } from "./helpers.js";

/** Synthetic working directories and how they resolve. */
const RESOLUTIONS: Record<string, RepoResolution> = {
  "/work/app": { kind: "repo", repoRoot: "/work/app" },
  "/work/app/sub": { kind: "repo", repoRoot: "/work/app" },
  "/work/app-wt": { kind: "repo", repoRoot: "/work/app" },
  "/scratch": { kind: "not_git" },
  "/gone": { kind: "missing", repoRoot: null, via: "none" },
};

/** The scenario's requests. */
const FILES = {
  "-work-app/s1.jsonl": [
    request("s1", "q1", null, "2026-09-03T11:59:59.500Z", {
      model: "claude-opus-5",
      cwd: "/work/app",
      usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1000 },
    }),
    request("s1", "q1", null, "2026-09-03T11:59:59.500Z", {
      model: "claude-opus-5",
      cwd: "/work/app",
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 300 },
      },
    }),
    request("s1", "q2", "q1", "2026-09-03T12:30:00Z", {
      cwd: "/work/app/sub",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 50 },
    }),
  ],
  "-work-app-wt/s2.jsonl": [
    request("s2", "q3", null, "2026-09-03T13:00:00Z", {
      cwd: "/work/app-wt",
      usage: { input_tokens: 7, output_tokens: 3 },
    }),
  ],
  "-scratch/s3.jsonl": [
    request("s3", "q4", null, "2026-09-03T14:00:00Z", { model: "claude-opus-5", cwd: "/scratch" }),
    request("s3", "q5", "q4", null, { usage: { input_tokens: 2, output_tokens: 2 } }),
  ],
  "-gone/s4.jsonl": [
    request("s4", "q6", null, "2026-09-03T14:30:00Z", {
      model: "claude-haiku-4-5",
      cwd: "/gone",
      usage: { input_tokens: 4, output_tokens: 4 },
    }),
  ],
};

/**
 * A five_hour reading on 2026-09-03 for the window resetting at 17:00.
 * @param at - `HH:MM:SS` UTC.
 * @param used - used_percentage.
 * @returns The reading.
 */
function fiveHour(at: string, used: number): Reading {
  return {
    at: `2026-09-03T${at}Z`,
    // A session with no logged requests: observed at capture (D-044), so pairs isolate D-025's interval rule.
    session: "st",
    window: "five_hour",
    used,
    resets: "2026-09-03T17:00:00Z",
  };
}

/**
 * Readings. Each pair's interval is [previous capture, capture + 1 s) (D-025):
 * p0→p1 [11:59:00, 12:00:00) holds q1 · p1→p2 [11:59:59, 12:10:01) holds q1 (start widened) ·
 * p2→p3 [12:10:00, 12:20:01) empty, +3 · p3→p4 [12:20:00, 12:25:01) empty, −1 ·
 * p4→p5 [12:25:00, 12:30:01) holds q2 (end widened) · p5→p6 [12:30:00, 12:40:01) holds q2 ·
 * p6→p7 [12:40:00, 12:50:01) empty, +4.5. One seven_day reading alone.
 */
const READINGS: readonly Reading[] = [
  fiveHour("11:59:00", 10),
  fiveHour("11:59:59", 12),
  fiveHour("12:10:00", 15),
  fiveHour("12:20:00", 18),
  fiveHour("12:25:00", 17),
  fiveHour("12:30:00", 21),
  fiveHour("12:40:00", 25.5),
  fiveHour("12:50:00", 30),
  {
    at: "2026-09-03T12:00:00Z",
    session: "st",
    window: "seven_day",
    used: 40,
    resets: "2026-09-10T00:00:00Z",
  },
];

/** Log coverage: q1 to q6 (q5 has no timestamp). */
const LOG_COVERS = {
  covers_from: "2026-09-03T11:59:59.500Z",
  covers_to: "2026-09-03T14:30:00.000Z",
};

describe("attribution: hand-computed scenario", () => {
  let db: Db;

  beforeAll(() => {
    db = ingest(FILES, READINGS);
    resolveRepositories(
      db,
      now,
      (cwd) => RESOLUTIONS[cwd] ?? { kind: "not_git" },
      // Everything but /gone is on the synthetic disk, so nothing is re-resolved as stale.
      (path) => path !== "/gone",
    );
  });

  it("sums tokens per model per token type after dedup, with unknowns", () => {
    expect(rows(db, "obs_usage_by_model", "model")).toEqual([
      // q6 alone.
      {
        model: "claude-haiku-4-5",
        requests: 1,
        input_tokens: 4,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_write_5m_tokens: null,
        cache_write_1h_tokens: null,
        cache_write_unsplit_tokens: 0,
        unkeyed_requests: 0,
        requests_without_timestamp: 0,
        first_request_at_utc: "2026-09-03T14:30:00.000Z",
        last_request_at_utc: "2026-09-03T14:30:00.000Z",
        ...LOG_COVERS,
      },
      // q1 (winner, output 40) + q4: input 100 + 1, output 40 + 1, cache read 1000; only q1 has a split.
      {
        model: "claude-opus-5",
        requests: 2,
        input_tokens: 101,
        output_tokens: 41,
        cache_read_tokens: 1000,
        cache_write_5m_tokens: 200,
        cache_write_1h_tokens: 300,
        cache_write_unsplit_tokens: 0,
        unkeyed_requests: 0,
        requests_without_timestamp: 0,
        first_request_at_utc: "2026-09-03T11:59:59.500Z",
        last_request_at_utc: "2026-09-03T14:00:00.000Z",
        ...LOG_COVERS,
      },
      // q2 + q3 + q5: input 10 + 7 + 2, output 5 + 3 + 2, unsplit 50; q5 has no timestamp.
      {
        model: "claude-sonnet-5",
        requests: 3,
        input_tokens: 19,
        output_tokens: 10,
        cache_read_tokens: 0,
        cache_write_5m_tokens: null,
        cache_write_1h_tokens: null,
        cache_write_unsplit_tokens: 50,
        unkeyed_requests: 0,
        requests_without_timestamp: 1,
        first_request_at_utc: "2026-09-03T12:30:00.000Z",
        last_request_at_utc: "2026-09-03T13:00:00.000Z",
        ...LOG_COVERS,
      },
    ]);
  });

  it("sums tokens per repository, grouping subdirectories and worktrees under one root", () => {
    expect(rows(db, "obs_usage_by_repo", "repository")).toEqual([
      // q5 has no cwd: repository unknown.
      {
        repository: null,
        repo_kind: "unresolved",
        requests: 1,
        input_tokens: 2,
        output_tokens: 2,
        cache_read_tokens: 0,
        cache_write_5m_tokens: null,
        cache_write_1h_tokens: null,
        cache_write_unsplit_tokens: 0,
        requests_without_timestamp: 1,
        ...LOG_COVERS,
      },
      {
        repository: "/gone",
        repo_kind: "missing",
        requests: 1,
        input_tokens: 4,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_write_5m_tokens: null,
        cache_write_1h_tokens: null,
        cache_write_unsplit_tokens: 0,
        requests_without_timestamp: 0,
        ...LOG_COVERS,
      },
      {
        repository: "/scratch",
        repo_kind: "not_git",
        requests: 1,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_5m_tokens: null,
        cache_write_1h_tokens: null,
        cache_write_unsplit_tokens: 0,
        requests_without_timestamp: 0,
        ...LOG_COVERS,
      },
      // q1 + q2 + q3: input 100 + 10 + 7, output 40 + 5 + 3, cache read 1000, 5m 200, 1h 300, unsplit 50 + 0.
      {
        repository: "/work/app",
        repo_kind: "repo",
        requests: 3,
        input_tokens: 117,
        output_tokens: 48,
        cache_read_tokens: 1000,
        cache_write_5m_tokens: 200,
        cache_write_1h_tokens: 300,
        cache_write_unsplit_tokens: 50,
        requests_without_timestamp: 0,
        ...LOG_COVERS,
      },
    ]);
  });

  it("traces model and repository totals to their requests", () => {
    const events = rows(db, "obs_usage_events");
    expect(events).toHaveLength(6);
    for (const [view, key] of [
      ["obs_usage_by_model", "model"],
      ["obs_usage_by_repo", "repository"],
    ] as const) {
      for (const row of rows(db, view)) {
        const mine = events.filter((e) => e[key] === row[key]);
        expect(mine).toHaveLength(row["requests"] as number);
        expect(mine.reduce((sum, e) => sum + (e["output_tokens"] as number), 0)).toBe(
          row["output_tokens"],
        );
        expect(mine.reduce((sum, e) => sum + (e["input_tokens"] as number), 0)).toBe(
          row["input_tokens"],
        );
      }
    }
  });

  it("counts reading pairs and sums rises with no Claude Code request in between", () => {
    expect(
      rows(db, "window_reading_pairs", "observed_at_utc").map((p) => [
        p["observed_at_utc"],
        p["change_percentage_points"],
        p["requests_between"],
      ]),
    ).toEqual([
      ["2026-09-03T11:59:59.000Z", 2, 1],
      ["2026-09-03T12:10:00.000Z", 3, 1],
      ["2026-09-03T12:20:00.000Z", 3, 0],
      ["2026-09-03T12:25:00.000Z", -1, 0],
      ["2026-09-03T12:30:00.000Z", 4, 1],
      ["2026-09-03T12:40:00.000Z", 4.5, 1],
      ["2026-09-03T12:50:00.000Z", 4.5, 0],
    ]);
    expect(rows(db, "obs_unattributed_usage", "window")).toEqual([
      // 8 readings → 7 pairs; without requests: 12:20, 12:25, 12:50; rises among them: 3 + 4.5 = 7.5.
      {
        window: "five_hour",
        reset_at_utc: "2026-09-03T17:00:00.000Z",
        readings: 8,
        pairs: 7,
        pairs_without_requests: 3,
        decreasing_pairs: 1,
        unattributed_percentage_points: 7.5,
        window_open: 1,
        covers_from: "2026-09-03T11:59:00.000Z",
        covers_to: "2026-09-03T12:50:00.000Z",
      },
      // One reading, no pair: unknown, not 0.
      {
        window: "seven_day",
        reset_at_utc: "2026-09-10T00:00:00.000Z",
        readings: 1,
        pairs: 0,
        pairs_without_requests: 0,
        decreasing_pairs: 0,
        unattributed_percentage_points: null,
        window_open: 1,
        covers_from: "2026-09-03T11:59:00.000Z",
        covers_to: "2026-09-03T12:50:00.000Z",
      },
    ]);
    // Traceability: the events re-sum to the number.
    const events = rows(db, "obs_unattributed_usage_events");
    expect(events.map((e) => e["change_percentage_points"])).toEqual([3, 4.5]);
  });
});

describe("attribution: edge cases", () => {
  it("returns no rows for an empty database", () => {
    const db = ingest({});
    expect(rows(db, "obs_usage_by_model")).toEqual([]);
    expect(rows(db, "obs_usage_by_repo")).toEqual([]);
    expect(rows(db, "obs_unattributed_usage")).toEqual([]);
  });

  it("labels unkeyed requests and leaves unresolved working directories as themselves", () => {
    const db = ingest({
      "-p/s.jsonl": [
        {
          type: "assistant",
          sessionId: "s",
          cwd: "/never-resolved",
          timestamp: "2026-09-03T12:00:00Z",
          message: { model: "claude-sonnet-5", usage: { input_tokens: 3, output_tokens: 1 } },
        },
      ],
    });
    expect(summary(db, "obs_usage_by_model")).toMatchObject({ requests: 1, unkeyed_requests: 1 });
    // Before resolution the working directory stands in for the repository.
    expect(summary(db, "obs_usage_by_repo")).toMatchObject({
      repository: "/never-resolved",
      repo_kind: "unresolved",
    });
  });

  it("counts a status line without logs as rises with no request, from init onward", () => {
    const db = ingest({}, [fiveHour("12:00:00", 5), fiveHour("12:05:00", 6)]);
    expect(summary(db, "obs_unattributed_usage")).toMatchObject({
      pairs: 1,
      unattributed_percentage_points: 1,
    });
  });
});
