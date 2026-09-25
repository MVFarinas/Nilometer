/**
 * @file Unit tests for viewer/html-charts.ts (step G1.2, D-070).
 *
 * Inputs are contract values built by hand, so no database is needed. Every expected coordinate is
 * worked out by hand from the layout constants in the module's source, with the arithmetic in a
 * comment beside the assertion; nothing expected here was found by running the code. The gauge and
 * window inputs follow the shared scenario in html-fixture.ts (the 5-hour window resetting 13:00
 * with readings of 20, 60, and 103, a limit hit at 12:00) wherever that scenario has the case.
 */
import { describe, expect, it } from "vitest";

import type {
  ChartOptions,
  GaugeWindow,
  LockoutBar,
  ModelBar,
  MonthBar,
  WindowSeries,
} from "../../../viewer/html-contract.js";
import {
  renderCoverage,
  renderGauge,
  renderLockouts,
  renderModelBars,
  renderMonthBars,
  renderWindowSeries,
} from "../../../viewer/html-charts.js";

/** 600 wide, drawn in UTC, like the shared fixture's display zone. */
const OPTIONS: ChartOptions = { timeZone: "UTC", width: 600 };

/** One element's start tag, parsed. */
interface Tag {
  /** Element name. */
  readonly tag: string;
  /** Attribute values as written (still escaped). */
  readonly attrs: Readonly<Record<string, string>>;
}

/**
 * Parses every start tag in a chart.
 * @param svg - Chart SVG text.
 * @returns Each element's name and attributes, in document order.
 */
function tags(svg: string): Tag[] {
  return [...svg.matchAll(/<([a-z]+)((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g)].map((m) => ({
    tag: m[1] ?? "",
    attrs: Object.fromEntries(
      [...(m[2] ?? "").matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]),
    ) as Record<string, string>,
  }));
}

/**
 * Finds the elements with one class.
 * @param svg - Chart SVG text.
 * @param cls - A class name.
 * @returns Matching elements, in document order.
 */
function byClass(svg: string, cls: string): Tag[] {
  return tags(svg).filter((t) => (t.attrs.class ?? "").split(" ").includes(cls));
}

/**
 * Finds the one element with a class, failing the test when there isn't exactly one.
 * @param svg - Chart SVG text.
 * @param cls - A class name.
 * @returns Its attributes.
 * @throws {Error} When zero or several elements have the class.
 */
function only(svg: string, cls: string): Readonly<Record<string, string>> {
  const found = byClass(svg, cls);
  if (found.length !== 1) {
    throw new Error(`expected one .${cls}, found ${found.length}`);
  }
  return (found[0] as Tag).attrs;
}

/**
 * Collects the text content of every `<text>` element.
 * @param svg - Chart SVG text.
 * @returns Each text, still escaped.
 */
function texts(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1] ?? "");
}

/** The fixture's 5-hour window resetting 13:00: readings 20, 60, 103 and the hit at 12:00. */
const HIT_WINDOW: GaugeWindow = {
  window: "five_hour",
  resetAtUtc: "2026-09-03T13:00:00.000Z",
  open: false,
  peak: 103,
  peakAtUtc: "2026-09-03T11:58:00.000Z",
  last: 103,
  lastAtUtc: "2026-09-03T11:58:00.000Z",
  readings: 3,
  limitHits: 1,
  peakEvents: [21],
  lastEvents: [21],
  hitEvents: [8],
};

/** The fixture's next 5-hour window, resetting 18:00, still open with one reading of 2. */
const OPEN_WINDOW: GaugeWindow = {
  window: "five_hour",
  resetAtUtc: "2026-09-03T18:00:00.000Z",
  open: true,
  peak: 2,
  peakAtUtc: "2026-09-03T13:05:10.000Z",
  last: 2,
  lastAtUtc: "2026-09-03T13:05:10.000Z",
  readings: 1,
  limitHits: 0,
  peakEvents: [22],
  lastEvents: [22],
  hitEvents: [],
};

/** A weekly window whose peak (40) and last reading (35) differ, so fill and tick separate. */
const WEEKLY: GaugeWindow = {
  window: "seven_day",
  resetAtUtc: "2026-09-10T00:00:00.000Z",
  open: true,
  peak: 40,
  peakAtUtc: "2026-09-03T11:00:00.000Z",
  last: 35,
  lastAtUtc: "2026-09-03T13:05:10.000Z",
  readings: 4,
  limitHits: 0,
  peakEvents: [30],
  lastEvents: [31],
  hitEvents: [],
};

/** The three windows, weekly listed first to show the gauge groups by window, not input order. */
const GAUGE_INPUT: readonly GaugeWindow[] = [WEEKLY, HIT_WINDOW, OPEN_WINDOW];

/** The fixture window's line, on round hours so positions can be worked out by hand. */
const SERIES: WindowSeries = {
  window: "five_hour",
  resetAtUtc: "2026-09-03T13:00:00.000Z",
  points: [
    { atUtc: "2026-09-03T10:00:00.000Z", used: 20, event: 1 },
    { atUtc: "2026-09-03T11:00:00.000Z", used: 60, event: 2 },
    { atUtc: "2026-09-03T12:00:00.000Z", used: 103, event: 3 },
  ],
  hits: [{ atUtc: "2026-09-03T12:30:00.000Z", event: 4 }],
};

/** Two lockouts: an hour with one hit, and half an hour with two merged hits. */
const LOCKOUTS: readonly LockoutBar[] = [
  {
    lockedFromUtc: "2026-09-03T12:00:00.000Z",
    lockedUntilUtc: "2026-09-03T13:00:00.000Z",
    seconds: 3600,
    hits: 1,
    resetToNextRequestSeconds: 300,
    resetAfterCoverage: false,
    events: [5],
    nextRequestEvents: [11],
  },
  {
    lockedFromUtc: "2026-09-04T09:00:00.000Z",
    lockedUntilUtc: "2026-09-04T09:30:00.000Z",
    seconds: 1800,
    hits: 2,
    resetToNextRequestSeconds: null,
    resetAfterCoverage: true,
    events: [6, 7],
    nextRequestEvents: [],
  },
];

/** Two models, the second named with XML-special characters to test escaping. */
const MODELS: readonly ModelBar[] = [
  { model: "claude-opus-5", requests: 3, outputTokens: 360, events: [2, 4, 10] },
  { model: "claude-<x>&y", requests: 1, outputTokens: 90, events: [1] },
];

/** A priced month with a plan price entered, and a month with nothing priced and no plan price. */
const MONTHS: readonly MonthBar[] = [
  {
    month: "2026-08",
    apiListPriceUsd: 120,
    planName: "Example plan",
    planUsdPerMonth: 100,
    pricedRequests: 4,
    unpricedRequests: 0,
    unpricedEvents: [],
    span: { from: "2026-08-10T00:00:00.000Z", to: "2026-08-31T12:00:00.000Z" },
    events: [1, 2],
  },
  {
    month: "2026-09",
    apiListPriceUsd: null,
    planName: null,
    planUsdPerMonth: null,
    pricedRequests: 0,
    unpricedRequests: 2,
    unpricedEvents: [12, 13],
    span: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-03T13:05:00.000Z" },
    events: [],
  },
];

describe("renderGauge", () => {
  const svg = renderGauge(GAUGE_INPUT, OPTIONS);

  it("reaches one 10% step past the highest reading, so 103 sits above the 100% line (D-068)", () => {
    // Highest reading 103: minor step 10, top = (floor(103 / 10) + 1) * 10 = 110.
    // y(p) = 56 + (110 - p) / 110 * 220 = 276 - 2p. y(100) = 76, y(103) = 70.
    expect(only(svg, "nm-limit").y1).toBe("76");
    const peaks = byClass(svg, "nm-peak").map((t) => t.attrs);
    const hitPeak = peaks.find((p) => p["data-events"] === "21");
    expect(hitPeak?.y).toBe("70");
    // Height from y(103) = 70 down to the baseline y(0) = 276: 206.
    expect(hitPeak?.height).toBe("206");
    // Smaller y is higher on screen: the 103 column's top is above the 100% line.
    expect(Number(hitPeak?.y)).toBeLessThan(Number(only(svg, "nm-limit").y1));
  });

  it("places a known percentage on the graduated scale: a number every 20%, a small tick every 10%", () => {
    // "20%" at y(20) = 276 - 40 = 236; its text sits 3.5 below: 239.5, right-aligned at 44 - 7 = 37.
    expect(svg).toMatch(/<text x="37" y="239\.5"[^>]*>20%<\/text>/);
    // Small ticks at 10% (y = 256) and 110% (y = 56), from x = 44 - 4 = 40 to 44.
    const ticks = byClass(svg, "nm-tick").filter((t) => t.tag === "line");
    expect(ticks.map((t) => t.attrs.y1)).toEqual(["256", "216", "176", "136", "96", "56"]);
    expect(ticks[0]?.attrs.x1).toBe("40");
    expect(ticks[0]?.attrs.x2).toBe("44");
    // Numbers only at 0, 20, ..., 100: 110 is a small tick, not a number.
    expect(texts(svg).filter((t) => t.endsWith("%"))).toEqual([
      "0%",
      "20%",
      "40%",
      "60%",
      "80%",
      "100%",
    ]);
  });

  it("puts the last-reading tick at the last value, apart from the peak fill", () => {
    const lasts = byClass(svg, "nm-last").map((t) => t.attrs);
    // Weekly last 35: y = 276 - 70 = 206; its peak 40: y = 276 - 80 = 196, height 276 - 196 = 80.
    const weeklyLast = lasts.find((l) => l["data-events"] === "31");
    expect(weeklyLast?.y1).toBe("206");
    expect(weeklyLast?.y2).toBe("206");
    const weeklyPeak = byClass(svg, "nm-peak").find((t) => t.attrs["data-events"] === "30");
    expect(weeklyPeak?.attrs.y).toBe("196");
    expect(weeklyPeak?.attrs.height).toBe("80");
    // The hit window's last reading is 103: y = 70, the same as its peak.
    expect(lasts.find((l) => l["data-events"] === "21")?.y1).toBe("70");
    // The open window's reading of 2: y = 276 - 4 = 272.
    expect(lasts.find((l) => l["data-events"] === "22")?.y1).toBe("272");
  });

  it("groups 5-hour windows before weekly ones, separated by a gap", () => {
    // Plot 44 to 588; one 24 gap between two groups; slot = (544 - 24) / 3 = 173.333; width 24.
    // 5-hour columns: centres 44 + 86.667 = 130.667 and 44 + 260 = 304, so x = 118.67 and 292.
    // Weekly group starts at 44 + 346.667 + 24 = 414.667; centre 501.333, x = 489.33.
    const columns = byClass(svg, "nm-col").map((t) => t.attrs["data-series"]);
    expect(columns).toEqual([
      "five_hour|2026-09-03T13:00:00.000Z",
      "five_hour|2026-09-03T18:00:00.000Z",
      "seven_day|2026-09-10T00:00:00.000Z",
    ]);
    const xs = byClass(svg, "nm-peak").map((t) => t.attrs.x);
    expect(xs).toEqual(["118.67", "292", "489.33"]);
    // The rule sits in the middle of the gap: 414.667 - 12 = 402.667.
    expect(only(svg, "nm-group-rule").x1).toBe("402.67");
    expect(texts(svg)).toEqual(expect.arrayContaining(["5-hour windows", "weekly windows"]));
  });

  it("makes every column a focusable button carrying its window and all its events", () => {
    const col = byClass(svg, "nm-col")[0]?.attrs;
    expect(col?.tabindex).toBe("0");
    expect(col?.role).toBe("button");
    // Peak and last are line 21, the hit is line 8: union ascending "8 21".
    expect(col?.["data-events"]).toBe("8 21");
    expect(col?.["aria-label"]).toBe(
      "5-hour window resetting 2026-09-03 13:00: peak 103%, last observed usage 103%, 1 limit hit, 3 readings",
    );
    expect(byClass(svg, "nm-col")[1]?.attrs["aria-label"]).toMatch(/, open$/);
  });

  it("gives every column a data-label equal to its aria-label, for the events panel's heading", () => {
    const cols = byClass(svg, "nm-col").map((t) => t.attrs);
    // The first column's name and summary, written out from HIT_WINDOW: reset 13:00, peak and last
    // 103, 1 hit, 3 readings, not open.
    expect(cols[0]?.["data-label"]).toBe(
      "5-hour window resetting 2026-09-03 13:00: peak 103%, last observed usage 103%, 1 limit hit, 3 readings",
    );
    // WEEKLY, drawn third: reset 2026-09-10 00:00, peak 40, last 35, no hits, 4 readings, open.
    expect(cols[2]?.["data-label"]).toBe(
      "weekly window resetting 2026-09-10 00:00: peak 40%, last observed usage 35%, 0 limit hits, 4 readings, open",
    );
    // All three columns carry one, each the same text as the accessible name.
    expect(cols).toHaveLength(3);
    for (const col of cols) {
      expect(col["data-label"]).toBe(col["aria-label"]);
    }
  });

  it("flags limit hits on top of the column with the count and the hit lines", () => {
    const hit = only(svg, "nm-hit");
    expect(hit["data-events"]).toBe("8");
    // 12 above the peak's top: 70 - 12 = 58; column centre 130.667.
    expect(hit.cy).toBe("58");
    expect(hit.cx).toBe("130.67");
    expect(svg).toContain(
      "<title>1 limit hit in the 5-hour window resetting 2026-09-03 13:00</title>",
    );
    expect(only(svg, "nm-hit-count").y).toBe("61.5");
  });

  it("labels the open windows and states the span of resets", () => {
    // "open" sits 12 below the baseline, at 288, under both open columns: centres 304 and 501.333.
    expect(byClass(svg, "nm-open").map((t) => [t.attrs.x, t.attrs.y])).toEqual([
      ["304", "288"],
      ["501.33", "288"],
    ]);
    expect(texts(svg)).toContain("Windows resetting 2026-09-03 13:00 to 2026-09-10 00:00 (UTC)");
    expect(svg).toContain(
      'aria-label="Usage windows: peak and last observed usage per window. Windows resetting 2026-09-03 13:00 to 2026-09-10 00:00 (UTC)"',
    );
  });

  it("keeps the scale at 110 when every reading is at or under 100", () => {
    const svg60 = renderGauge([{ ...HIT_WINDOW, peak: 60, last: 60, limitHits: 0 }], OPTIONS);
    // Highest is 100 (the floor): top = (floor(100 / 10) + 1) * 10 = 110, so y(100) = 76 still.
    expect(only(svg60, "nm-limit").y1).toBe("76");
    // Peak 60: y = 276 - 120 = 156.
    expect(only(svg60, "nm-peak").y).toBe("156");
    expect(byClass(svg60, "nm-hit")).toEqual([]);
  });

  it("widens the step for a very high reading instead of drawing more than 24 small ticks", () => {
    const high = renderGauge([{ ...HIT_WINDOW, peak: 240 }], OPTIONS);
    // Step 10 needs floor(240 / 10) + 1 = 25 > 24 ticks; step 20 needs 13. top = 13 * 20 = 260.
    // y(p) = 56 + (260 - p) / 260 * 220. y(240) = 56 + 16.923 = 72.92; y(100) = 56 + 135.385 = 191.38.
    expect(only(high, "nm-peak").y).toBe("72.92");
    expect(only(high, "nm-limit").y1).toBe("191.38");
    // Numbers every second step (40%), so 20% is a small tick and 240% is labeled.
    expect(texts(high)).toContain("240%");
    expect(texts(high)).toContain("40%");
    expect(texts(high)).not.toContain("20%");
  });

  it("draws a window with no usable reading as an empty column, its hit flag on the baseline", () => {
    const none = renderGauge(
      [
        {
          ...HIT_WINDOW,
          peak: null,
          peakAtUtc: null,
          last: null,
          lastAtUtc: null,
          peakEvents: [],
          lastEvents: [],
        },
      ],
      OPTIONS,
    );
    expect(byClass(none, "nm-peak")).toEqual([]);
    expect(byClass(none, "nm-last")).toEqual([]);
    // No values: top 110, baseline y(0) = 276, flag 12 above it: 264.
    expect(only(none, "nm-hit").cy).toBe("264");
    expect(only(none, "nm-col")["aria-label"]).toContain(
      "peak unknown, last observed usage unknown",
    );
  });

  it("leaves out a column label too close to the previous one, and shows each date once", () => {
    // Twenty hourly resets on one day: slot = 544 / 20 = 27.2, centres 57.6 + 27.2 i.
    // A label needs 40 from the last shown one, so every second column is labeled: 10 times.
    const many: GaugeWindow[] = Array.from({ length: 20 }, (_, i) => ({
      ...OPEN_WINDOW,
      open: false,
      resetAtUtc: `2026-09-03T${String(i).padStart(2, "0")}:00:00.000Z`,
    }));
    const dense = renderGauge(many, OPTIONS);
    // Time labels sit at baseline + 24 = 300, dates at baseline + 36 = 312.
    expect(tags(dense).filter((t) => t.tag === "text" && t.attrs.y === "300")).toHaveLength(10);
    expect(tags(dense).filter((t) => t.tag === "text" && t.attrs.y === "312")).toHaveLength(1);
    expect(texts(dense)).toContain("09-03");
  });

  it("draws times in the display zone", () => {
    const denver = renderGauge([HIT_WINDOW], { timeZone: "America/Denver", width: 600 });
    // 13:00 UTC is 07:00 in Denver in September (UTC-6).
    expect(texts(denver)).toContain("07:00");
    expect(denver).toContain("resetting 2026-09-03 07:00");
  });

  it("returns a small No data chart with no data elements for no windows", () => {
    const empty = renderGauge([], OPTIONS);
    expect(texts(empty)).toEqual(["No data"]);
    expect(empty).not.toContain("data-events");
    expect(empty).toContain('viewBox="0 0 600 40"');
  });
});

describe("renderWindowSeries", () => {
  // Width 596: plot 44 to 584, 540 wide. Axis 10:00 to the 13:00 reset, 3 h: 180 per hour.
  // Readings top out at 103, so the percentage scale is the gauge's: y(p) = 276 - 2p.
  const svg = renderWindowSeries(SERIES, { timeZone: "UTC", width: 596 });

  it("carries the window's identity on its root", () => {
    expect(svg.startsWith('<svg class="nm-chart nm-chart-series"')).toBe(true);
    expect(tags(svg)[0]?.attrs["data-series"]).toBe("five_hour|2026-09-03T13:00:00.000Z");
  });

  it("draws a 2px line through the readings, with every reading's event", () => {
    // 10:00 -> (44, 236); 11:00 -> (44 + 180, 156) = (224, 156); 12:00 -> (404, 70).
    const line = only(svg, "nm-line");
    expect(line.d).toBe("M44 236L224 156L404 70");
    expect(line["stroke-width"]).toBe("2");
    expect(line["data-events"]).toBe("1 2 3");
  });

  it("puts a point at each reading, the last one at its value above the 100% line", () => {
    const points = byClass(svg, "nm-point").map((t) => t.attrs);
    expect(points.map((p) => p["data-events"])).toEqual(["1", "2", "3"]);
    expect(points[2]?.cx).toBe("404");
    // 103 -> 276 - 206 = 70, above y(100) = 76.
    expect(points[2]?.cy).toBe("70");
    expect(only(svg, "nm-limit").y1).toBe("76");
    expect(svg).toContain("<title>Observed usage 103% at 2026-09-03 12:00</title>");
  });

  it("flags the limit hit at its time and draws the reset", () => {
    // 12:30 -> 44 + 2.5 * 180 = 494; the staff runs from the baseline 276 to the top 56.
    const hit = only(svg, "nm-hit");
    expect(hit["data-events"]).toBe("4");
    expect(hit.d).toBe("M494 276V56M494 56h8l-8 5z");
    // 13:00 -> 44 + 3 * 180 = 584.
    expect(only(svg, "nm-reset").x1).toBe("584");
    // The reset label ends at the reset line (584 - 44 = 540 leaves room), on the second label
    // row at 34, above the plot; the 100% key is on the first row, its dash at 14 - 4 = 10.
    expect(svg).toMatch(/<text x="584" y="34"[^>]*text-anchor="end"[^>]*>Resets 2026-09-03 13:00</);
    expect(only(svg, "nm-limit-key").y1).toBe("10");
    expect(texts(svg)).toContain("100%, your plan's limit");
    expect(texts(svg)).toContain("Readings 2026-09-03 10:00 to 12:00 (UTC)");
    expect(tags(svg)[0]?.attrs["aria-label"]).toBe(
      "5-hour window resetting 2026-09-03 13:00: observed usage over time, 3 readings, 1 limit hit. Readings 2026-09-03 10:00 to 12:00 (UTC)",
    );
  });

  it("extends the axis to a hit logged after the reset and labels the end", () => {
    const late = renderWindowSeries(
      {
        ...SERIES,
        points: [{ atUtc: "2026-09-03T10:00:00.000Z", used: 50, event: 1 }],
        hits: [{ atUtc: "2026-09-03T14:00:00.000Z", event: 2 }],
      },
      { timeZone: "UTC", width: 596 },
    );
    // Axis 10:00 to 14:00, 4 h over 540: 135 per hour. Reset 13:00 -> 44 + 405 = 449; hit -> 584.
    expect(only(late, "nm-reset").x1).toBe("449");
    expect(only(late, "nm-hit").d).toBe("M584 276V56M584 56h8l-8 5z");
    expect(texts(late)).toContain("2026-09-03 14:00");
  });

  it("keeps a single reading taken exactly at the reset on the left edge", () => {
    const single = renderWindowSeries(
      { ...SERIES, points: [{ atUtc: "2026-09-03T13:00:00.000Z", used: 50, event: 9 }], hits: [] },
      OPTIONS,
    );
    // Zero-length axis becomes 1 ms, and the reading is its start: x = 44.
    expect(only(single, "nm-point").cx).toBe("44");
    expect(byClass(single, "nm-hit")).toEqual([]);
    // The reset is at 44, too near the left edge to end a label there: it starts at the line.
    expect(single).toMatch(/<text x="44" y="34" fill="var\(--ink-2\)" class="nm-label">Resets /);
  });

  it("returns No data, still carrying data-series, for a window with no readings", () => {
    const empty = renderWindowSeries({ ...SERIES, points: [], hits: [] }, OPTIONS);
    expect(texts(empty)).toEqual(["No data"]);
    expect(empty).not.toContain("data-events");
    expect(tags(empty)[0]?.attrs["data-series"]).toBe("five_hour|2026-09-03T13:00:00.000Z");
  });
});

describe("renderCoverage", () => {
  // Width 602: bars from 110 to 590, 480 wide. Axis 00:00 to 12:00: 40 per hour.
  const rows = [
    {
      source: "session_logs",
      span: { from: "2026-09-03T00:00:00.000Z", to: "2026-09-03T12:00:00.000Z" },
    },
    {
      source: "status_line",
      span: { from: "2026-09-03T06:00:00.000Z", to: "2026-09-03T12:00:00.000Z" },
    },
  ] as const;

  it("draws each source's span on one shared time axis", () => {
    const svg = renderCoverage(rows, { timeZone: "UTC", width: 602 });
    const bars = byClass(svg, "nm-coverage").map((t) => t.attrs);
    // Logs 00:00 to 12:00: x 110, width 480. Status line 06:00 to 12:00: x 110 + 240 = 350, width 240.
    expect(bars.map((b) => [b.x, b.width])).toEqual([
      ["110", "480"],
      ["350", "240"],
    ]);
    // A span is not an event: no data-events at all, so the page offers no empty events panel.
    expect(bars.map((b) => b["data-events"])).toEqual([undefined, undefined]);
    expect(svg).not.toContain("data-events");
    // The title stays: it is how the bar states its span on hover.
    expect(svg).toContain(
      "<title>Status line: 2026-09-03 06:00 to 12:00 (UTC), covering usage windows</title>",
    );
    expect(texts(svg)).toEqual(expect.arrayContaining(["2026-09-03 00:00", "2026-09-03 12:00"]));
    // Axis labels at 6 + 2 * 24 + 12 = 66; height 72.
    expect(svg).toContain('viewBox="0 0 602 72"');
  });

  it("says no data yet for a source without a span, and draws a sliver for a single instant", () => {
    const svg = renderCoverage(
      [
        {
          source: "session_logs",
          span: { from: "2026-09-03T06:00:00.000Z", to: "2026-09-03T06:00:00.000Z" },
        },
        { source: "status_line", span: { from: null, to: null } },
      ],
      OPTIONS,
    );
    expect(only(svg, "nm-coverage").width).toBe("2");
    expect(texts(svg)).toContain("no data yet");
  });

  it("returns No data when no source has data", () => {
    const empty = renderCoverage(
      [{ source: "status_line", span: { from: null, to: null } }],
      OPTIONS,
    );
    expect(texts(empty)).toEqual(["No data"]);
    expect(renderCoverage([], OPTIONS)).toContain(">No data<");
  });
});

describe("renderLockouts", () => {
  // Width 600: bars from 124, 600 - 124 - 110 = 366 wide.
  const svg = renderLockouts(LOCKOUTS, OPTIONS);

  it("draws each lockout on one duration axis with its hit lines", () => {
    // Longest 3600 s: steps of 60 (60 ticks) and 300 (12) are too many; 600 needs 6. Axis 0 to 3600.
    const bars = byClass(svg, "nm-lockout").map((t) => t.attrs);
    // 3600 / 3600 * 366 = 366; 1800 / 3600 * 366 = 183.
    expect(bars.map((b) => b.width)).toEqual(["366", "183"]);
    expect(bars.map((b) => b["data-events"])).toEqual(["5", "6 7"]);
    // Rows 28 apart from 8, bars 6 into the row: 14 and 42.
    expect(bars.map((b) => b.y)).toEqual(["14", "42"]);
    expect(texts(svg)).toEqual(
      expect.arrayContaining(["0", "10 m", "30 m", "1 h", "1 h 0 m, 1 hit", "30 m 0 s, 2 hits"]),
    );
  });

  it("states the span and what followed each reset", () => {
    expect(texts(svg)).toContain("Lockouts 2026-09-03 12:00 to 2026-09-04 09:30 (UTC)");
    expect(svg).toContain(
      "<title>Elapsed lockout time 1 h 0 m, 2026-09-03 12:00 to 13:00 (UTC), 1 limit hit; 5 m 0 s reset to next Claude Code request</title>",
    );
    expect(svg).toContain("2 limit hits; the reset came after the logs end</title>");
    // bottom = 8 + 2 * 28 = 64; height 64 + 40 = 104.
    expect(svg).toContain('viewBox="0 0 600 104"');
  });

  it("says when no request followed a reset inside the logs, and labels hour and day ticks", () => {
    const twoHours = renderLockouts(
      [
        {
          ...LOCKOUTS[0]!,
          seconds: 7200,
          resetToNextRequestSeconds: null,
          resetAfterCoverage: false,
        },
      ],
      OPTIONS,
    );
    expect(twoHours).toContain("no Claude Code request followed the reset");
    // 7200 s: steps 600 (12) and 900 (8) are too many, 1800 needs 4; ticks 0, 30 m, 1 h, 90 m, 2 h.
    expect(texts(twoHours)).toEqual(expect.arrayContaining(["30 m", "90 m", "2 h"]));
    const threeDays = renderLockouts([{ ...LOCKOUTS[0]!, seconds: 259_200 }], OPTIONS);
    // 259,200 s: 43,200 (12 h) needs 6 ticks; labels 12 h, 1 d, ..., 3 d.
    expect(texts(threeDays)).toEqual(expect.arrayContaining(["12 h", "1 d", "3 d"]));
    const halfYear = renderLockouts([{ ...LOCKOUTS[0]!, seconds: 2_419_200 * 7 }], OPTIONS);
    // Past six four-week steps: step 4 weeks * ceil(7 / 6) = 8 weeks = 56 d.
    expect(texts(halfYear)).toContain("56 d");
  });

  it("returns No data for no lockouts", () => {
    const empty = renderLockouts([], OPTIONS);
    expect(texts(empty)).toEqual(["No data"]);
    expect(empty).not.toContain("data-events");
  });
});

describe("renderModelBars", () => {
  const svg = renderModelBars(MODELS, OPTIONS);

  it("scales bars to the most output tokens, after a label column sized to the longest name", () => {
    // Longest label 13 characters: 13 * 6.6 + 12 = 97.8. Bars 600 - 97.8 - 90 = 412.2 wide at most.
    const bars = byClass(svg, "nm-model").map((t) => t.attrs);
    expect(bars.map((b) => b.x)).toEqual(["97.8", "97.8"]);
    // 360 / 360 * 412.2 = 412.2; 90 / 360 * 412.2 = 103.05.
    expect(bars.map((b) => b.width)).toEqual(["412.2", "103.05"]);
    expect(bars.map((b) => b["data-events"])).toEqual(["2 4 10", "1"]);
    expect(svg).toContain("<title>claude-opus-5: 360 output tokens from 3 requests</title>");
  });

  it("escapes a model name containing < and &", () => {
    expect(svg).toContain(">claude-&lt;x&gt;&amp;y<");
    expect(svg).toContain("<title>claude-&lt;x&gt;&amp;y: 90 output tokens from 1 request</title>");
    expect(svg).not.toContain("<x>");
    expect(svg).not.toContain("&y");
  });

  it("shortens a long name in its label but keeps it whole in the title, and escapes control characters", () => {
    const long = `claude-${"a".repeat(40)}`;
    const out = renderModelBars(
      [
        { model: long, requests: 1, outputTokens: 0, events: [3] },
        { model: "a\nb", requests: 1, outputTokens: 0, events: [4] },
      ],
      OPTIONS,
    );
    // 32 characters at most: the first 29 and "...".
    expect(texts(out)).toContain(`${long.slice(0, 29)}...`);
    expect(out).toContain(`<title>${long}: 0 output tokens`);
    expect(texts(out)).toContain("a\\nb");
    // No output tokens anywhere: bars are empty rather than divided by zero.
    expect(byClass(out, "nm-model").map((t) => t.attrs.width)).toEqual(["0", "0"]);
  });

  it("writes a non-ASCII model name as character references, so the SVG stays ASCII (D-063)", () => {
    // "claude-caf" followed by e-acute, U+00E9; written as an escape so this source stays ASCII.
    const out = renderModelBars([{ ...MODELS[1]!, model: "claude-caf\u00e9" }], OPTIONS);
    // U+00E9 is hex e9, so the reference is &#xe9; in both the row label and the title.
    expect(texts(out)).toContain("claude-caf&#xe9;");
    expect(out).toContain("<title>claude-caf&#xe9;: 90 output tokens from 1 request</title>");
    // Not one character above 0x7E anywhere in the chart.
    expect(out).toMatch(/^[\x20-\x7e]*$/);
  });

  it("writes one reference per code point, and a lone surrogate as U+FFFD", () => {
    const out = renderModelBars(
      [
        // U+1F600 is one code point in two UTF-16 units: one reference, &#x1f600;, not two.
        { model: "m\u{1f600}", requests: 1, outputTokens: 1, events: [1] },
        // A lone high surrogate names no character; XML allows no reference to it, so U+FFFD.
        { model: "s\ud800", requests: 1, outputTokens: 1, events: [2] },
        // U+0085 is a C1 control: printable() has already made it the visible \x85, not a reference.
        { model: "c\u0085", requests: 1, outputTokens: 1, events: [3] },
      ],
      OPTIONS,
    );
    expect(texts(out)).toEqual(expect.arrayContaining(["m&#x1f600;", "s&#xfffd;", "c\\x85"]));
    expect(out).not.toContain("&#xd800;");
    expect(out).toMatch(/^[\x20-\x7e]*$/);
  });

  it("returns No data for no models", () => {
    expect(texts(renderModelBars([], OPTIONS))).toEqual(["No data"]);
  });
});

describe("renderMonthBars", () => {
  const svg = renderMonthBars(MONTHS, OPTIONS);

  it("draws a column per month on a dollar axis that covers the bars and the plan price", () => {
    // Highest 120: base 10^floor(log10(24)) = 10; steps 10 (12) and 20 (6) are too many; 50 needs 3.
    // Axis $0 to $150. y(v) = 24 + (150 - v) / 150 * 180 = 24 + 1.2 (150 - v). Baseline y(0) = 204.
    const bar = only(svg, "nm-month");
    // y(120) = 24 + 36 = 60; height 204 - 60 = 144.
    expect(bar.y).toBe("60");
    expect(bar.height).toBe("144");
    // slot = 532 / 2 = 266, width min(40, 133) = 40; centre 56 + 133 = 189, so x = 169.
    expect(bar.x).toBe("169");
    expect(bar["data-events"]).toBe("1 2");
    expect(texts(svg)).toEqual(expect.arrayContaining(["$0", "$50", "$100", "$150", "$120.00"]));
  });

  it("draws the plan price as a dashed line only for the month that has one", () => {
    const plan = only(svg, "nm-plan");
    // y(100) = 24 + 60 = 84; from 189 - 20 - 8 = 161 to 189 + 20 + 8 = 217.
    expect(plan.y1).toBe("84");
    expect([plan.x1, plan.x2]).toEqual(["161", "217"]);
    expect(plan["stroke-dasharray"]).toBe("4 3");
    expect(texts(svg)).toContain("Example plan $100.00");
    const noPlan = renderMonthBars(
      [{ ...MONTHS[0]!, planName: null, planUsdPerMonth: null }],
      OPTIONS,
    );
    expect(byClass(noPlan, "nm-plan")).toEqual([]);
  });

  it("shows unknown, not a $0 column, for a month with nothing priced (D-005)", () => {
    // The second month's centre: 56 + 266 * 1.5 = 455; "unknown" 6 above the baseline: 198.
    expect(svg).toMatch(/<text x="455" y="198"[^>]*>unknown<\/text>/);
    expect(byClass(svg, "nm-month")).toHaveLength(1);
  });

  it("labels itself projected and states the months' span", () => {
    expect(tags(svg)[0]?.attrs["aria-label"]).toBe(
      "Observed tokens at API list price, by month (projected). Months 2026-08-10 00:00 to 2026-09-03 13:05 (UTC)",
    );
    expect(svg).toContain(
      "<title>Projected: observed tokens at API list price for 2026-08, $120.00;",
    );
    expect(svg).toContain("0 unpriced requests (not counted as $0)");
  });

  it("uses decimal ticks for amounts under a dollar and a $1 axis when nothing is priced", () => {
    const cents = renderMonthBars(
      [{ ...MONTHS[0]!, apiListPriceUsd: 0.012, planUsdPerMonth: null }],
      OPTIONS,
    );
    // Highest 0.012: base 10^floor(log10(0.0024)) = 0.001; steps 0.001 (12), 0.002 (6) too many;
    // 0.005 needs 3. Three decimals: ceil(-log10(0.005)) = ceil(2.3) = 3.
    expect(texts(cents)).toEqual(expect.arrayContaining(["$0.000", "$0.005", "$0.010", "$0.015"]));
    const nothing = renderMonthBars([MONTHS[1]!], OPTIONS);
    expect(texts(nothing)).toEqual(expect.arrayContaining(["$0", "$1", "unknown"]));
    const noSpan = renderMonthBars([{ ...MONTHS[1]!, span: { from: null, to: null } }], OPTIONS);
    expect(texts(noSpan)).toContain("Months no data yet");
  });

  it("returns No data for no months", () => {
    expect(texts(renderMonthBars([], OPTIONS))).toEqual(["No data"]);
  });
});

describe("every chart", () => {
  const outputs: Record<string, string> = {
    coverage: renderCoverage(
      [
        {
          source: "session_logs",
          span: { from: "2026-09-03T10:00:00.000Z", to: "2026-09-03T13:05:10.000Z" },
        },
      ],
      OPTIONS,
    ),
    gauge: renderGauge(GAUGE_INPUT, OPTIONS),
    series: renderWindowSeries(SERIES, OPTIONS),
    lockouts: renderLockouts(LOCKOUTS, OPTIONS),
    models: renderModelBars(MODELS, OPTIONS),
    // A model name outside ASCII (e-acute, U+00E9), so the ASCII guard below sees one (D-063).
    nonAsciiModels: renderModelBars([{ ...MODELS[0]!, model: "claude-caf\u00e9" }], OPTIONS),
    months: renderMonthBars(MONTHS, OPTIONS),
    emptyCoverage: renderCoverage([], OPTIONS),
    emptyGauge: renderGauge([], OPTIONS),
    emptySeries: renderWindowSeries({ ...SERIES, points: [], hits: [] }, OPTIONS),
    emptyLockouts: renderLockouts([], OPTIONS),
    emptyModels: renderModelBars([], OPTIONS),
    emptyMonths: renderMonthBars([], OPTIONS),
  };
  const all = Object.entries(outputs);

  /** The page's theme tokens (G1.3 defines them for light and dark). */
  const TOKENS = [
    "ink",
    "ink-2",
    "muted",
    "grid",
    "axis",
    "sunken",
    "surface",
    "water",
    "water-deep",
    "silt",
    "limit",
  ];

  it.each(all)("%s is one root svg with role, label, viewBox width, and aspect ratio", (_, svg) => {
    const root = tags(svg)[0];
    expect(root?.tag).toBe("svg");
    expect(root?.attrs.role).toBe("img");
    expect(root?.attrs["aria-label"]).not.toBe("");
    expect(root?.attrs.viewBox).toMatch(/^0 0 600 \d+(\.\d+)?$/);
    expect(root?.attrs.preserveAspectRatio).toBe("xMinYMin meet");
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg.match(/<svg/g)).toHaveLength(1);
  });

  it.each(all)("%s uses only the page's color tokens, never a literal color", (_, svg) => {
    const allowed = ["none", ...TOKENS.map((token) => `var(--${token})`)];
    const painted = tags(svg).flatMap((t) => [t.attrs.fill, t.attrs.stroke]);
    // Every fill and stroke is a CSS variable the page defines, or none.
    expect(painted.filter((v) => v !== undefined && !allowed.includes(v))).toEqual([]);
    expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(svg).not.toMatch(/rgba?\(|hsla?\(|\b(white|black|red|blue|green)\b/i);
    expect(svg).not.toContain("style=");
  });

  it.each(all)("%s references no network address and is ASCII only (D-063, D-070)", (_, svg) => {
    expect(svg).not.toMatch(/https?:|\/\/|url\(|@import|<script|href|src=/i);
    expect(svg).toMatch(/^[\x20-\x7e]*$/);
  });

  it.each(all)("%s gives every drawn data element its events and a title", (_, svg) => {
    const data = [...svg.matchAll(/<(\w+)[^>]*\bclass="nm-data[^"]*"[^>]*>/g)];
    for (const m of data) {
      expect(m[0]).toMatch(/ data-events="[\d ]*"/);
      expect(m[0].endsWith("/>")).toBe(false);
      expect(svg.startsWith("<title>", (m.index ?? 0) + m[0].length)).toBe(true);
    }
    // Every element carrying events is a data element or a gauge column that groups them.
    for (const t of tags(svg).filter((x) => x.attrs["data-events"] !== undefined)) {
      expect(t.attrs.class).toMatch(/^(nm-data |nm-col$)/);
    }
    // No element offers an empty events list: the page would open a panel with nothing in it.
    expect(svg).not.toContain('data-events=""');
    // A coverage bar draws a span, not events: a title and no data-events.
    for (const m of svg.matchAll(/<rect[^>]*\bclass="nm-coverage"[^>]*>/g)) {
      expect(m[0]).not.toContain("data-events");
      expect(svg.startsWith("<title>", (m.index ?? 0) + m[0].length)).toBe(true);
    }
    // Every gauge column names itself for the events panel, as it does for a screen reader.
    for (const col of byClass(svg, "nm-col")) {
      expect(col.attrs["data-label"]).toBe(col.attrs["aria-label"]);
    }
  });

  it.each(all)(
    "%s uses none of the banned framings and draws no other plan's limit (D-009, D-012)",
    (_, svg) => {
      const banned = [
        "time lost",
        "wasted",
        "would have spent",
        "you should switch plans",
        "savings",
        "cheaper by",
        "verdict",
        "recommend",
        "score",
        "efficiency",
        "productivity",
      ];
      for (const phrase of banned) {
        expect(svg.toLowerCase()).not.toContain(phrase);
      }
      expect(svg).not.toMatch(/\b(Pro|Max)\b/);
      expect(byClass(svg, "nm-limit").length).toBeLessThanOrEqual(1);
    },
  );

  it("is deterministic: the same input gives the same text", () => {
    expect(renderGauge(GAUGE_INPUT, OPTIONS)).toBe(outputs.gauge);
    expect(renderWindowSeries(SERIES, OPTIONS)).toBe(outputs.series);
    expect(renderMonthBars(MONTHS, OPTIONS)).toBe(outputs.months);
  });
});
