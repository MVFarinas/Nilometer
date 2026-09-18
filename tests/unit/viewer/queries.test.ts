/**
 * @file Unit tests for viewer/queries.ts (docs/development.md P6.4 structural test, P7.1).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../../core/db/database.js";
import {
  OBSERVED_VIEWS,
  PROJECTED_VIEWS,
  lastIngestAt,
  loadObserved,
  loadProjected,
} from "../../../viewer/queries.js";
import { ingest } from "../core/metrics/helpers.js";
import { FIXTURE_TIME_ZONE, buildReportFixture } from "./fixture.js";

describe("the viewer's query lists", () => {
  it("reads observations only from obs_ views and projections only from proj_ views", () => {
    expect(OBSERVED_VIEWS.filter((view) => !view.startsWith("obs_"))).toEqual([]);
    expect(PROJECTED_VIEWS.filter((view) => !view.startsWith("proj_"))).toEqual([]);
  });

  it("covers every metric view in the schema, so no metric is left off the screen", () => {
    const db = ingest({});
    const views = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all() as { name: string }[]
    ).map((row) => row.name);
    // Event views are the drill-down behind a number (P7.2), not a number of their own.
    const metrics = views.filter(
      (name) =>
        (name.startsWith("obs_") || name.startsWith("proj_")) &&
        !/_events$|_interval_hits$/.test(name),
    );
    expect([...metrics].sort()).toEqual([...OBSERVED_VIEWS, ...PROJECTED_VIEWS].sort());
  });
});

describe("loadObserved, loadProjected, lastIngestAt", () => {
  let db: Db;
  const originalTz = process.env["TZ"];

  beforeAll(() => {
    process.env["TZ"] = FIXTURE_TIME_ZONE;
    db = buildReportFixture();
  });

  afterAll(() => {
    if (originalTz === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = originalTz;
    }
  });

  it("loads observed rows, with headroom and peak side by side, open windows first", () => {
    const observed = loadObserved(db);
    expect(observed.limitHits.hits).toBe(2);
    expect(observed.midTask.mid_task).toBe(1);
    expect(observed.lockoutIntervals).toHaveLength(1);
    expect(
      observed.windows.map((w) => [
        w.window,
        w.window_open,
        w.last_used_percentage,
        w.peak_used_percentage,
      ]),
    ).toEqual([
      ["seven_day", 1, 15, 15],
      ["five_hour", 1, 40, 40],
      ["five_hour", 0, 35.5, 35.5],
    ]);
    expect(observed.byModel[0]?.model).toBe("claude-opus-5");
    expect(observed.byRepo.map((r) => r.repository)).toEqual(["/work/app", "/work/tool"]);
  });

  it("loads projected rows and the last ingest time", () => {
    const projected = loadProjected(db);
    expect(projected.burnRate).toHaveLength(3);
    expect(projected.apiListPrice.map((m) => m.month)).toEqual(["2026-08", "2026-09"]);
    expect(lastIngestAt(db)).toBe("2026-09-13T00:00:00.000Z");
    expect(lastIngestAt(ingest({}))).toBe("2026-09-13T00:00:00.000Z");
  });
});
