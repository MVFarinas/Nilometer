/**
 * @file Unit tests for viewer/render.ts (docs/development.md P7.1).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadObserved, loadProjected } from "../../../viewer/queries.js";
import type { BurnRateRow } from "../../../viewer/queries.js";
import {
  LABELS,
  type ReportInput,
  describeBurnRate,
  displayPath,
  plural,
  renderObserved,
  renderProjected,
  renderReport,
  renderTable,
  repoKindName,
  reportJson,
  windowName,
} from "../../../viewer/render.js";
import { ingest } from "../core/metrics/helpers.js";
import { FIXTURE_TIME_ZONE, buildReportFixture } from "./fixture.js";

describe("small renderers", () => {
  it("lays out a table with right-aligned numbers and no trailing spaces", () => {
    expect(
      renderTable(
        ["Name", "N"],
        [
          ["a", "1"],
          ["long name", "1,000"],
        ],
        ["left", "right"],
      ),
    ).toEqual([
      "  Name           N",
      "  ---------  -----",
      "  a              1",
      "  long name  1,000",
    ]);
  });

  it("names windows, repository kinds, plurals, and home paths", () => {
    expect([windowName("five_hour"), windowName("seven_day"), windowName("spend_limit")]).toEqual([
      "5-hour",
      "weekly",
      "spend_limit",
    ]);
    expect(["repo", "not_git", "missing", "unresolved"].map(repoKindName)).toEqual([
      "git repository",
      "not a git repository",
      "directory no longer exists",
      "not resolved yet",
    ]);
    expect([
      plural(1, "hit", "hits"),
      plural(0, "hit", "hits"),
      plural(2000, "hit", "hits"),
      plural(null, "hit", "hits"),
    ]).toEqual(["1 hit", "0 hits", "2,000 hits", "unknown hits"]);
    expect(displayPath("/home/example/work", "/home/example")).toBe("~/work");
    expect(displayPath("/home/example", "/home/example")).toBe("~");
    // A sibling whose name starts with the home directory's name isn't under it.
    expect(displayPath("/work/app-other/x", "/work/app")).toBe("/work/app-other/x");
    expect(displayPath("/work/app", "")).toBe("/work/app");
    // Windows (D-049): a backslash path, a git root with "/", and a lowercase drive letter all
    // shorten; the remainder keeps its own separators.
    const windowsHome = "C:\\Users\\example";
    expect(displayPath("C:\\Users\\example\\.local\\share", windowsHome)).toBe("~\\.local\\share");
    expect(displayPath("C:/Users/example/Projects/app", windowsHome)).toBe("~/Projects/app");
    expect(displayPath("c:\\Users\\example\\gone", windowsHome)).toBe("~\\gone");
    expect(displayPath("C:\\Users\\example", windowsHome)).toBe("~");
    expect(displayPath("C:\\Users\\example-other\\x", windowsHome)).toBe(
      "C:\\Users\\example-other\\x",
    );
    expect(displayPath("D:\\Users\\example\\x", windowsHome)).toBe("D:\\Users\\example\\x");
  });

  it("describes each burn rate outcome, never as advice", () => {
    const base: BurnRateRow = {
      window: "five_hour",
      reset_at_utc: "2026-09-02T22:00:00.000Z",
      window_start_utc: "2026-09-02T17:00:00.000Z",
      last_used_percentage: 40,
      last_reading_at_utc: "2026-09-02T18:00:00.000Z",
      window_open: 1,
      limit_reached: 0,
      projected_percentage_points_per_hour: 40,
      projected_limit_at_utc: "2026-09-02T19:30:00.000Z",
      projected_limit_before_reset: 1,
      covers_from: null,
      covers_to: null,
    };
    const tz = FIXTURE_TIME_ZONE;
    expect(describeBurnRate(base, tz)).toBe(
      "  5-hour window resetting 2026-09-02 17:00: 40% at 2026-09-02 13:00; projected 40 percentage points per hour; limit projected for 2026-09-02 14:30, before the reset.",
    );
    expect(describeBurnRate({ ...base, projected_limit_before_reset: 0 }, tz)).toMatch(
      /after the reset\.$/,
    );
    expect(describeBurnRate({ ...base, projected_limit_at_utc: null }, tz)).toMatch(
      /projected limit time unknown\.$/,
    );
    expect(describeBurnRate({ ...base, limit_reached: 1 }, tz)).toMatch(
      /limit reached at that reading\.$/,
    );
  });
});

describe("renderObserved and renderProjected on an empty database", () => {
  it("says there's no data instead of showing zeros as findings", () => {
    const db = ingest({});
    const observed = renderObserved(loadObserved(db), "UTC").join("\n");
    expect(observed).toContain("Covers: session logs no data yet; status line no data yet");
    expect(observed).toContain(`  ${LABELS.noReadings}`);
    expect(LABELS.noReadings).toMatch(/^No status line readings yet\. .*terminal/);
    expect(observed).toContain("No Claude Code requests in the logs yet.");
    const projected = renderProjected(loadProjected(db), "UTC").join("\n");
    expect(projected).toContain("No open usage window in the status line readings.");
    expect(projected).toContain("No Claude Code requests in the logs yet.");
  });
});

describe("renderReport on the fixture database", () => {
  let input: ReportInput;
  const originalTz = process.env["TZ"];

  beforeAll(() => {
    process.env["TZ"] = FIXTURE_TIME_ZONE;
    const db = buildReportFixture();
    input = {
      observed: loadObserved(db),
      projected: loadProjected(db),
      timeZone: FIXTURE_TIME_ZONE,
      lastIngestAt: "2026-09-13T00:00:00.000Z",
      databasePath: "/home/example/.local/share/nilometer/usage.db",
      home: "/home/example",
    };
  });

  afterAll(() => {
    if (originalTz === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = originalTz;
    }
  });

  it("prints observations first and projections after, in a separately labeled section", () => {
    const text = renderReport(input);
    const observedAt = text.indexOf(`\n${LABELS.observed}\n`);
    const projectedAt = text.indexOf(`\n${LABELS.projected}\n`);
    expect(observedAt).toBeGreaterThan(0);
    expect(projectedAt).toBeGreaterThan(observedAt);
    // Every projection line sits after the projected heading.
    for (const label of [LABELS.burnRate, LABELS.apiListPrice, LABELS.burnRatePremise]) {
      expect(text.indexOf(label)).toBeGreaterThan(projectedAt);
    }
    for (const label of [
      LABELS.interruptions,
      LABELS.windows,
      LABELS.unattributed,
      LABELS.byModel,
      LABELS.byRepo,
    ]) {
      const at = text.indexOf(label);
      expect(at).toBeGreaterThan(observedAt);
      expect(at).toBeLessThan(projectedAt);
    }
  });

  it("gives every section its coverage and keeps caveats next to their numbers", () => {
    const lines = renderReport(input).split("\n");
    for (const heading of [
      LABELS.interruptions,
      LABELS.windows,
      LABELS.unattributed,
      LABELS.byModel,
      LABELS.byRepo,
      LABELS.burnRate,
    ]) {
      expect(lines[lines.indexOf(heading) + 1]).toMatch(/^ {2}Covers: /);
    }
    const windows = lines.indexOf(LABELS.windows);
    expect(lines.slice(windows, windows + 8).join("\n")).toContain(LABELS.windowsCaveat);
    expect(lines[lines.indexOf(LABELS.apiListPrice) + 1]).toContain(LABELS.apiListPriceScope);
    expect(renderReport(input)).toContain("Times are in America/Chicago.");
  });

  it("matches the reviewed snapshot of the whole screen", () => {
    expect(renderReport(input)).toMatchSnapshot();
  });

  it("keeps observed and projected rows apart in JSON, with the labels", () => {
    const json = reportJson(input) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      "timeZone",
      "lastIngestAt",
      "databasePath",
      "labels",
      "observed",
      "projected",
    ]);
    expect(json["labels"]).toBe(LABELS);
    expect(JSON.stringify(json["observed"])).not.toContain("projected_");
  });
});
