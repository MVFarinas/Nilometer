/**
 * @file Unit tests for viewer/html-data.ts (steps G1.1 and G1.7, D-070).
 *
 * Every expected value is worked out by hand from the scenario it cites: the table in
 * `html-fixture.ts` (the shared G1 fixture), `buildReportFixture` in `fixture.ts`, the README of
 * `fixtures/08-limit-hits` or `fixtures/20-limit-quota-fields`, or the lines a test builds itself,
 * with the arithmetic beside each assertion. Raw line IDs are never guessed: {@link lineId} finds
 * them by file and line number with its own SQL, independent of the module, so the tests say "the
 * reading on spool line 3" rather than "ID 13". A final group checks every number against
 * `loadObserved` and `loadProjected` on every database here, so the page can't disagree with the
 * text report.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Db, openDatabase } from "../../../core/db/database.js";
import type { EventRef, HtmlReportData } from "../../../viewer/html-contract.js";
import { loadHtmlData } from "../../../viewer/html-data.js";
import { lastIngestAt, loadObserved, loadProjected } from "../../../viewer/queries.js";
import { ROOT, hit, ingest, request, user } from "../core/metrics/helpers.js";
import { FIXTURE_TIME_ZONE, buildReportFixture } from "./fixture.js";
import { HTML_FIXTURE_META, buildHtmlFixture } from "./html-fixture.js";

/** The fixture's session log, as stored: relative to its root, under `projects/`. */
const LOG = "projects/-fixture-html/s1.jsonl";

/** The status line spool, as stored: relative to the data directory. */
const SPOOL = "statusline.spool.jsonl";

/**
 * Finds a raw line's ID by where it was read from, with SQL of its own (not the module's).
 * @param db - The fixture database.
 * @param path - The file's stored relative path.
 * @param line - 1-based line number.
 * @returns The raw line ID.
 * @throws {Error} If no such line was stored, so a wrong fixture reading fails loudly.
 */
function lineId(db: Db, path: string, line: number): number {
  const row = db
    .prepare(
      `SELECT l.id FROM raw_lines l JOIN source_files f ON f.id = l.source_file_id
       WHERE f.relative_path = ? AND l.line_number = ?`,
    )
    .get(path, line) as { id: number } | undefined;
  if (row === undefined) {
    throw new Error(`no raw line ${path}:${line}`);
  }
  return row.id;
}

/**
 * Places a time on the fixture day.
 * @param time - `HH:MM:SS` UTC.
 * @returns ISO-8601 UTC with milliseconds, as the views return it.
 */
const at = (time: string): string => `2026-09-03T${time}.000Z`;

/**
 * Sets the process zone for the duration of a describe block, because `proj_api_list_price` groups
 * months with SQLite's `'localtime'` (D-007), so a fixture's months depend on the zone it was
 * written for.
 * @param zone - IANA zone; UTC unless the fixture says otherwise.
 * @returns A function restoring the original zone.
 */
function useZone(zone = "UTC"): () => void {
  const original = process.env["TZ"];
  process.env["TZ"] = zone;
  return (): void => {
    if (original === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = original;
    }
  };
}

/**
 * Ingests a committed fixture's session log, with optional status line readings, through the
 * metric test helper, so it is priced like every other database here.
 * @param fixture - Directory under `fixtures/`, holding `projects/-fixture-demo/<file>`.
 * @param file - The session log's file name.
 * @param readings - Status line readings to spool beside it; the committed fixtures have none.
 * @returns The database.
 */
function ingestFixture(
  fixture: string,
  file: string,
  readings: Parameters<typeof ingest>[1] = [],
): Db {
  const lines = readFileSync(
    join(ROOT, "fixtures", fixture, "projects/-fixture-demo", file),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.length > 0)
    // Parsed and re-written by the helper: the same JSON values, so the same lines to the loader.
    .map((line) => JSON.parse(line) as object);
  return ingest({ [`-fixture-demo/${file}`]: lines }, readings);
}

/** Fixture 20's session log, as stored. */
const F20 = "projects/-fixture-demo/s20.jsonl";

/** Fixture 08's session log, as stored. */
const F08 = "projects/-fixture-demo/s08.jsonl";

/**
 * Fixture 20 (fixtures/20-limit-quota-fields/README.md) with one status line reading added, so its
 * hits have gauge columns to land in. Captured 2026-09-01T10:30:00Z in a session with no requests,
 * so it is observed at capture (D-045): five_hour at 50 resetting 14:00:00, so the column spans
 * (09:00:00, 14:00:00]; seven_day at 30 resetting 2026-09-05T09:00:00Z, spanning
 * (2026-08-29T09:00:00, 2026-09-05T09:00:00]. Both below 100, so no hit merges with the status line.
 * @returns The database.
 */
function fixture20WithStatusLine(): Db {
  return ingestFixture("20-limit-quota-fields", "s20.jsonl", [
    {
      at: "2026-09-01T10:30:00Z",
      session: "s-status",
      window: "five_hour",
      used: 50,
      resets: "2026-09-01T14:00:00Z",
      more: [{ window: "seven_day", used: 30, resets: "2026-09-05T09:00:00Z" }],
    },
  ]);
}

describe("loadHtmlData on the shared HTML fixture (html-fixture.ts)", () => {
  let db: Db;
  let data: HtmlReportData;
  let restore: () => void;
  /** Log line IDs by the fixture's line names; lines are numbered in the table's order, from 1. */
  const log: Record<string, number> = {};
  /** Spool line IDs by capture order, from 1. */
  const spool: number[] = [];

  beforeAll(() => {
    restore = useZone();
    db = buildHtmlFixture();
    data = loadHtmlData(db, HTML_FIXTURE_META);
    ["u1", "r1", "t1", "r2", "t2", "r3", "t3", "h1", "u2", "r4"].forEach((name, index) => {
      log[name] = lineId(db, LOG, index + 1);
    });
    for (let line = 1; line <= 4; line += 1) {
      spool[line] = lineId(db, SPOOL, line);
    }
  });

  afterAll(() => {
    db.close();
    restore();
  });

  it("passes the display zone and production time through, and reads the last ingest", () => {
    expect(data.timeZone).toBe("UTC");
    // HTML_FIXTURE_META.generatedAt is 2026-09-03T14:00:00Z.
    expect(data.generatedAtUtc).toBe("2026-09-03T14:00:00.000Z");
    expect(data.lastIngestAt).not.toBeNull();
    expect(data.lastIngestAt).toBe(lastIngestAt(db));
  });

  it("spans the session logs from the first line to the last, and the status line by observation", () => {
    expect(data.coverage).toEqual([
      // Earliest log line u1 10:00:00; latest r4 13:05:10.
      { source: "session_logs", span: { from: at("10:00:00"), to: at("13:05:10") } },
      // Readings are dated by the response behind them (D-045): the first capture (10:00:06)
      // reports r1 at 10:00:05, the last (13:05:15) reports r4 at 13:05:10.
      { source: "status_line", span: { from: at("10:00:05"), to: at("13:05:10") } },
    ]);
  });

  it("draws one gauge column per window instance, oldest reset first, with peak, last, readings, and hits", () => {
    expect(data.gauge).toEqual([
      {
        // five_hour resetting 13:00: readings 20 (r1 10:00:05), 60 (r2 10:00:20), 103 (r3 11:58:00).
        // The 13:05:15 capture reports the next window, so it isn't one of these.
        window: "five_hour",
        resetAtUtc: at("13:00:00"),
        // A reading was captured at 13:05:15, after the 13:00 reset, so the window has reset.
        open: false,
        // max(20, 60, 103) = 103, above 100 as recorded (D-068); observed at r3, 11:58:00.
        peak: 103,
        peakAtUtc: at("11:58:00"),
        // The latest of the three is also the 103, at 11:58:00.
        last: 103,
        lastAtUtc: at("11:58:00"),
        readings: 3,
        // h1 at 12:00:00 is in (08:00, 13:00] and reads as the session (5-hour) limit, so it merges
        // with the status line group at 103 and takes its exact 13:00:00 reset (D-023): one hit.
        limitHits: 1,
        peakEvents: [spool[3]],
        lastEvents: [spool[3]],
        hitEvents: [log["h1"]],
      },
      {
        // five_hour resetting 18:00: one capture (13:05:15) reports r4 at 13:05:10, used 2.
        window: "five_hour",
        resetAtUtc: at("18:00:00"),
        // 18:00 is after the last capture, 13:05:15.
        open: true,
        peak: 2,
        peakAtUtc: at("13:05:10"),
        last: 2,
        lastAtUtc: at("13:05:10"),
        readings: 1,
        limitHits: 0,
        peakEvents: [spool[4]],
        lastEvents: [spool[4]],
        hitEvents: [],
      },
      {
        // seven_day resetting 2026-09-10: all four captures, 10, 12, 15, 16, observed at
        // 10:00:05, 10:00:20, 11:58:00, 13:05:10.
        window: "seven_day",
        resetAtUtc: "2026-09-10T00:00:00.000Z",
        open: true,
        // max(10, 12, 15, 16) = 16, the last reading too.
        peak: 16,
        peakAtUtc: at("13:05:10"),
        last: 16,
        lastAtUtc: at("13:05:10"),
        readings: 4,
        // h1 is a 5-hour hit, not a weekly one.
        limitHits: 0,
        peakEvents: [spool[4]],
        lastEvents: [spool[4]],
        hitEvents: [],
      },
    ]);
  });

  it("gives each gauge window its series, in the same order, with one point per counted reading", () => {
    expect(data.series).toEqual([
      {
        window: "five_hour",
        resetAtUtc: at("13:00:00"),
        // Each point is dated by the first line of the response it reports (D-045), not its capture.
        points: [
          { atUtc: at("10:00:05"), used: 20, event: spool[1] },
          { atUtc: at("10:00:20"), used: 60, event: spool[2] },
          { atUtc: at("11:58:00"), used: 103, event: spool[3] },
        ],
        hits: [{ atUtc: at("12:00:00"), event: log["h1"] }],
      },
      {
        window: "five_hour",
        resetAtUtc: at("18:00:00"),
        points: [{ atUtc: at("13:05:10"), used: 2, event: spool[4] }],
        hits: [],
      },
      {
        window: "seven_day",
        resetAtUtc: "2026-09-10T00:00:00.000Z",
        points: [
          { atUtc: at("10:00:05"), used: 10, event: spool[1] },
          { atUtc: at("10:00:20"), used: 12, event: spool[2] },
          { atUtc: at("11:58:00"), used: 15, event: spool[3] },
          { atUtc: at("13:05:10"), used: 16, event: spool[4] },
        ],
        hits: [],
      },
    ]);
    data.gauge.forEach((column, index) => {
      expect(data.series[index]?.points).toHaveLength(column.readings);
    });
  });

  it("draws the lockout from the hit to the reset, with reset to next request", () => {
    expect(data.lockouts).toEqual([
      {
        lockedFromUtc: at("12:00:00"),
        lockedUntilUtc: at("13:00:00"),
        // 13:00:00 - 12:00:00 = 3600 s.
        seconds: 3600,
        hits: 1,
        // The first request at or after 13:00:00 is r4 at 13:05:10: 5 min 10 s = 310 s.
        resetToNextRequestSeconds: 310,
        // The logs run to 13:05:10, after the 13:00 reset.
        resetAfterCoverage: false,
        events: [log["h1"]],
        // r4 is that first request, behind the 310 s.
        nextRequestEvents: [log["r4"]],
      },
    ]);
  });

  it("states the text report's interruption totals, with every hit in a column", () => {
    expect(data.interruptions).toEqual({
      // h1 is the only limit-hit line, and the 103 group merges into it (D-023): one hit, logged,
      // in the 5-hour window.
      hits: 1,
      fiveHourHits: 1,
      sevenDayHits: 0,
      unknownWindowHits: 0,
      loggedHits: 1,
      statusLineOnlyHits: 0,
      // One interval, 12:00:00 to 13:00:00 = 3600 s.
      lockoutSeconds: 3600,
      lockoutIntervals: 1,
      // h1 has both a time and a reset.
      hitsWithUnknownReset: 0,
      unknownResetEvents: [],
      // h1 sits in the 13:00 column, so no hit is left over.
      hitsInNoColumn: 0,
      hitsInNoColumnEvents: [],
      events: [log["h1"]],
      // Each split's own hits: h1 is the 5-hour, logged one.
      fiveHourEvents: [log["h1"]],
      sevenDayEvents: [],
      unknownWindowEvents: [],
      loggedEvents: [log["h1"]],
      statusLineOnlyEvents: [],
      // The session logs' span: u1 10:00:00 to r4 13:05:10.
      span: { from: at("10:00:00"), to: at("13:05:10") },
    });
  });

  it("finds no reading captured after its window's reset", () => {
    // Each reading is dated before its own reset: the three 13:00 readings at 10:00:05, 10:00:20
    // and 11:58:00, the 18:00 one at 13:05:10, and every weekly one before 2026-09-10.
    expect(data.afterReset).toEqual({ count: 0, events: [] });
  });

  it("orders models by output tokens with their deduplicated requests", () => {
    expect(data.models).toEqual([
      // claude-opus-5: r2 300 + r3 10 + r4 50 = 360 output tokens over 3 requests.
      {
        model: "claude-opus-5",
        requests: 3,
        outputTokens: 360,
        events: [log["r2"], log["r3"], log["r4"]],
      },
      // claude-sonnet-5: r1 alone, 100 output tokens.
      { model: "claude-sonnet-5", requests: 1, outputTokens: 100, events: [log["r1"]] },
    ]);
  });

  it("prices the month at API list price from the committed rates, with its priced requests", () => {
    expect(data.months).toHaveLength(1);
    const month = data.months[0];
    expect(month).toMatchObject({
      month: "2026-09",
      planName: null,
      planUsdPerMonth: null,
      pricedRequests: 4,
      unpricedRequests: 0,
      // Both models are in the price table, so nothing is left unpriced.
      unpricedEvents: [],
      span: { from: at("10:00:05"), to: at("13:05:10") },
      events: [log["r1"], log["r2"], log["r3"], log["r4"]],
    });
    // prices.json, USD per million tokens: claude-sonnet-5 input 2, output 10; claude-opus-5 input
    // 5, output 25. No cache tokens in the fixture.
    //   r1 sonnet: 1 x 2 + 100 x 10 = 1002
    //   r2 opus:   1 x 5 + 300 x 25 = 7505
    //   r3 opus:   1 x 5 +  10 x 25 =  255
    //   r4 opus:   1 x 5 +  50 x 25 = 1255
    //   total 1002 + 7505 + 255 + 1255 = 10017 per million = $0.010017.
    expect(month?.apiListPriceUsd).toBeCloseTo(0.010017, 12);
    // The month's list has exactly the requests the view counts as priced.
    expect(month?.events).toHaveLength(month?.pricedRequests ?? -1);
  });

  it("carries the text report's rate-reading and lower-bound notes", () => {
    // Worked out by hand: r1 (claude-sonnet-5) and r2, r3, r4 (claude-opus-5) are all dated
    // 2026-09-03, and both price rows were read on 2026-09-13 (prices.json verified_on), so one
    // reading date with 4 requests before it. No request has cache writes without the 5m/1h split,
    // so none is priced as a lower bound.
    expect(data.priceNotes).toEqual({
      rateReadings: [
        {
          verifiedOn: "2026-09-13",
          pricedBeforeVerifiedRequests: 4,
          // The four requests, in log order.
          events: [log["r1"], log["r2"], log["r3"], log["r4"]],
        },
      ],
      lowerBoundRequests: 0,
      lowerBoundEvents: [],
    });
  });

  it("describes every referenced event, each file stored once and relative", () => {
    const refs: EventRef[] = [
      ...data.gauge.flatMap((g) => [g.peakEvents, g.lastEvents, g.hitEvents]),
      ...data.series.flatMap((s) => [s.points.map((p) => p.event), s.hits.map((h) => h.event)]),
      ...data.lockouts.flatMap((bar) => [bar.events, bar.nextRequestEvents]),
      data.interruptions.events,
      data.interruptions.unknownResetEvents,
      data.interruptions.hitsInNoColumnEvents,
      data.afterReset.events,
      ...data.models.map((bar) => bar.events),
      ...data.months.flatMap((bar) => [bar.events, bar.unpricedEvents]),
    ];
    const referenced = new Set(refs.flat());
    // Spool lines 1-4, h1, and r1-r4: 9 events, and no event nothing refers to. The new lists add
    // none: r4 (next request) and h1 (interruptions) are already there.
    expect(referenced.size).toBe(9);
    expect(
      Object.keys(data.events)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([...referenced].sort((a, b) => a - b));
    expect([...data.files].sort()).toEqual([LOG, SPOOL]);
    /**
     * Finds the stored path of an event's file.
     * @param id - Raw line ID.
     * @returns The path, or undefined when the event or file is missing.
     */
    const file = (id: number | undefined): string | undefined =>
      data.files[data.events[id ?? -1]?.file ?? -1];
    // A log line is dated by its own timestamp.
    expect(data.events[log["h1"] ?? -1]).toMatchObject({ line: 8, atUtc: at("12:00:00") });
    expect(file(log["h1"])).toBe(LOG);
    expect(data.events[log["r4"] ?? -1]).toMatchObject({ line: 10, atUtc: at("13:05:10") });
    // A spool line is dated by its capture (11:58:05), while its chart point sits at 11:58:00.
    expect(data.events[spool[3] ?? -1]).toMatchObject({ line: 3, atUtc: at("11:58:05") });
    expect(file(spool[3])).toBe(SPOOL);
  });
});

describe("loadHtmlData on the report fixture (fixture.ts buildReportFixture)", () => {
  let db: Db;
  let data: HtmlReportData;
  let restore: () => void;
  /** Raw line IDs by the fixture's line names; each file's lines are numbered from 1. */
  const id: Record<string, number> = {};

  beforeAll(() => {
    // The fixture's months are chosen for America/Chicago.
    restore = useZone(FIXTURE_TIME_ZONE);
    db = buildReportFixture();
    data = loadHtmlData(db, { ...HTML_FIXTURE_META, timeZone: FIXTURE_TIME_ZONE });
    ["a1", "a2", "a3", "a4", "a5", "a6"].forEach((name, index) => {
      id[name] = lineId(db, "projects/-work-app/sa.jsonl", index + 1);
    });
    id["c2"] = lineId(db, "projects/-work-tool/sc.jsonl", 2);
    id["b1"] = lineId(db, "projects/-work-tool/sb.jsonl", 1);
    id["b2"] = lineId(db, "projects/-work-tool/sb.jsonl", 2);
  });

  afterAll(() => {
    db.close();
    restore();
  });

  it("puts the weekly hit with an unknown reset in the open weekly column its time falls in", () => {
    // Columns, oldest reset first. Readings are dated by their response in session sb (D-045):
    //   five_hour 2026-09-02 17:00: captures 14:00 (no request yet, so capture) and 15:00 (b2).
    //   five_hour 2026-09-02 22:00: capture 18:00 (b2 at 15:00 is before the 17:00 start).
    //   seven_day 2026-09-07 00:00: 15:00 (b2), and 18:30 and 19:00 in session st, which has no logs.
    // Open: the last capture is 2026-09-02 19:00, before the 22:00 and 09-07 resets but after 17:00.
    // c2 at 2026-09-02 20:00 reads "resets Sep 6, 7pm", a wording D-023 doesn't resolve, so its
    // reset is unknown; its time is in the weekly span (2026-08-31 00:00, 2026-09-07 00:00].
    // a4 (2026-09-01 14:00:30) is before both 5-hour spans, (12:00, 17:00] and (17:00, 22:00].
    expect(
      data.gauge.map((g) => [g.window, g.resetAtUtc, g.open, g.limitHits, g.hitEvents]),
    ).toEqual([
      ["five_hour", "2026-09-02T17:00:00.000Z", false, 0, []],
      ["five_hour", "2026-09-02T22:00:00.000Z", true, 0, []],
      ["seven_day", "2026-09-07T00:00:00.000Z", true, 1, [id["c2"]]],
    ]);
    expect(data.series.map((s) => s.hits)).toEqual([
      [],
      [],
      [{ atUtc: "2026-09-02T20:00:00.000Z", event: id["c2"] }],
    ]);
  });

  it("counts the 5-hour hit before any reading in no column, beside the text report's totals", () => {
    expect(data.interruptions).toMatchObject({
      // a4 (session limit) and c2 (weekly limit), both from the logs; no reading reached 100.
      hits: 2,
      fiveHourHits: 1,
      sevenDayHits: 1,
      unknownWindowHits: 0,
      loggedHits: 2,
      statusLineOnlyHits: 0,
      // a4 at 14:00:30 UTC is 09:00:30 CDT, and "resets 11am (America/Chicago)" resolves to
      // 11:00 CDT = 16:00:00 UTC: 1 h 59 min 30 s = 3600 + 3540 + 30 = 7170 s, one interval.
      lockoutSeconds: 7170,
      lockoutIntervals: 1,
      // c2's reset is unknown.
      hitsWithUnknownReset: 1,
      unknownResetEvents: [id["c2"]],
      // a4 has no column; c2 has the weekly one. 0 + 0 + 1 in columns + 1 here = 2 hits.
      hitsInNoColumn: 1,
      hitsInNoColumnEvents: [id["a4"]],
      // The logs run from b1 (2026-08-20 15:00) to c2 (2026-09-02 20:00).
      span: { from: "2026-08-20T15:00:00.000Z", to: "2026-09-02T20:00:00.000Z" },
    });
    // a4 and c2 are in different files, so the order between them is the stored file order; the
    // set is what this checks, and the cross-check below checks the order.
    expect([...data.interruptions.events].sort((x, y) => x - y)).toEqual(
      [id["a4"] ?? -1, id["c2"] ?? -1].sort((x, y) => x - y),
    );
  });

  it("ties the lockout's reset to next request to the request behind it", () => {
    expect(data.lockouts).toEqual([
      {
        lockedFromUtc: "2026-09-01T14:00:30.000Z",
        lockedUntilUtc: "2026-09-01T16:00:00.000Z",
        seconds: 7170,
        hits: 1,
        // Requests: b1 08-20 15:00, a2 09-01 14:00:10, a6 09-01 16:30:05, b2 09-02 15:00. The first
        // at or after 16:00:00 is a6: 30 min 5 s = 1805 s.
        resetToNextRequestSeconds: 1805,
        // The logs run to 2026-09-02 20:00, after the reset.
        resetAfterCoverage: false,
        events: [id["a4"]],
        nextRequestEvents: [id["a6"]],
      },
    ]);
  });

  it("lists the unpriced request in its month, apart from the priced ones", () => {
    // In America/Chicago: b1 (claude-haiku-4-5) is 2026-08-20 10:00 CDT; a2 and a6
    // (claude-opus-5, claude-sonnet-5) are 2026-09-01; b2 (claude-experimental-x) is 2026-09-02
    // and has no price row, so it is unpriced (D-005).
    expect(
      data.months.map((m) => [
        m.month,
        m.pricedRequests,
        m.unpricedRequests,
        m.events,
        m.unpricedEvents,
      ]),
    ).toEqual([
      ["2026-08", 1, 0, [id["b1"]], []],
      ["2026-09", 2, 1, [id["a2"], id["a6"]], [id["b2"]]],
    ]);
    // b2 is described like any other event.
    expect(data.events[id["b2"] ?? -1]).toMatchObject({
      line: 2,
      atUtc: "2026-09-02T15:00:00.000Z",
    });
  });
});

describe("loadHtmlData places each limit hit in the column whose span holds it", () => {
  let restore: () => void;

  beforeAll(() => {
    restore = useZone();
  });

  afterAll(() => {
    restore();
  });

  it("puts a logged hit whose reset is a second off the status line's in that window's column", () => {
    // u1 10:00:00, r1 10:00:05, h1 12:00:00 "resets 1pm (UTC)", which resolves to 13:00:00 (D-023).
    // One reading captured 10:00:06: five_hour at 40, resetting 13:00:01. It reports r1, so it is
    // observed at 10:00:05 (D-045), and the column spans (08:00:01, 13:00:01]. Below 100, so h1
    // doesn't merge with the status line and keeps its own reset, a second before the column's.
    const db = ingest(
      {
        "-second/s1.jsonl": [
          user("s1", "u1", null, "2026-09-03T10:00:00Z"),
          request("s1", "r1", "u1", "2026-09-03T10:00:05Z"),
          hit(
            "s1",
            "h1",
            "r1",
            at("12:00:00"),
            "You've hit your session limit \u00b7 resets 1pm (UTC)",
          ),
        ],
      },
      [
        {
          at: "2026-09-03T10:00:06Z",
          session: "s1",
          window: "five_hour",
          used: 40,
          resets: "2026-09-03T13:00:01Z",
        },
      ],
    );
    const h1 = lineId(db, "projects/-second/s1.jsonl", 3);
    // The premise, read with SQL of its own: the hit's reset is 13:00:00, not the column's 13:00:01.
    expect(db.prepare("SELECT reset_at_utc AS r FROM obs_limit_hits_events").all()).toEqual([
      { r: at("13:00:00") },
    ]);
    const data = loadHtmlData(db, HTML_FIXTURE_META);
    // 12:00:00 is in (08:00:01, 13:00:01], so h1 lands in the column.
    expect(data.gauge.map((g) => [g.window, g.resetAtUtc, g.limitHits, g.hitEvents])).toEqual([
      ["five_hour", at("13:00:01"), 1, [h1]],
    ]);
    expect(data.series.map((s) => s.hits)).toEqual([[{ atUtc: at("12:00:00"), event: h1 }]]);
    expect(data.interruptions.hitsInNoColumn).toBe(0);
    db.close();
  });

  it("gives a hit two overlapping columns hold to the earlier reset only", () => {
    // Two five_hour instances a second apart, as a jittered reset would make: 40 resetting
    // 13:00:00 (captured 10:00:06) and 50 resetting 13:00:01 (captured 11:00:00). Both report r1,
    // observed 10:00:05, before either reset, so each has one counted reading. h1 at 12:00:00 is
    // in both spans, (08:00:00, 13:00:00] and (08:00:01, 13:00:01]; it counts once, in the first.
    const db = ingest(
      {
        "-overlap/s1.jsonl": [
          user("s1", "u1", null, "2026-09-03T10:00:00Z"),
          request("s1", "r1", "u1", "2026-09-03T10:00:05Z"),
          hit(
            "s1",
            "h1",
            "r1",
            at("12:00:00"),
            "You've hit your session limit \u00b7 resets 1pm (UTC)",
          ),
        ],
      },
      [
        {
          at: "2026-09-03T10:00:06Z",
          session: "s1",
          window: "five_hour",
          used: 40,
          resets: "2026-09-03T13:00:00Z",
        },
        {
          at: "2026-09-03T11:00:00Z",
          session: "s1",
          window: "five_hour",
          used: 50,
          resets: "2026-09-03T13:00:01Z",
        },
      ],
    );
    const h1 = lineId(db, "projects/-overlap/s1.jsonl", 3);
    const data = loadHtmlData(db, HTML_FIXTURE_META);
    expect(data.gauge.map((g) => [g.resetAtUtc, g.readings, g.limitHits, g.hitEvents])).toEqual([
      [at("13:00:00"), 1, 1, [h1]],
      [at("13:00:01"), 1, 0, []],
    ]);
    // 1 + 0 in columns + 0 in none = 1 hit.
    expect(data.interruptions.hitsInNoColumn).toBe(0);
    expect(data.interruptions.hits).toBe(1);
    db.close();
  });

  it("counts a hit whose window has no counted reading in no column", () => {
    // h1 at 13:00:00 "resets 2pm (UTC)" resolves to 14:00:00 (D-023), the very instance the one
    // reading reports: five_hour at 40 resetting 14:00:00, captured 14:00:10 in a session with no
    // requests, so observed at capture, after its reset (D-024). The instance has 0 counted
    // readings, so it is no gauge column, and h1, though its span (09:00, 14:00] holds 13:00, is
    // in none.
    const db = ingest(
      {
        "-emptycolumn/s9.jsonl": [
          hit(
            "s9",
            "h1",
            null,
            at("13:00:00"),
            "You've hit your session limit \u00b7 resets 2pm (UTC)",
          ),
        ],
      },
      [
        {
          at: "2026-09-03T14:00:10Z",
          session: "s9",
          window: "five_hour",
          used: 40,
          resets: "2026-09-03T14:00:00Z",
        },
      ],
    );
    const h1 = lineId(db, "projects/-emptycolumn/s9.jsonl", 1);
    const data = loadHtmlData(db, HTML_FIXTURE_META);
    expect(data.gauge).toEqual([]);
    // 0 in columns + 1 here = 1 hit; the reading is the one after its reset.
    expect(data.interruptions).toMatchObject({
      hits: 1,
      hitsInNoColumn: 1,
      hitsInNoColumnEvents: [h1],
    });
    expect(data.afterReset).toEqual({ count: 1, events: [lineId(db, SPOOL, 1)] });
    db.close();
  });

  it("counts a hit with an unknown window, or no time, in no column", () => {
    // Readings as the one-second test, but resetting 13:00:00, with a weekly window too. h1 at
    // 12:00:00 says only "Usage limit reached": no window, so no column, though both spans hold its
    // time. h2 has no timestamp, so no span can hold it.
    const db = ingest(
      {
        "-nocolumn/s1.jsonl": [
          user("s1", "u1", null, "2026-09-03T10:00:00Z"),
          request("s1", "r1", "u1", "2026-09-03T10:00:05Z"),
          hit("s1", "h1", "r1", at("12:00:00"), "Usage limit reached"),
          hit("s1", "h2", "h1", null, "You've hit your session limit \u00b7 resets 1pm (UTC)"),
        ],
      },
      [
        {
          at: "2026-09-03T10:00:06Z",
          session: "s1",
          window: "five_hour",
          used: 40,
          resets: "2026-09-03T13:00:00Z",
          more: [{ window: "seven_day", used: 10, resets: "2026-09-10T00:00:00Z" }],
        },
      ],
    );
    const h1 = lineId(db, "projects/-nocolumn/s1.jsonl", 3);
    const h2 = lineId(db, "projects/-nocolumn/s1.jsonl", 4);
    const data = loadHtmlData(db, HTML_FIXTURE_META);
    expect(data.gauge.map((g) => [g.window, g.limitHits])).toEqual([
      ["five_hour", 0],
      ["seven_day", 0],
    ]);
    expect(data.interruptions).toMatchObject({
      // h1 and h2: h1's window is unknown, h2's is the session (5-hour) limit.
      hits: 2,
      fiveHourHits: 1,
      unknownWindowHits: 1,
      // Neither has a known reset: h1's text has none, and h2's can't resolve without a time.
      hitsWithUnknownReset: 2,
      unknownResetEvents: [h1, h2],
      // 0 + 0 in columns + 2 here = 2 hits.
      hitsInNoColumn: 2,
      hitsInNoColumnEvents: [h1, h2],
      events: [h1, h2],
    });
    // h2 is described with no time, rather than left out.
    expect(data.events[h2]).toMatchObject({ line: 4, atUtc: null });
    db.close();
  });

  it("puts every hit in no column without a status line (fixtures/08-limit-hits)", () => {
    // From the fixture's README: four limit-hit lines, 3 to 6, and no status line.
    const db = ingestFixture("08-limit-hits", "s08.jsonl");
    const [l3, l4, l5, l6] = [3, 4, 5, 6].map((line) => lineId(db, F08, line));
    const data = loadHtmlData(db, HTML_FIXTURE_META);
    expect(data.gauge).toEqual([]);
    expect(data.interruptions).toEqual({
      hits: 4,
      // Line 3 "session limit" and line 5 "5-hour limit reached"; line 4 weekly; line 6 no window.
      fiveHourHits: 2,
      sevenDayHits: 1,
      unknownWindowHits: 1,
      loggedHits: 4,
      statusLineOnlyHits: 0,
      // Only line 3's reset resolves: "6:10am (UTC)" after 2026-09-01 10:00:05 is 2026-09-02
      // 06:10:00, 20 h 9 min 55 s = 72000 + 540 + 55 = 72595 s. Line 4's "Sep 5, 9am" and line 5's
      // "2am" (no zone) don't resolve, and line 6 names no reset.
      lockoutSeconds: 72595,
      lockoutIntervals: 1,
      hitsWithUnknownReset: 3,
      unknownResetEvents: [l4, l5, l6],
      // No gauge column at all: 0 in columns + 4 here = 4 hits.
      hitsInNoColumn: 4,
      hitsInNoColumnEvents: [l3, l4, l5, l6],
      events: [l3, l4, l5, l6],
      // Split by the same readings as the counts above: lines 3 and 5 five-hour, 4 weekly, 6 none;
      // all four logged.
      fiveHourEvents: [l3, l5],
      sevenDayEvents: [l4],
      unknownWindowEvents: [l6],
      loggedEvents: [l3, l4, l5, l6],
      statusLineOnlyEvents: [],
      // The fixture's lines run from 10:00:00 to line 6 at 13:00:00 on 2026-09-01.
      span: { from: "2026-09-01T10:00:00.000Z", to: "2026-09-01T13:00:00.000Z" },
    });
    // The only request (10:00:02) is before the reset, so none follows it.
    expect(data.lockouts.map((bar) => bar.nextRequestEvents)).toEqual([[]]);
    db.close();
  });

  it("places fixture 20's hits by their time, not by their own resets", () => {
    // fixtures/20-limit-quota-fields/README.md, windows as the views take them (field, else text):
    //   line 2 five_hour 10:00:05, reset 09-02 06:10    line 3 five_hour 11:00:00, reset 09-05 09:00
    //   line 4 unknown   12:00:00, reset unknown        line 5 five_hour 13:00:00, reset 09-05 09:00
    //   line 6 five_hour 14:00:00, reset unknown        line 7 five_hour 15:00:00, reset 09-02 06:10
    //   line 8 seven_day 16:00:00, reset unknown
    // With fixture20WithStatusLine's columns, five_hour (09:00, 14:00] and seven_day up to 09-05:
    // lines 2, 3, 5, and 6 (14:00 is the span's closed end) are in the five_hour column, line 8 in
    // the weekly one, line 4 (no window) and line 7 (after 14:00) in none. No hit's own reset is
    // the column's 14:00:00, so matching by reset would put none of them in a column.
    const db = fixture20WithStatusLine();
    const l = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((line) => (line < 2 ? -1 : lineId(db, F20, line)));
    const data = loadHtmlData(db, HTML_FIXTURE_META);
    expect(
      data.gauge.map((g) => [g.window, g.resetAtUtc, g.readings, g.limitHits, g.hitEvents]),
    ).toEqual([
      ["five_hour", "2026-09-01T14:00:00.000Z", 1, 4, [l[2], l[3], l[5], l[6]]],
      ["seven_day", "2026-09-05T09:00:00.000Z", 1, 1, [l[8]]],
    ]);
    /**
     * Places a time on the fixture's day.
     * @param time - `HH:MM:SS` UTC on 2026-09-01.
     * @returns ISO-8601 UTC with milliseconds.
     */
    const on = (time: string): string => `2026-09-01T${time}.000Z`;
    expect(data.series.map((s) => s.hits)).toEqual([
      [
        { atUtc: on("10:00:05"), event: l[2] },
        { atUtc: on("11:00:00"), event: l[3] },
        { atUtc: on("13:00:00"), event: l[5] },
        { atUtc: on("14:00:00"), event: l[6] },
      ],
      [{ atUtc: on("16:00:00"), event: l[8] }],
    ]);
    expect(data.interruptions).toEqual({
      hits: 7,
      // Lines 2, 3, 5, 6, 7; line 8; line 4.
      fiveHourHits: 5,
      sevenDayHits: 1,
      unknownWindowHits: 1,
      loggedHits: 7,
      statusLineOnlyHits: 0,
      // Known resets: 2, 3, 5, 7. Their spans all overlap, so one interval from line 2 (09-01
      // 10:00:05) to the latest reset (09-05 09:00:00): 4 days less 1 h 0 min 5 s
      // = 345600 - 3605 = 341995 s.
      lockoutSeconds: 341995,
      lockoutIntervals: 1,
      hitsWithUnknownReset: 3,
      unknownResetEvents: [l[4], l[6], l[8]],
      // 4 + 1 in columns + 2 here = 7 hits.
      hitsInNoColumn: 2,
      hitsInNoColumnEvents: [l[4], l[7]],
      events: [l[2], l[3], l[4], l[5], l[6], l[7], l[8]],
      // As counted above: lines 2, 3, 5, 6, 7 five-hour (line 3's field wins over its text, D-067),
      // line 8 weekly (its field), line 4 no window; all seven logged.
      fiveHourEvents: [l[2], l[3], l[5], l[6], l[7]],
      sevenDayEvents: [l[8]],
      unknownWindowEvents: [l[4]],
      loggedEvents: [l[2], l[3], l[4], l[5], l[6], l[7], l[8]],
      statusLineOnlyEvents: [],
      // The logs run from line 1 (10:00:00) to line 8 (16:00:00).
      span: { from: on("10:00:00"), to: on("16:00:00") },
    });
    db.close();
  });
});

/** A database the cross-check runs on, and the zone its months are chosen for. */
interface CrossCheckDatabase {
  /** What the database is, for the test name. */
  readonly name: string;
  /** IANA zone for `proj_api_list_price`'s months. */
  readonly zone: string;
  /** Builds it fresh. */
  readonly build: () => Db;
}

/** Every database the cross-check runs on: every fixture this file tests. */
const CROSS_CHECK: readonly CrossCheckDatabase[] = [
  { name: "the shared HTML fixture", zone: "UTC", build: buildHtmlFixture },
  { name: "buildReportFixture", zone: FIXTURE_TIME_ZONE, build: buildReportFixture },
  {
    name: "fixtures/08-limit-hits",
    zone: "UTC",
    build: (): Db => ingestFixture("08-limit-hits", "s08.jsonl"),
  },
  {
    name: "fixtures/20-limit-quota-fields",
    zone: "UTC",
    build: (): Db => ingestFixture("20-limit-quota-fields", "s20.jsonl"),
  },
  { name: "fixture 20 with a status line", zone: "UTC", build: fixture20WithStatusLine },
];

/**
 * Sorts raw line IDs numerically, to compare two lists as sets.
 * @param ids - The IDs.
 * @returns A sorted copy.
 */
const sorted = (ids: readonly (number | undefined)[]): (number | undefined)[] =>
  [...ids].sort((a, b) => (a ?? -1) - (b ?? -1));

describe.each(CROSS_CHECK)(
  "loadHtmlData agrees with the text report's queries on $name",
  (entry) => {
    let db: Db;
    let data: HtmlReportData;
    let restore: () => void;

    beforeAll(() => {
      restore = useZone(entry.zone);
      db = entry.build();
      data = loadHtmlData(db, HTML_FIXTURE_META);
    });

    afterAll(() => {
      db.close();
      restore();
    });

    /**
     * Lists a query's raw line IDs in canonical order (file, first run, line), with SQL of its own.
     * @param sql - A query selecting `id`, a raw line ID.
     * @returns The IDs in canonical order.
     */
    const canonical = (sql: string): number[] =>
      (
        db
          .prepare(
            `SELECT q.id FROM (${sql}) q JOIN raw_lines l ON l.id = q.id
           ORDER BY l.source_file_id, l.first_run_id, l.line_number`,
          )
          .all() as { id: number }[]
      ).map((row) => row.id);

    it("shows the same window numbers as loadObserved, for every window with a counted reading", () => {
      const observed = loadObserved(db)
        .windows.filter((w) => w.readings > 0)
        .map((w) => ({
          window: w.window,
          resetAtUtc: w.reset_at_utc,
          open: w.window_open === 1,
          peak: w.peak_used_percentage,
          last: w.last_used_percentage,
          lastAtUtc: w.last_reading_at_utc,
          readings: w.readings,
        }))
        .sort(
          (a, b) => a.resetAtUtc.localeCompare(b.resetAtUtc) || a.window.localeCompare(b.window),
        );
      expect(
        data.gauge.map((g) => ({
          window: g.window,
          resetAtUtc: g.resetAtUtc,
          open: g.open,
          peak: g.peak,
          last: g.last,
          lastAtUtc: g.lastAtUtc,
          readings: g.readings,
        })),
      ).toEqual(observed);
    });

    it("adds the columns' hits and the hits in no column up to obs_limit_hits", () => {
      const hits = loadObserved(db).limitHits;
      const inColumns = data.gauge.reduce((sum, g) => sum + g.limitHits, 0);
      expect(inColumns + data.interruptions.hitsInNoColumn).toBe(hits.hits);
      data.gauge.forEach((g, index) => {
        expect(g.hitEvents).toHaveLength(g.limitHits);
        // Every hit in a column is on its line over time, and nothing else is.
        expect(sorted(data.series[index]?.hits.map((h) => h.event) ?? [])).toEqual(
          sorted(g.hitEvents),
        );
      });
      expect(data.interruptions.hitsInNoColumnEvents).toHaveLength(
        data.interruptions.hitsInNoColumn,
      );
      // The columns and the leftover partition the view's hits: each hit once, none invented.
      expect(
        sorted([
          ...data.gauge.flatMap((g) => g.hitEvents),
          ...data.interruptions.hitsInNoColumnEvents,
        ]),
      ).toEqual(sorted(canonical("SELECT raw_line_id AS id FROM obs_limit_hits_events")));
    });

    it("states the interruption totals of obs_limit_hits and obs_lockout_time", () => {
      const { limitHits, lockout } = loadObserved(db);
      const totals = data.interruptions;
      expect([
        totals.hits,
        totals.fiveHourHits,
        totals.sevenDayHits,
        totals.unknownWindowHits,
        totals.loggedHits,
        totals.statusLineOnlyHits,
        totals.lockoutSeconds,
        totals.lockoutIntervals,
        totals.hitsWithUnknownReset,
        totals.span.from,
        totals.span.to,
      ]).toEqual([
        limitHits.hits,
        limitHits.five_hour_hits,
        limitHits.seven_day_hits,
        limitHits.unknown_window_hits,
        limitHits.logged_hits,
        limitHits.status_line_only_hits,
        lockout.lockout_seconds,
        lockout.intervals,
        lockout.hits_with_unknown_reset,
        lockout.covers_from,
        lockout.covers_to,
      ]);
      // The lists are the view's rows, in canonical order.
      expect(totals.events).toEqual(
        canonical("SELECT raw_line_id AS id FROM obs_limit_hits_events"),
      );
      expect(totals.unknownResetEvents).toEqual(
        canonical(
          `SELECT raw_line_id AS id FROM obs_limit_hits_events
         WHERE reset_at_utc IS NULL OR hit_at_utc IS NULL`,
        ),
      );
      expect(totals.unknownResetEvents).toHaveLength(lockout.hits_with_unknown_reset);
    });

    it("gives the same data when it reuses what the text report already read", () => {
      // The command passes readReport's rows so the costliest views run once (D-070); reusing
      // them must change nothing.
      const loaded = { observed: loadObserved(db), projected: loadProjected(db) };
      expect(loadHtmlData(db, HTML_FIXTURE_META, loaded)).toEqual(data);
    });

    it("counts the notes under the monthly amounts as the text report does, each with its requests", () => {
      const { rateReadings, apiListPrice } = loadProjected(db);
      const notes = data.priceNotes;
      expect(notes.rateReadings.map((r) => [r.verifiedOn, r.pricedBeforeVerifiedRequests])).toEqual(
        rateReadings.map((r) => [r.verified_on, r.priced_before_verified_requests]),
      );
      expect(notes.lowerBoundRequests).toBe(
        apiListPrice.reduce((sum, row) => sum + row.lower_bound_requests, 0),
      );
      // Each list is its count long, and holds exactly the requests the rule selects.
      for (const reading of notes.rateReadings) {
        expect(reading.events).toHaveLength(reading.pricedBeforeVerifiedRequests);
        expect(reading.events).toEqual(
          canonical(
            `SELECT raw_line_id AS id FROM request_costs WHERE timestamp_utc IS NOT NULL
             AND unpriced_reason IS NULL AND day_utc < verified_on AND verified_on = '${reading.verifiedOn}'`,
          ),
        );
      }
      expect(notes.lowerBoundEvents).toEqual(
        canonical(
          "SELECT raw_line_id AS id FROM request_costs WHERE timestamp_utc IS NOT NULL AND is_lower_bound = 1",
        ),
      );
    });

    it("gives each split count its own hits, and each set of splits divides every hit once", () => {
      const { limitHits } = loadObserved(db);
      const totals = data.interruptions;
      // Each list is exactly the view's rows for that split, independently selected here.
      /**
       * Selects one split's hits from the view, in canonical order.
       * @param where - The split's condition.
       * @returns Raw line IDs.
       */
      const split = (where: string): number[] =>
        canonical(`SELECT raw_line_id AS id FROM obs_limit_hits_events WHERE ${where}`);
      expect(totals.fiveHourEvents).toEqual(split("window = 'five_hour'"));
      expect(totals.sevenDayEvents).toEqual(split("window = 'seven_day'"));
      expect(totals.unknownWindowEvents).toEqual(split("window IS NULL"));
      expect(totals.loggedEvents).toEqual(split("source = 'session_log'"));
      expect(totals.statusLineOnlyEvents).toEqual(split("source = 'status_line'"));
      // Each list's length is the count the text report prints beside it.
      expect([
        totals.fiveHourEvents.length,
        totals.sevenDayEvents.length,
        totals.unknownWindowEvents.length,
        totals.loggedEvents.length,
        totals.statusLineOnlyEvents.length,
      ]).toEqual([
        limitHits.five_hour_hits,
        limitHits.seven_day_hits,
        limitHits.unknown_window_hits,
        limitHits.logged_hits,
        limitHits.status_line_only_hits,
      ]);
      // The window splits, and separately the source splits, together are every hit, once each.
      /**
       * Sorts IDs numerically, so two lists compare as sets with their duplicates kept.
       * @param ids - Raw line IDs.
       * @returns A sorted copy.
       */
      const byNumber = (ids: readonly number[]): number[] => [...ids].sort((x, y) => x - y);
      const all = byNumber(totals.events);
      expect(
        byNumber([
          ...totals.fiveHourEvents,
          ...totals.sevenDayEvents,
          ...totals.unknownWindowEvents,
        ]),
      ).toEqual(all);
      expect(byNumber([...totals.loggedEvents, ...totals.statusLineOnlyEvents])).toEqual(all);
    });

    it("counts the readings after their reset as the text report sums them", () => {
      const windows = loadObserved(db).windows;
      expect(data.afterReset.count).toBe(
        windows.reduce((sum, w) => sum + w.readings_after_reset, 0),
      );
      expect(data.afterReset.events).toHaveLength(data.afterReset.count);
    });

    it("shows the same lockouts, models, months, and spans as loadObserved and loadProjected", () => {
      const observed = loadObserved(db);
      const projected = loadProjected(db);
      expect(
        data.lockouts.map((bar) => [bar.lockedFromUtc, bar.lockedUntilUtc, bar.seconds]),
      ).toEqual(
        observed.lockoutIntervals.map((i) => [
          i.locked_from_utc,
          i.locked_until_utc,
          i.lockout_seconds,
        ]),
      );
      expect(
        data.lockouts.map((bar) => [bar.hits, bar.resetToNextRequestSeconds, bar.events.length]),
      ).toEqual(
        observed.lockoutIntervals.map((i) => [i.hits, i.reset_to_next_request_seconds, i.hits]),
      );
      // The next request's own timestamp, read independently, is the view's next_request_at_utc.
      expect(
        data.lockouts.map((bar) =>
          bar.nextRequestEvents.map(
            (event) =>
              (
                db
                  .prepare("SELECT timestamp_utc AS t FROM requests_dedup WHERE raw_line_id = ?")
                  .get(event) as { t: string }
              ).t,
          ),
        ),
      ).toEqual(
        observed.lockoutIntervals.map((i) =>
          i.next_request_at_utc === null ? [] : [i.next_request_at_utc],
        ),
      );
      expect(data.models.map((bar) => [bar.model, bar.requests, bar.outputTokens])).toEqual(
        observed.byModel.map((row) => [row.model, row.requests, row.output_tokens]),
      );
      data.models.forEach((bar) => expect(bar.events).toHaveLength(bar.requests));
      expect(
        data.months.map((bar) => [
          bar.month,
          bar.apiListPriceUsd,
          bar.pricedRequests,
          bar.unpricedRequests,
          bar.unpricedEvents.length,
          bar.planName,
          bar.planUsdPerMonth,
          bar.span.from,
          bar.span.to,
        ]),
      ).toEqual(
        projected.apiListPrice.map((row) => [
          row.month,
          row.api_list_price_usd,
          row.priced_requests,
          row.unpriced_requests,
          row.unpriced_requests,
          row.plan_name,
          row.plan_usd_per_month,
          row.covers_from,
          row.covers_to,
        ]),
      );
      expect(data.coverage).toEqual([
        {
          source: "session_logs",
          span: { from: observed.limitHits.covers_from, to: observed.limitHits.covers_to },
        },
        {
          source: "status_line",
          span: {
            from: observed.limitHits.status_line_covers_from,
            to: observed.limitHits.status_line_covers_to,
          },
        },
      ]);
    });

    it("lists events that re-add to each model's output tokens and each month's price", () => {
      // Independent of the module: sum the listed requests' own columns straight from the views.
      /**
       * Totals one column over the listed events.
       * @param sql - A query selecting `id` (raw line ID) and `v` (the value to add).
       * @param events - The element's events.
       * @returns The total; 0 with no events.
       */
      const sum = (sql: string, events: EventRef): number =>
        (
          db
            .prepare(
              `SELECT TOTAL(v) AS v FROM (${sql}) WHERE id IN (SELECT value FROM json_each(?))`,
            )
            .get(JSON.stringify(events)) as { v: number }
        ).v;
      for (const bar of data.models) {
        expect(
          sum("SELECT raw_line_id AS id, output_tokens AS v FROM requests_dedup", bar.events),
        ).toBe(bar.outputTokens);
      }
      for (const bar of data.months) {
        // Summation order can differ from the view's, so compare to 12 decimal places.
        expect(
          sum("SELECT raw_line_id AS id, total_usd AS v FROM request_costs", bar.events),
        ).toBeCloseTo(bar.apiListPriceUsd ?? Number.NaN, 12);
        // Every listed unpriced request is one request_costs leaves unpriced.
        expect(
          sum(
            "SELECT raw_line_id AS id, 1 AS v FROM request_costs WHERE unpriced_reason IS NOT NULL",
            bar.unpricedEvents,
          ),
        ).toBe(bar.unpricedRequests);
      }
    });

    it("describes every event any element refers to, and no other", () => {
      const refs: EventRef[] = [
        ...data.gauge.flatMap((g) => [g.peakEvents, g.lastEvents, g.hitEvents]),
        ...data.series.flatMap((s) => [s.points.map((p) => p.event), s.hits.map((h) => h.event)]),
        ...data.lockouts.flatMap((bar) => [bar.events, bar.nextRequestEvents]),
        data.interruptions.events,
        data.interruptions.unknownResetEvents,
        data.interruptions.hitsInNoColumnEvents,
        data.afterReset.events,
        ...data.models.map((bar) => bar.events),
        ...data.months.flatMap((bar) => [bar.events, bar.unpricedEvents]),
      ];
      expect(
        Object.keys(data.events)
          .map(Number)
          .sort((a, b) => a - b),
      ).toEqual([...new Set(refs.flat())].sort((a, b) => a - b));
    });
  },
);

describe("loadHtmlData at the edges", () => {
  let restore: () => void;

  beforeAll(() => {
    restore = useZone();
  });

  afterAll(() => {
    restore();
  });

  it("returns empty charts, null spans, and no events for a database that was never ingested", () => {
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    expect(loadHtmlData(db, HTML_FIXTURE_META)).toEqual({
      timeZone: "UTC",
      lastIngestAt: null,
      generatedAtUtc: "2026-09-03T14:00:00.000Z",
      coverage: [
        { source: "session_logs", span: { from: null, to: null } },
        { source: "status_line", span: { from: null, to: null } },
      ],
      gauge: [],
      series: [],
      lockouts: [],
      // No hit at all, so every count is 0; lockout seconds total over no interval is 0.
      interruptions: {
        hits: 0,
        fiveHourHits: 0,
        sevenDayHits: 0,
        unknownWindowHits: 0,
        loggedHits: 0,
        statusLineOnlyHits: 0,
        lockoutSeconds: 0,
        lockoutIntervals: 0,
        hitsWithUnknownReset: 0,
        unknownResetEvents: [],
        hitsInNoColumn: 0,
        hitsInNoColumnEvents: [],
        events: [],
        fiveHourEvents: [],
        sevenDayEvents: [],
        unknownWindowEvents: [],
        loggedEvents: [],
        statusLineOnlyEvents: [],
        span: { from: null, to: null },
      },
      afterReset: { count: 0, events: [] },
      models: [],
      months: [],
      // No priced request, so no reading date has requests before it and none is a lower bound.
      priceNotes: { rateReadings: [], lowerBoundRequests: 0, lowerBoundEvents: [] },
      files: [],
      events: {},
    });
    db.close();
  });

  it("leaves out a window whose only reading came after its reset, and lists that reading", () => {
    // One reading captured at 14:00:10 for a five_hour window resetting at 14:00:00, in a session
    // with no requests: it's observed at capture (D-045 fallback), 10 s after the reset, so the
    // window has 0 counted readings and 1 after its reset (D-024).
    const db = ingest({}, [
      {
        at: "2026-09-03T14:00:10Z",
        session: "s9",
        window: "five_hour",
        used: 40,
        resets: "2026-09-03T14:00:00Z",
      },
    ]);
    const windows = loadObserved(db).windows;
    expect(windows.map((w) => [w.readings, w.readings_after_reset])).toEqual([[0, 1]]);
    const data = loadHtmlData(db, HTML_FIXTURE_META);
    expect(data.gauge).toEqual([]);
    expect(data.series).toEqual([]);
    const reading = lineId(db, SPOOL, 1);
    expect(data.afterReset).toEqual({ count: 1, events: [reading] });
    // The reading is the only event, dated by its capture.
    expect(data.files).toEqual([SPOOL]);
    expect(data.events).toEqual({ [reading]: { file: 0, line: 1, atUtc: at("14:00:10") } });
    db.close();
  });

  it("flags a lockout whose reset came after the logs end, with no request after it", () => {
    // u1 10:00:00, r1 10:00:05, then h1 at 12:00:00 "resets 1pm (UTC)": the reset resolves to
    // 13:00:00 (D-023) and the logs end at h1, 12:00:00.
    const db = ingest({
      "-edge/s1.jsonl": [
        user("s1", "u1", null, "2026-09-03T10:00:00Z"),
        request("s1", "r1", "u1", "2026-09-03T10:00:05Z"),
        hit(
          "s1",
          "h1",
          "r1",
          "2026-09-03T12:00:00Z",
          "You've hit your session limit \u00b7 resets 1pm (UTC)",
        ),
      ],
    });
    const h1 = lineId(db, "projects/-edge/s1.jsonl", 3);
    const data = loadHtmlData(db, HTML_FIXTURE_META);
    expect(data.lockouts).toEqual([
      {
        lockedFromUtc: at("12:00:00"),
        lockedUntilUtc: at("13:00:00"),
        // 13:00:00 - 12:00:00 = 3600 s.
        seconds: 3600,
        hits: 1,
        // Nothing follows 13:00 in the logs, which end at 12:00:00.
        resetToNextRequestSeconds: null,
        resetAfterCoverage: true,
        events: [h1],
        nextRequestEvents: [],
      },
    ]);
    // No status line reading, so the hit's window has no gauge column to sit in, and it is
    // counted in none.
    expect(data.gauge).toEqual([]);
    expect(data.interruptions).toMatchObject({ hitsInNoColumn: 1, hitsInNoColumnEvents: [h1] });
    db.close();
  });
});
