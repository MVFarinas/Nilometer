/**
 * @file A synthetic database exercising every section of the report, for viewer tests.
 *
 * Built from the metric test helpers: logs with a mid-task limit hit and a resumption, a weekly
 * limit hit with no later request, requests in two repositories and four models (one unpriced),
 * status line readings for an open 5-hour window, a closed one, and a weekly window whose usage
 * rises between two readings with no request in between, and a plan price. Times are chosen for
 * America/Chicago.
 */
import type { Db } from "../../../core/db/database.js";
import { resolveRepositories } from "../../../core/ingest/attribution.js";
import { setPlanPrice } from "../../../core/plans/plan-prices.js";
import { hit, ingest, now, request, toolResult, user } from "../core/metrics/helpers.js";

/** The zone the fixture's times are chosen for. */
export const FIXTURE_TIME_ZONE = "America/Chicago";

/**
 * Builds the fixture database. Call with `process.env.TZ` set to {@link FIXTURE_TIME_ZONE} so SQL
 * month buckets match.
 * @returns The database.
 */
export function buildReportFixture(): Db {
  const db = ingest(
    {
      "-work-app/sa.jsonl": [
        user("sa", "a1", null, "2026-09-01T14:00:00Z", { cwd: "/work/app" }),
        request("sa", "a2", "a1", "2026-09-01T14:00:10Z", {
          cwd: "/work/app",
          model: "claude-opus-5",
          usage: {
            input_tokens: 1200,
            output_tokens: 3400,
            cache_read_input_tokens: 56000,
            cache_creation: { ephemeral_5m_input_tokens: 700, ephemeral_1h_input_tokens: 8900 },
          },
        }),
        toolResult("sa", "a3", "a2", "2026-09-01T14:00:20Z"),
        hit(
          "sa",
          "a4",
          "a3",
          "2026-09-01T14:00:30Z",
          "You've hit your session limit · resets 11am (America/Chicago)",
        ),
        user("sa", "a5", "a4", "2026-09-01T16:30:00Z", { cwd: "/work/app" }),
        request("sa", "a6", "a5", "2026-09-01T16:30:05Z", {
          cwd: "/work/app",
          usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 300 },
        }),
      ],
      "-work-tool/sc.jsonl": [
        user("sc", "c1", null, "2026-09-02T19:59:50Z", { cwd: "/work/tool" }),
        hit(
          "sc",
          "c2",
          "c1",
          "2026-09-02T20:00:00Z",
          "You've hit your weekly limit · resets Sep 6, 7pm (America/Chicago)",
        ),
      ],
      "-work-tool/sb.jsonl": [
        request("sb", "b1", null, "2026-08-20T15:00:00Z", {
          cwd: "/work/tool",
          model: "claude-haiku-4-5",
          usage: { input_tokens: 10, output_tokens: 20 },
        }),
        request("sb", "b2", "b1", "2026-09-02T15:00:00Z", {
          cwd: "/work/tool",
          model: "claude-experimental-x",
          usage: { input_tokens: 5, output_tokens: 5 },
        }),
      ],
    },
    [
      {
        at: "2026-09-02T14:00:00Z",
        session: "sb",
        window: "five_hour",
        used: 20,
        resets: "2026-09-02T17:00:00Z",
      },
      {
        at: "2026-09-02T15:00:00Z",
        session: "sb",
        window: "five_hour",
        used: 35.5,
        resets: "2026-09-02T17:00:00Z",
      },
      {
        at: "2026-09-02T15:00:00Z",
        session: "sb",
        window: "seven_day",
        used: 12,
        resets: "2026-09-07T00:00:00Z",
      },
      {
        at: "2026-09-02T18:00:00Z",
        session: "sb",
        window: "five_hour",
        used: 40,
        resets: "2026-09-02T22:00:00Z",
      },
      // 18:30 → 19:00 has no request in between, so the 2-point rise is unattributed (D-025). A session
      // with no logs ("st") keeps capture time as the observation time (D-044).
      {
        at: "2026-09-02T18:30:00Z",
        session: "st",
        window: "seven_day",
        used: 13,
        resets: "2026-09-07T00:00:00Z",
      },
      {
        at: "2026-09-02T19:00:00Z",
        session: "st",
        window: "seven_day",
        used: 15,
        resets: "2026-09-07T00:00:00Z",
      },
    ],
  );
  resolveRepositories(
    db,
    now,
    (cwd) =>
      cwd === "/work/app"
        ? { kind: "repo", repoRoot: "/work/app" }
        : { kind: "missing", repoRoot: null, via: "none" },
    (path) => path === "/work/app",
  );
  setPlanPrice(db, { month: "2026-09", planName: "Example plan", usdPerMonth: 100 }, now);
  return db;
}
