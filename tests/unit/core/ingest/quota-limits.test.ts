/**
 * @file Tests for reading limit hits' quotaLimits (D-067): which source the views take the window
 * and reset from, and the problems recorded where the fields and the text disagree.
 *
 * Every expected value was worked out by hand from fixture 20's setup (fixtures/20-limit-quota-fields/README.md),
 * not by running the views.
 */
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { type Db, openDatabase } from "../../../../core/db/database.js";
import type { EventFields } from "../../../../core/ingest/classify.js";
import { ensureDerived, quotaProblems } from "../../../../core/ingest/derive.js";
import { ingestLogs } from "../../../../core/ingest/ingest.js";

/** Repository root. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Ingests fixture 20 into a fresh in-memory database.
 * @returns The database.
 */
function ingestFixture20(): Db {
  const root = mkdtempSync(join(tmpdir(), "aua-quota-"));
  cpSync(join(ROOT, "fixtures", "20-limit-quota-fields", "projects"), join(root, "projects"), {
    recursive: true,
  });
  const db = openDatabase(":memory:", join(ROOT, "core/schema"));
  ingestLogs(db, {
    roots: [root],
    mode: "incremental",
    now: () => new Date("2026-09-13T00:00:00Z"),
  });
  ensureDerived(db);
  return db;
}

describe("logged_limit_hits prefers quotaLimits and says where each value came from", () => {
  const db = ingestFixture20();
  const rows = db
    .prepare(
      `SELECT l.line_number AS line, h.window, h.reset_at_utc, h.window_source, h.reset_source
       FROM logged_limit_hits h JOIN raw_lines l ON l.id = h.raw_line_id ORDER BY l.line_number`,
    )
    .all();

  it("takes the field when present, the text otherwise, and leaves the rest unknown", () => {
    expect(rows).toEqual([
      // Fields and text agree.
      {
        line: 2,
        window: "five_hour",
        reset_at_utc: "2026-09-02T06:10:00.000Z",
        window_source: "log_field",
        reset_source: "log_field",
      },
      // The text says weekly; the field wins, and the disagreement is reported below.
      {
        line: 3,
        window: "five_hour",
        reset_at_utc: "2026-09-05T09:00:00.000Z",
        window_source: "log_field",
        reset_source: "log_field",
      },
      // Both members unusable, and the text names neither: unknown, still a hit.
      { line: 4, window: null, reset_at_utc: null, window_source: null, reset_source: null },
      // The text resolves to Sep 2 06:10; the field says Sep 5 09:00 and wins.
      {
        line: 5,
        window: "five_hour",
        reset_at_utc: "2026-09-05T09:00:00.000Z",
        window_source: "log_field",
        reset_source: "log_field",
      },
      // quotaLimits is null: the text gives the window, and "2am" has no zone, so no reset.
      {
        line: 6,
        window: "five_hour",
        reset_at_utc: null,
        window_source: "log_text",
        reset_source: null,
      },
      // No quotaLimits, as before 2.1.281: the text, as before. 15:00 UTC, next 6:10am UTC is Sep 2.
      {
        line: 7,
        window: "five_hour",
        reset_at_utc: "2026-09-02T06:10:00.000Z",
        window_source: "log_text",
        reset_source: "log_text",
      },
      // The field fills a window the text doesn't name; resetsAt 0 is unusable.
      {
        line: 8,
        window: "seven_day",
        reset_at_utc: null,
        window_source: "log_field",
        reset_source: null,
      },
    ]);
  });

  it("carries the reset source into the interruption events", () => {
    const sources = db
      .prepare(
        `SELECT l.line_number AS line, e.reset_source FROM obs_limit_hits_events e
         JOIN raw_lines l ON l.id = e.raw_line_id ORDER BY l.line_number`,
      )
      .all();
    expect(sources).toEqual([
      { line: 2, reset_source: "log_field" },
      { line: 3, reset_source: "log_field" },
      { line: 4, reset_source: null },
      { line: 5, reset_source: "log_field" },
      { line: 6, reset_source: null },
      { line: 7, reset_source: "log_text" },
      { line: 8, reset_source: null },
    ]);
  });

  it("records each disagreement and unusable member as a line problem, with both values", () => {
    const problems = db
      .prepare(
        `SELECT l.line_number AS line, x.problem, x.detail FROM line_problems x
         JOIN raw_lines l ON l.id = x.raw_line_id ORDER BY l.line_number, x.id`,
      )
      .all();
    expect(problems).toEqual([
      {
        line: 3,
        problem: "quota_window_disagrees",
        detail: "quotaLimits=five_hour text=seven_day",
      },
      { line: 4, problem: "unusable_quota_field", detail: "rateLimitType" },
      { line: 4, problem: "unusable_quota_field", detail: "resetsAt" },
      {
        line: 5,
        problem: "quota_reset_disagrees",
        detail: "quotaLimits=2026-09-05T09:00:00.000Z text=2026-09-02T06:10:00.000Z",
      },
      { line: 6, problem: "unusable_quota_field", detail: "quotaLimits" },
      { line: 8, problem: "unusable_quota_field", detail: "resetsAt" },
    ]);
  });
});

describe("quotaProblems", () => {
  /**
   * Builds limit-hit event fields.
   * @param window - Window from the text.
   * @param quota - The quotaLimits reading.
   * @returns Event fields.
   */
  function event(window: EventFields["window"], quota: EventFields["quota"]): EventFields {
    return {
      error: "rate_limit",
      apiErrorStatus: 429,
      window,
      resetText: null,
      quota,
      unknownErrorKey: null,
      retryRateLimitsPresent: false,
    };
  }

  it("treats resets less than a minute apart as agreeing, since reset text has minute precision", () => {
    const quota = { window: null, resetsAtUtc: "2026-09-02T06:10:59.000Z", unusable: [] };
    expect(quotaProblems(event(null, quota), "2026-09-02T06:10:00.000Z")).toEqual([]);
    const later = { ...quota, resetsAtUtc: "2026-09-02T06:11:00.000Z" };
    expect(quotaProblems(event(null, later), "2026-09-02T06:10:00.000Z")).toEqual([
      [
        "quota_reset_disagrees",
        "quotaLimits=2026-09-02T06:11:00.000Z text=2026-09-02T06:10:00.000Z",
      ],
    ]);
  });

  it("compares nothing when either side is unknown", () => {
    const quota = {
      window: "five_hour" as const,
      resetsAtUtc: "2026-09-02T06:10:00.000Z",
      unusable: [],
    };
    expect(quotaProblems(event(null, quota), null)).toEqual([]);
    const none = { window: null, resetsAtUtc: null, unusable: [] };
    expect(quotaProblems(event("seven_day", none), "2026-09-02T06:10:00.000Z")).toEqual([]);
  });
});
