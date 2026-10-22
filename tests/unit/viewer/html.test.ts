/**
 * @file Unit tests for viewer/html.ts, the HTML report's page (step G1.3, D-070).
 *
 * The data is synthetic and built by hand below, modeled on the scenario in the header of
 * `html-fixture.ts` (session `s1`, the 12:00 limit hit resetting at 13:00, the 103% reading). Raw
 * line IDs are assigned by hand: 2, 4, 6, and 10 are requests r1 to r4, 8 is the limit hit h1, and
 * 11 to 14 are the four status line readings. Every expected value is worked out by hand in a
 * comment beside its assertion.
 *
 * The chart module is replaced by a mock that returns a labeled placeholder, so these tests check
 * the page's own wiring (which chart goes where, with which input and options) and never depend on
 * what a chart draws. The wording guards in `tests/wording/html-output.test.ts` run on the real
 * one.
 */
import { runInNewContext } from "node:vm";

import { beforeEach, describe, expect, it, vi } from "vitest";

import * as charts from "../../../viewer/html-charts.js";
import type {
  GaugeWindow,
  HtmlReportData,
  LockoutBar,
  MonthBar,
  RenderHtmlReport,
  WindowSeries,
} from "../../../viewer/html-contract.js";
import {
  EVENT_LIST_LIMIT,
  HTML_LABELS,
  embedJson,
  escapeHtml,
  mergeEvents,
  renderHtmlReport,
} from "../../../viewer/html.js";
import { LABELS, describeBurnRate } from "../../../viewer/render.js";

vi.mock("../../../viewer/html-charts.js", async (importOriginal) => ({
  // The sentence and the bar count are wording and layout the page shares with the charts; kept real.
  burnSentence: (await importOriginal<typeof import("../../../viewer/html-charts.js")>())
    .burnSentence,
  REPO_BARS: 10,
  renderRepoBars: vi.fn(() => '<svg id="chart-repos"></svg>'),
  renderBurnRate: vi.fn(
    (input: { burn: { window: string } }) => `<svg id="chart-burn-${input.burn.window}"></svg>`,
  ),
  renderCoverage: vi.fn(() => '<svg id="chart-coverage"></svg>'),
  renderGauge: vi.fn(() => '<svg id="chart-gauge"></svg>'),
  renderWindowSeries: vi.fn(
    (series: WindowSeries) => `<svg id="chart-series-${series.window}"></svg>`,
  ),
  renderLockouts: vi.fn(() => '<svg id="chart-lockouts"></svg>'),
  renderModelBars: vi.fn(() => '<svg id="chart-models"></svg>'),
  renderMonthBars: vi.fn(() => '<svg id="chart-months"></svg>'),
}));

/**
 * Places a time on the scenario's day.
 * @param time - `HH:MM:SS` UTC.
 * @returns ISO-8601 UTC with milliseconds, as the views return it.
 */
const at = (time: string): string => `2026-09-03T${time}.000Z`;

/** The first five_hour window: three readings (20, 60, 103) and the 12:00 hit, reset at 13:00. */
const FIRST_WINDOW: GaugeWindow = {
  window: "five_hour",
  resetAtUtc: at("13:00:00"),
  open: false,
  peak: 103,
  peakAtUtc: at("11:58:00"),
  last: 103,
  lastAtUtc: at("11:58:00"),
  readings: 3,
  limitHits: 1,
  peakEvents: [13],
  lastEvents: [13],
  hitEvents: [8],
};

/** Synthetic report data for the scenario, as `loadHtmlData` would return it. */
const DATA: HtmlReportData = {
  timeZone: "UTC",
  lastIngestAt: at("13:10:00"),
  generatedAtUtc: at("14:00:00"),
  coverage: [
    { source: "session_logs", span: { from: at("10:00:00"), to: at("13:05:10") } },
    { source: "status_line", span: { from: at("10:00:05"), to: at("13:05:10") } },
  ],
  gauge: [
    FIRST_WINDOW,
    {
      window: "five_hour",
      resetAtUtc: at("18:00:00"),
      open: true,
      peak: 2,
      peakAtUtc: at("13:05:10"),
      last: 2,
      lastAtUtc: at("13:05:10"),
      readings: 1,
      limitHits: 0,
      peakEvents: [14],
      lastEvents: [14],
      hitEvents: [],
    },
    {
      window: "seven_day",
      resetAtUtc: "2026-09-10T00:00:00.000Z",
      open: true,
      peak: 16,
      peakAtUtc: at("13:05:10"),
      last: 16,
      lastAtUtc: at("13:05:10"),
      readings: 4,
      limitHits: 0,
      peakEvents: [14],
      lastEvents: [14],
      hitEvents: [],
    },
  ],
  series: [
    {
      window: "five_hour",
      resetAtUtc: at("13:00:00"),
      points: [
        { atUtc: at("10:00:05"), used: 20, event: 11, stale: false },
        { atUtc: at("10:00:20"), used: 60, event: 12, stale: false },
        { atUtc: at("11:58:00"), used: 103, event: 13, stale: false },
      ],
      hits: [{ atUtc: at("12:00:00"), event: 8 }],
    },
    {
      window: "five_hour",
      resetAtUtc: at("18:00:00"),
      points: [{ atUtc: at("13:05:10"), used: 2, event: 14, stale: false }],
      hits: [],
    },
    {
      window: "seven_day",
      resetAtUtc: "2026-09-10T00:00:00.000Z",
      points: [
        { atUtc: at("10:00:05"), used: 10, event: 11, stale: false },
        { atUtc: at("10:00:20"), used: 12, event: 12, stale: false },
        { atUtc: at("11:58:00"), used: 15, event: 13, stale: false },
        { atUtc: at("13:05:10"), used: 16, event: 14, stale: false },
      ],
      hits: [],
    },
  ],
  lockouts: [
    {
      lockedFromUtc: at("12:00:00"),
      lockedUntilUtc: at("13:00:00"),
      seconds: 3600,
      hits: 1,
      refusedRequests: 1,
      sessions: 1,
      resetToNextRequestSeconds: 310,
      resetAfterCoverage: false,
      events: [8],
      // r4 at 13:05:10 is the first request after the 13:00 reset: 310 s later.
      nextRequestEvents: [10],
      autoContinuations: 0,
      firstAutoContinuationSeconds: null,
      autoContinuationEvents: [],
    },
  ],
  // The one hit h1, logged, in the 5-hour window, inside its lockout: nothing in any caveat.
  interruptions: {
    hits: 1,
    fiveHourHits: 1,
    sevenDayHits: 0,
    unknownWindowHits: 0,
    loggedHits: 1,
    statusLineOnlyHits: 0,
    lockoutSeconds: 3600,
    lockoutIntervals: 1,
    hitsWithUnknownReset: 0,
    unknownResetEvents: [],
    hitsInNoColumn: 0,
    hitsInNoColumnEvents: [],
    events: [8],
    fiveHourEvents: [8],
    sevenDayEvents: [],
    unknownWindowEvents: [],
    loggedEvents: [8],
    statusLineOnlyEvents: [],
    span: { from: at("10:00:00"), to: at("13:05:10") },
    byPlan: [],
  },
  afterReset: { count: 0, events: [] },
  crossings: [],
  models: [
    { model: "claude-opus-5", requests: 3, outputTokens: 360, events: [4, 6, 10] },
    { model: "claude-sonnet-5", requests: 1, outputTokens: 100, events: [2] },
  ],
  // The scenario logs no cwd, so all four requests share one unresolved repository (step G2.1).
  repos: [
    { repository: null, kind: "unresolved", requests: 4, outputTokens: 460, events: [2, 4, 6, 10] },
  ],
  home: "",
  missingHookPath: null,
  repositoryAliases: [],
  // Both windows open at the last reading (13:05:10), latest reset first, as the text report lists them.
  // 7-day: 16% after 13 h 5 m 10 s (47,110 s), so 16 / (47110 / 3600) points per hour, reaching
  // 100% at 2026-09-03 00:00 + 100 * 47110 / 16 s = 2026-09-06 09:47:17.5. 5-hour: 2% after 310 s,
  // so 2 / (310 / 3600) points per hour, reaching 100% at 13:00 + 100 * 310 / 2 s = 17:18:20.
  burn: [
    {
      window: "seven_day",
      resetAtUtc: "2026-09-10T00:00:00.000Z",
      windowStartUtc: "2026-09-03T00:00:00.000Z",
      last: 16,
      lastAtUtc: at("13:05:10"),
      limitReached: false,
      ratePerHour: 16 / (47110 / 3600),
      projectedLimitAtUtc: "2026-09-06T09:47:17.500Z",
      limitBeforeReset: true,
      span: { from: at("10:00:05"), to: at("13:05:10") },
      events: [14],
    },
    {
      window: "five_hour",
      resetAtUtc: at("18:00:00"),
      windowStartUtc: at("13:00:00"),
      last: 2,
      lastAtUtc: at("13:05:10"),
      limitReached: false,
      ratePerHour: 2 / (310 / 3600),
      projectedLimitAtUtc: at("17:18:20"),
      limitBeforeReset: true,
      span: { from: at("10:00:05"), to: at("13:05:10") },
      events: [14],
    },
  ],
  months: [
    {
      month: "2026-09",
      apiListPriceUsd: 0.0123,
      planName: null,
      planUsdPerMonth: null,
      pricedRequests: 4,
      unpricedRequests: 0,
      unpricedEvents: [],
      span: { from: at("10:00:05"), to: at("13:05:10") },
      events: [2, 4, 6, 10],
    },
  ],
  priceNotes: { rateReadings: [], lowerBoundRequests: 0, lowerBoundEvents: [] },
  files: ["-fixture-html/s1.jsonl", "status-line/readings.jsonl"],
  events: {
    2: { file: 0, line: 2, atUtc: at("10:00:05") },
    4: { file: 0, line: 4, atUtc: at("10:00:20") },
    6: { file: 0, line: 6, atUtc: at("11:58:00") },
    8: { file: 0, line: 8, atUtc: at("12:00:00") },
    10: { file: 0, line: 10, atUtc: at("13:05:10") },
    11: { file: 1, line: 1, atUtc: at("10:00:05") },
    12: { file: 1, line: 2, atUtc: at("10:00:20") },
    13: { file: 1, line: 3, atUtc: at("11:58:00") },
    14: { file: 1, line: 4, atUtc: at("13:05:10") },
  },
};

/** The same report with nothing recorded: no windows, no lockouts, no requests. */
const EMPTY: HtmlReportData = {
  ...DATA,
  lastIngestAt: null,
  coverage: [
    { source: "session_logs", span: { from: null, to: null } },
    { source: "status_line", span: { from: null, to: null } },
  ],
  gauge: [],
  series: [],
  lockouts: [],
  interruptions: {
    ...DATA.interruptions,
    hits: 0,
    fiveHourHits: 0,
    loggedHits: 0,
    lockoutSeconds: 0,
    lockoutIntervals: 0,
    events: [],
    span: { from: null, to: null },
  },
  models: [],
  repos: [],
  burn: [],
  months: [],
  files: [],
  events: {},
};

/**
 * Cuts one section out of a page by its `id`.
 * @param html - The page.
 * @param id - The section's `id`.
 * @returns From the section's opening tag to the next `</section>`; empty when absent.
 */
function section(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  return start < 0 ? "" : html.slice(start, html.indexOf("</section>", start));
}

/**
 * Cuts a table view out of a section by its caption.
 * @param html - Any HTML.
 * @param caption - The table's caption, escaped as the page writes it.
 * @returns The `<tbody>` of that table; empty when absent.
 */
function tbody(html: string, caption: string): string {
  const start = html.indexOf(`<caption>${caption}</caption>`);
  return start < 0
    ? ""
    : html.slice(html.indexOf("<tbody>", start), html.indexOf("</tbody>", start));
}

/** What the page's script exposes to Node, run without a document. */
interface PageHelpers {
  /** Formats an instant in a zone. */
  formatAt(iso: string | null, zone: string): string;
  /** Parses a `data-events` value. */
  parseIds(text: string): number[];
  /** Merges ID lists. */
  union(lists: number[][]): number[];
  /** Lists events as `explain` prints them. */
  eventLines(
    ids: number[],
    data: { timeZone: string; files: string[]; events: HtmlReportData["events"] },
    limit: number,
  ): { lines: string[]; more: number };
  /** Names a selected element for its panel. */
  labelOf(el: FakeElement): string;
  /** Picks the tab a page address names (step G2.1). */
  tabFromHash(hash: string, keys: string[]): string;
  /** The tab a key moves to, or -1 (step G2.1). */
  nextTab(index: number, key: string, count: number): number;
}

/** The parts of a DOM element the script's `labelOf` reads, so Node can stand one in. */
interface FakeElement {
  /** Whether the attribute is present. */
  hasAttribute(name: string): boolean;
  /** The attribute's value, or null. */
  getAttribute(name: string): string | null;
  /** Child elements. */
  readonly children: readonly { readonly tagName: string; readonly textContent: string }[];
}

/**
 * Builds a stand-in element for the script's `labelOf`.
 * @param attrs - Its attributes.
 * @param children - Its child elements, by tag name and text.
 * @returns An object with the DOM methods `labelOf` calls.
 */
function fakeElement(
  attrs: Record<string, string>,
  children: FakeElement["children"] = [],
): FakeElement {
  return {
    hasAttribute: (name) => name in attrs,
    getAttribute: (name) => attrs[name] ?? null,
    children,
  };
}

/** One table view, parsed: its column headers and, per row, each cell's attributes and text. */
interface ParsedTable {
  /** The caption. */
  readonly caption: string;
  /** Column headers, in order. */
  readonly headers: string[];
  /** Rows of cells. */
  readonly rows: { readonly attrs: string; readonly text: string }[][];
}

/**
 * Parses every table view in a page, so a test can check each cell against its column.
 * @param html - The page.
 * @returns The tables, in page order.
 */
function parseTables(html: string): ParsedTable[] {
  return [...html.matchAll(/<table>([\s\S]*?)<\/table>/g)].map((match) => {
    const table = match[1] ?? "";
    const body = table.slice(table.indexOf("<tbody>"));
    return {
      caption: /<caption>([^<]*)<\/caption>/.exec(table)?.[1] ?? "",
      // A number column's header carries class="num" (right-aligned over its numbers).
      headers: [...table.matchAll(/<th scope="col"(?: class="num")?>([^<]*)<\/th>/g)].map(
        (m) => m[1] ?? "",
      ),
      rows: body
        .split("<tr>")
        .slice(1)
        .map((row) =>
          [...row.matchAll(/<td([^>]*)>([^<]*)<\/td>/g)].map((m) => ({
            attrs: m[1] ?? "",
            text: m[2] ?? "",
          })),
        ),
    };
  });
}

/**
 * Runs the page's inline script in a fresh Node context with no `document`, so only its pure
 * helpers are defined.
 * @param html - The page.
 * @returns The script's `NM` object, with results copied into this realm.
 */
function pageHelpers(html: string): PageHelpers {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  const context: { NM?: PageHelpers } = {};
  runInNewContext(script, context);
  const nm = context.NM as PageHelpers;
  /**
   * Copies a value made in the script's context into this one, so `toEqual` compares plain data.
   * @param value - A result from the script.
   * @returns The same data, in this realm.
   */
  const here = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    formatAt: (iso, zone) => nm.formatAt(iso, zone),
    parseIds: (text) => here(nm.parseIds(text)),
    union: (lists) => here(nm.union(lists)),
    eventLines: (ids, data, limit) => here(nm.eventLines(ids, data, limit)),
    labelOf: (el) => nm.labelOf(el),
    tabFromHash: (hash, keys) => nm.tabFromHash(hash, keys),
    nextTab: (index, key, count) => nm.nextTab(index, key, count),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * States a burn window in the text report's own words, independently of the page, for comparison.
 * @param burn - A burn window from the test data.
 * @returns describeBurnRate's sentence, unindented.
 */
function burnSentenceFor(burn: HtmlReportData["burn"][number]): string {
  return describeBurnRate(
    {
      window: burn.window,
      reset_at_utc: burn.resetAtUtc,
      window_start_utc: burn.windowStartUtc,
      last_used_percentage: burn.last,
      last_reading_at_utc: burn.lastAtUtc,
      window_open: 1,
      open_at_report: 1,
      limit_reached: burn.limitReached ? 1 : 0,
      projected_percentage_points_per_hour: burn.ratePerHour,
      projected_limit_at_utc: burn.projectedLimitAtUtc,
      projected_limit_before_reset: burn.limitBeforeReset ? 1 : 0,
      covers_from: burn.span.from,
      covers_to: burn.span.to,
    },
    "UTC",
  ).trim();
}

describe("the page shell", () => {
  it("returns one complete document with a doctype, language, charset, viewport, and title", () => {
    const html = renderHtmlReport(DATA);
    expect(
      html.startsWith('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">'),
    ).toBe(true);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain("<title>Claude subscription usage | Nilometer</title>");
    expect(html.endsWith("</body>\n</html>\n")).toBe(true);
  });

  it("satisfies the contract's signature and renders the same page for the same data", () => {
    const typed: RenderHtmlReport = renderHtmlReport;
    expect(typed(DATA)).toBe(renderHtmlReport(DATA));
  });

  it("defines every shared theme token for light and again for dark, and paints the body from one", () => {
    const html = renderHtmlReport(DATA);
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    const dark = style.slice(style.indexOf("@media (prefers-color-scheme: dark)"));
    for (const token of [
      "page",
      "surface",
      "sunken",
      "ink",
      "ink-2",
      "muted",
      "grid",
      "axis",
      "water",
      "water-deep",
      "silt",
      "limit",
    ]) {
      // Once in :root for light, once more under the dark media query.
      expect(style.split(`--${token}:`)).toHaveLength(3);
      expect(dark).toContain(`--${token}:`);
    }
    expect(style).toMatch(/body \{[^}]*background: var\(--page\)/);
  });

  it("keeps an open table from widening the page on a phone: the table scrolls inside its box", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(renderHtmlReport(DATA))?.[1] ?? "";
    // A details element in a grid would otherwise grow to its table's width (min-width: auto).
    expect(style).toContain("details.nm-table, .nm-series { min-width: 0; max-width: 100%; }");
    expect(style).toContain(".table-scroll { overflow-x: auto; max-width: 100%;");
  });
});

describe("explanations behind an i beside each heading (D-091)", () => {
  const html = renderHtmlReport(DATA);

  it("gives each explained section one button that names what it explains and controls its text", () => {
    for (const [id, heading] of [
      ["nm-gauge", LABELS.windows],
      ["nm-lockouts", HTML_LABELS.lockoutElapsed],
      ["nm-repos", HTML_LABELS.repos],
      ["nm-months", LABELS.apiListPrice],
    ] as const) {
      const part = section(html, id);
      expect(part).toContain(
        `<button type="button" class="nm-info-btn" aria-expanded="false" aria-controls="${id}-info" aria-label="${escapeHtml(`About: ${heading}`)}">i</button>`,
      );
      expect(part).toContain(`<span class="nm-info-text" id="${id}-info" role="note">`);
    }
    // The usage windows' explanations, in order: how to read the values, "open", how to select.
    expect(section(html, "nm-gauge")).toContain(
      `<span>${escapeHtml(`${LABELS.windowsCaveat} ${HTML_LABELS.over100}`)}</span><span>${escapeHtml(LABELS.openNote)}</span><span>${escapeHtml(HTML_LABELS.seriesHint)}</span>`,
    );
  });

  it("opens on hover, keyboard focus, or the script's tap toggle, and prints every one in full", () => {
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(style).toContain(
      ".nm-info:hover .nm-info-text, .nm-info:focus-within .nm-info-text, .nm-info.nm-open .nm-info-text { display: block; }",
    );
    const print = style.slice(style.indexOf("@media print"));
    expect(print).toContain(".nm-info-btn { display: none; }");
    expect(print).toContain(".nm-info-text { display: block; position: static;");
    // Paper can't scroll a table's box, so its cells wrap there (2026-10-22 print check).
    expect(print).toContain("td { white-space: normal; }");
    // A narrow screen opens it as a sheet along the bottom, not off the right edge.
    expect(style).toContain(
      ".nm-info-text { position: fixed; left: 12px; right: 12px; top: auto; bottom: 12px;",
    );
    // The script toggles the class and aria-expanded together, and Escape closes every one.
    expect(html).toContain('button.setAttribute("aria-expanded", String(opening));');
    expect(html).toContain('if (e.key === "Escape") { closeInfo(null); }');
  });

  it("keeps the caveats that change what a number means in the body, not behind the i", () => {
    expect(section(html, "nm-lockouts")).toContain(
      `<p class="caveat">${escapeHtml(HTML_LABELS.lockoutCaveat)}</p>`,
    );
    expect(section(html, "nm-months")).toContain(escapeHtml(HTML_LABELS.notABill));
    // "A lower bound" stays in the gauge's legend.
    expect(section(html, "nm-gauge")).toContain(escapeHtml(HTML_LABELS.legendLast));
    expect(HTML_LABELS.legendLast).toContain("lower bound");
  });
});

describe("the header", () => {
  it("states the zone, the last ingest, and when the report was produced", () => {
    // 13:10:00Z and 14:00:00Z shown in UTC.
    expect(renderHtmlReport(DATA)).toContain(
      "Times are in UTC. Last ingest: 2026-09-03 13:10. Report produced: 2026-09-03 14:00.",
    );
  });

  it("converts the header times to the display zone", () => {
    // America/Denver is UTC-6 in September (MDT): 13:10Z is 07:10 and 14:00Z is 08:00.
    const html = renderHtmlReport({ ...DATA, timeZone: "America/Denver" });
    expect(html).toContain(
      "Times are in America/Denver. Last ingest: 2026-09-03 07:10. Report produced: 2026-09-03 08:00.",
    );
  });

  it("says none yet when nothing has been ingested", () => {
    expect(renderHtmlReport(EMPTY)).toContain("Last ingest: none yet.");
  });

  it("warns in the header when the status line's hook file is missing, in the text report's words (D-081)", () => {
    const html = renderHtmlReport({
      ...DATA,
      home: "/home/example",
      missingHookPath: "/home/example/old/hooks/statusline.sh",
    });
    const header = html.slice(html.indexOf('<header class="nm-head">'), html.indexOf("</header>"));
    expect(header).toContain('<div class="hook-warning" role="note">');
    expect(header).toContain(`<p class="caveat">${escapeHtml(LABELS.hookMissing)}</p>`);
    expect(header).toContain('<p class="meta">Missing hook file: ~/old/hooks/statusline.sh</p>');
    // Above the privacy note, so it's the first thing read after the times.
    expect(header.indexOf("hook-warning")).toBeLessThan(header.indexOf('class="privacy"'));
    expect(renderHtmlReport(DATA)).not.toContain('class="hook-warning"');
  });

  it("carries the privacy note, since the file holds session IDs and paths (README Privacy)", () => {
    const html = renderHtmlReport(DATA);
    const header = html.slice(html.indexOf('<header class="nm-head">'), html.indexOf("</header>"));
    expect(header).toContain(`<p class="privacy">${escapeHtml(HTML_LABELS.privacy)}</p>`);
    expect(HTML_LABELS.privacy).toContain("session IDs");
  });
});

describe("the sections", () => {
  it("states each chart's span from the coverage rows", () => {
    const html = renderHtmlReport(DATA);
    // Session logs 10:00:00 to 13:05:10 and status line 10:00:05 to 13:05:10, both on one day in
    // UTC, so the second time drops its date and the minutes are truncated: 10:00 to 13:05.
    const both =
      "Covers: session logs 2026-09-03 10:00 to 13:05 (UTC); status line 2026-09-03 10:00 to 13:05 (UTC)";
    expect(section(html, "nm-coverage")).toContain(`<p class="span">${both}</p>`);
    expect(section(html, "nm-lockouts")).toContain(`<p class="span">${both}</p>`);
    expect(section(html, "nm-gauge")).toContain(
      '<p class="span">Covers: status line 2026-09-03 10:00 to 13:05 (UTC). Readings start when the collector is installed.</p>',
    );
    expect(section(html, "nm-models")).toContain(
      '<p class="span">Covers: session logs 2026-09-03 10:00 to 13:05 (UTC)</p>',
    );
    // The one month runs 10:00:05 to 13:05:10.
    expect(section(html, "nm-months")).toContain(
      '<p class="span">Covers: session logs 2026-09-03 10:00 to 13:05 (UTC)</p>',
    );
  });

  it("gives every chart a table view", () => {
    // Coverage 1, gauge 1, one per series (3), lockouts 1, models 1, repositories 1, burn rate 1,
    // months 1: 10 (D-084 added repositories and burn rate to the page).
    expect(renderHtmlReport(DATA).split('<details class="nm-table">')).toHaveLength(10 + 1);
  });

  it("places each chart in its own section with the chart options the page uses", () => {
    const html = renderHtmlReport(DATA);
    const options = { timeZone: "UTC", width: 960 };
    expect(section(html, "nm-coverage")).toContain('<svg id="chart-coverage">');
    expect(section(html, "nm-gauge")).toContain('<svg id="chart-gauge">');
    expect(section(html, "nm-lockouts")).toContain('<svg id="chart-lockouts">');
    expect(section(html, "nm-models")).toContain('<svg id="chart-models">');
    expect(section(html, "nm-months")).toContain('<svg id="chart-months">');
    expect(charts.renderCoverage).toHaveBeenCalledWith(DATA.coverage, options);
    expect(charts.renderGauge).toHaveBeenCalledWith(DATA.gauge, options);
    expect(charts.renderLockouts).toHaveBeenCalledWith(DATA.lockouts, options);
    expect(charts.renderModelBars).toHaveBeenCalledWith(DATA.models, options);
    expect(charts.renderMonthBars).toHaveBeenCalledWith(DATA.months, options);
    // Every window's series is drawn up front, one call each.
    expect(charts.renderWindowSeries).toHaveBeenCalledTimes(3);
    for (const series of DATA.series) {
      expect(charts.renderWindowSeries).toHaveBeenCalledWith(series, options);
    }
  });

  it("wraps each window's series in a closed container keyed like its gauge column", () => {
    const html = renderHtmlReport(DATA);
    const gauge = section(html, "nm-gauge");
    for (const key of [
      "five_hour|2026-09-03T13:00:00.000Z",
      "five_hour|2026-09-03T18:00:00.000Z",
      "seven_day|2026-09-10T00:00:00.000Z",
    ]) {
      expect(gauge).toContain(`<details class="nm-series" data-series="${key}">`);
    }
    expect(gauge).toContain(
      "<summary>5-hour window resetting 2026-09-03 13:00: readings over time</summary>",
    );
    expect(gauge).toContain(
      "<summary>weekly window resetting 2026-09-10 00:00: readings over time</summary>",
    );
    // The first window's readings run 10:00:05 to 11:58:00; its one hit, at 12:00:00, is stated
    // apart, so the status line isn't said to cover a time only the session log holds.
    expect(gauge).toContain(
      '<p class="span">Covers: status line 2026-09-03 10:00 to 11:58 (UTC); limit hits 2026-09-03 12:00 to 12:00 (UTC)</p>',
    );
    // The second window has one reading at 13:05:10 and no hits, so no hit span.
    expect(gauge).toContain(
      '<p class="span">Covers: status line 2026-09-03 13:05 to 13:05 (UTC)</p>',
    );
  });

  it("lists a window's readings and hits in time order, each cell carrying its event", () => {
    const body = tbody(
      renderHtmlReport(DATA),
      "5-hour window resetting 2026-09-03 13:00: readings over time",
    );
    const rows = body.split("<tr>").slice(1);
    // 20% at 10:00:05, 60% at 10:00:20, 103% at 11:58:00, then the hit at 12:00:00.
    expect(rows.map((row) => /<td class="num"[^>]*>([^<]*)</.exec(row)?.[1])).toEqual([
      "20%",
      "60%",
      "103%",
      "",
    ]);
    expect(rows[0]).toContain("<td>2026-09-03 10:00</td><td>Status line reading</td>");
    expect(rows[2]).toContain('data-events="13"');
    // The hit carries its event on its "Limit hit" cell and has no usage value.
    expect(rows[3]).toContain(
      '<td data-events="8" data-label="Event, 5-hour window resetting 2026-09-03 13:00, 2026-09-03 12:00">Limit hit</td><td class="num"></td>',
    );
  });

  it("orders readings and hits by time, a reading first on a tie, and gives an empty series no span", () => {
    const series: WindowSeries[] = [
      {
        window: "five_hour",
        resetAtUtc: at("13:00:00"),
        points: [
          { atUtc: at("12:00:00"), used: 100, event: 13, stale: false },
          { atUtc: at("12:30:00"), used: 101, event: 14, stale: false },
        ],
        hits: [{ atUtc: at("12:00:00"), event: 8 }],
      },
      { window: "seven_day", resetAtUtc: "2026-09-10T00:00:00.000Z", points: [], hits: [] },
    ];
    const html = renderHtmlReport({ ...DATA, series });
    const rows = tbody(html, "5-hour window resetting 2026-09-03 13:00: readings over time")
      .split("<tr>")
      .slice(1);
    // Equal instants keep their order: the reading (listed first) stays ahead of the hit.
    expect(rows[0]).toContain("Status line reading");
    expect(rows[1]).toContain("Limit hit");
    // The 12:30 reading comes after the hit although it is listed before it.
    expect(rows[2]).toContain("101%");
    expect(section(html, "nm-gauge")).toContain(
      '<p class="span">Covers: status line no data yet</p>',
    );
  });

  it("shows each window's peak, last reading, and hits with the events behind each", () => {
    const body = tbody(section(renderHtmlReport(DATA), "nm-gauge"), "Usage windows");
    const first = body.split("<tr>")[1] ?? "";
    // Peak 103 from reading 13, last 103 from reading 13, one hit from line 8.
    expect(first).toContain(
      '<td class="num" data-events="13" data-label="Peak, 5-hour window resetting 2026-09-03 13:00">103%</td>',
    );
    expect(first).toContain(
      '<td class="num" data-events="13" data-label="Last observed usage, 5-hour window resetting 2026-09-03 13:00">103%</td>',
    );
    expect(first).toContain(
      '<td class="num" data-events="8" data-label="Limit hits, 5-hour window resetting 2026-09-03 13:00">1</td>',
    );
    // Three counted readings, lines 11, 12, and 13: the window's series points.
    expect(first).toContain(
      '<td class="num" data-events="11 12 13" data-label="Readings, 5-hour window resetting 2026-09-03 13:00">3</td>',
    );
    expect(first).toContain("<td>reset</td>");
    const weekly = body.split("<tr>")[3] ?? "";
    expect(weekly).toContain("<td>weekly</td><td>2026-09-10 00:00</td>");
    expect(weekly).toContain("<td>open</td>");
    // Four weekly readings, lines 11 to 14.
    expect(weekly).toContain('data-events="11 12 13 14" data-label="Readings, weekly');
    expect(section(renderHtmlReport(DATA), "nm-gauge")).toContain(escapeHtml(LABELS.windowsCaveat));
  });

  it("gives a column whose series is missing an empty Readings list, not another window's", () => {
    // Only the weekly series is present; the first 5-hour column finds none by its identity.
    const html = renderHtmlReport({ ...DATA, series: [DATA.series[2] as WindowSeries] });
    const first = tbody(section(html, "nm-gauge"), "Usage windows").split("<tr>")[1] ?? "";
    expect(first).toContain(
      '<td class="num" data-events="" data-label="Readings, 5-hour window resetting 2026-09-03 13:00">3</td>',
    );
  });

  it("counts readings captured after their reset and hits in no column under the gauge", () => {
    const html = renderHtmlReport({
      ...DATA,
      afterReset: { count: 3, events: [15, 16, 17] },
      interruptions: { ...DATA.interruptions, hitsInNoColumn: 2, hitsInNoColumnEvents: [30, 31] },
    });
    const gauge = section(html, "nm-gauge");
    // The text report's phrase, with the three readings behind it.
    expect(gauge).toContain(
      `<p class="caveat" data-events="15 16 17" data-label="Readings captured after their window&#39;s reset">Readings captured after their window&#39;s reset, not counted: 3</p>`,
    );
    expect(gauge).toContain(
      '<p class="caveat" data-events="30 31" data-label="Limit hits in no column">2 limit hits aren&#39;t in any column: their windows are unknown, they have no time, or no counted window of their kind holds their time.</p>',
    );
    // A single hit reads in the singular.
    const one = renderHtmlReport({
      ...DATA,
      interruptions: { ...DATA.interruptions, hitsInNoColumn: 1, hitsInNoColumnEvents: [30] },
    });
    expect(section(one, "nm-gauge")).toContain(
      ">1 limit hit isn&#39;t in any column: its window is unknown, it has no time, or no counted window of its kind holds its time.</p>",
    );
    // Zero of each prints neither line, as the text report omits a zero after-reset count.
    const none = section(renderHtmlReport(DATA), "nm-gauge");
    expect(none).not.toContain("Readings captured after");
    expect(none).not.toContain("in any column");
  });

  it("counts hits in no column under an empty gauge too", () => {
    // No readings at all, so every hit is in no column: here 1.
    const html = renderHtmlReport({
      ...EMPTY,
      interruptions: { ...EMPTY.interruptions, hitsInNoColumn: 1, hitsInNoColumnEvents: [8] },
    });
    const gauge = section(html, "nm-gauge");
    expect(gauge).toContain(escapeHtml(LABELS.noReadings));
    expect(gauge).toContain('data-events="8" data-label="Limit hits in no column">1 limit hit');
  });

  it("states elapsed lockout time with its caveats and the events behind the total", () => {
    const lockouts = section(renderHtmlReport(DATA), "nm-lockouts");
    // One interval of 3,600 s is 1 h 0 m, from the hit on line 8.
    expect(lockouts).toContain(
      '<p class="total"><span class="num" data-events="8" data-label="Elapsed lockout time">1 h 0 m</span> across 1 lockout</p>',
    );
    // A short heading; its definition and the hits note are behind its "i" (D-091), the caveat
    // that what happened during a lockout isn't observed stays in the body.
    expect(lockouts).toContain(
      `<h3 id="nm-lockouts-h">${escapeHtml(HTML_LABELS.lockoutElapsed)}<span class="nm-info">`,
    );
    expect(lockouts).toContain(
      `<span class="nm-info-text" id="nm-lockouts-info" role="note"><span>${escapeHtml(HTML_LABELS.lockoutDefinition)}</span><span>${escapeHtml(LABELS.limitHitsNote)}</span></span>`,
    );
    expect(lockouts).toContain(`<p class="caveat">${escapeHtml(HTML_LABELS.lockoutCaveat)}</p>`);
    // The auto-resume caveat qualifies the not-resumed counts, which the page doesn't print.
    expect(lockouts).not.toContain(escapeHtml(LABELS.autoResumeCaveat));
    // Reset at 13:00:00 to the next request at 13:05:10 is 310 s: 5 m 10 s, from r4 on line 10.
    expect(lockouts).toContain(
      '<td class="num" data-events="10" data-label="Reset to next Claude Code request, Lockout from 2026-09-03 12:00">5 m 10 s</td>',
    );
    expect(lockouts).toContain(
      '<th scope="col" class="num">Reset to next Claude Code request</th>',
    );
  });

  it("prints the text report's interruption counts beside the lockouts, each with its events", () => {
    const html = renderHtmlReport({
      ...DATA,
      interruptions: {
        ...DATA.interruptions,
        // 4 hits: 2 five-hour + 1 weekly + 1 unknown = 4; 3 logged + 1 status line only = 4.
        hits: 4,
        fiveHourHits: 2,
        sevenDayHits: 1,
        unknownWindowHits: 1,
        loggedHits: 3,
        statusLineOnlyHits: 1,
        hitsWithUnknownReset: 2,
        unknownResetEvents: [30, 31],
        events: [8, 13, 30, 31],
        // Each split's own hits, by hand: 8 and 13 five-hour, 30 weekly, 31 unknown window;
        // 8, 13 and 30 logged, 31 seen only in the status line.
        fiveHourEvents: [8, 13],
        sevenDayEvents: [30],
        unknownWindowEvents: [31],
        loggedEvents: [8, 13, 30],
        statusLineOnlyEvents: [31],
      },
    });
    const lockouts = section(html, "nm-lockouts");
    // The phrases of render.ts renderObserved, one paragraph each.
    expect(lockouts).toContain(
      '<p class="count" data-events="8 13 30 31" data-label="Limit hits">Limit hits: 4 in 1 lockout</p>',
    );
    // Each split number carries only its own hits, not every hit the line divides up.
    expect(lockouts).toContain(
      '<p class="sub">5-hour window: <span class="num" data-events="8 13" data-label="Limit hits, 5-hour window">2</span> | weekly window: <span class="num" data-events="30" data-label="Limit hits, weekly window">1</span> | window unknown: <span class="num" data-events="31" data-label="Limit hits, window unknown">1</span></p>',
    );
    expect(lockouts).toContain(
      '<p class="sub">From the session logs: <span class="num" data-events="8 13 30" data-label="Limit hits, from the session logs">3</span> | seen only in the status line: <span class="num" data-events="31" data-label="Limit hits, seen only in the status line">1</span></p>',
    );
    expect(lockouts).toContain(
      '<p class="sub" data-events="30 31" data-label="Limit hits with an unknown reset time">Limit hits with an unknown reset time, in no lockout: 2</p>',
    );
    // The unknown-reset line sits right under the total it qualifies, as in the text report.
    expect(lockouts.indexOf("Limit hits with an unknown reset")).toBeGreaterThan(
      lockouts.indexOf('<p class="total">'),
    );
    expect(lockouts.indexOf("Limit hits with an unknown reset")).toBeLessThan(
      lockouts.indexOf("Limit hits: 4"),
    );
  });

  it("states the counts' span from the interruption totals", () => {
    // Totals covering 09:00:00 to 13:05:10 against a coverage row from 10:00:00: the totals win.
    const html = renderHtmlReport({
      ...DATA,
      interruptions: { ...DATA.interruptions, span: { from: at("09:00:00"), to: at("13:05:10") } },
    });
    expect(section(html, "nm-lockouts")).toContain(
      '<p class="span">Covers: session logs 2026-09-03 09:00 to 13:05 (UTC); status line',
    );
  });

  it("takes the total from the interruption totals, unrounded, and says why a reset has no next request", () => {
    const second: LockoutBar = {
      lockedFromUtc: at("15:00:00"),
      lockedUntilUtc: at("15:30:00"),
      seconds: 1799.6,
      hits: 2,
      refusedRequests: 2,
      sessions: 1,
      resetToNextRequestSeconds: null,
      resetAfterCoverage: true,
      events: [20, 8],
      nextRequestEvents: [],
      autoContinuations: 0,
      firstAutoContinuationSeconds: null,
      autoContinuationEvents: [],
    };
    const third: LockoutBar = { ...second, resetAfterCoverage: false, events: [21] };
    const lockouts = section(
      renderHtmlReport({
        ...DATA,
        lockouts: [...DATA.lockouts, second, third],
        // The view's own total, 3600 + 1799.6 + 1799.6 = 7199.2 s, over 3 intervals.
        interruptions: { ...DATA.interruptions, lockoutSeconds: 7199.2, lockoutIntervals: 3 },
      }),
      "nm-lockouts",
    );
    // 7199.2 s rounded once is 7199 s: 1 h 59 m. Rounding first (7200 s) would print 2 h 0 m.
    // The events are the intervals' hits: 8, then 20 and 8, then 21, merged to 8 20 21.
    expect(lockouts).toContain('data-events="8 20 21" data-label="Elapsed lockout time">1 h 59 m<');
    expect(lockouts).toContain("across 3 lockouts");
    // No next request: the reason as text, with no events to list.
    expect(lockouts).toContain("<td>reset came after the logs end</td>");
    expect(lockouts).toContain("<td>no request after the reset in the logs</td>");
  });

  it("prints the view's lockout total, not a sum of the drawn bars", () => {
    // One drawn bar of 3,600 s, but the totals say 5,400 s over 2 intervals: 1 h 30 m is printed.
    const lockouts = section(
      renderHtmlReport({
        ...DATA,
        interruptions: { ...DATA.interruptions, lockoutSeconds: 5400, lockoutIntervals: 2 },
      }),
      "nm-lockouts",
    );
    expect(lockouts).toContain(
      'data-label="Elapsed lockout time">1 h 30 m</span> across 2 lockouts',
    );
  });

  it("shows output tokens by model with the requests behind each", () => {
    const models = section(renderHtmlReport(DATA), "nm-models");
    // claude-opus-5: r2, r3, r4 (300 + 10 + 50 = 360) from lines 4, 6, 10.
    expect(models).toContain(
      '<td>claude-opus-5</td><td class="num" data-events="4 6 10" data-label="Requests, claude-opus-5">3</td><td class="num" data-events="4 6 10" data-label="Output, claude-opus-5">360</td>',
    );
    expect(models).toContain('data-events="2" data-label="Output, claude-sonnet-5">100</td>');
  });

  it("shows the monthly amounts with the text report's scope and plan-price notes", () => {
    const months = section(renderHtmlReport(DATA), "nm-months");
    expect(months).toContain('<p class="eyebrow projected">Projected</p>');
    expect(months).toContain(
      `<h3 id="nm-months-h">${escapeHtml(LABELS.apiListPrice)}<span class="nm-info">`,
    );
    // Claude Code only and "not a bill" stay beside the amounts; the zone and the reasoning are
    // behind the heading's "i" (D-091).
    expect(months).toContain(
      `<p class="caveat">${escapeHtml(`${LABELS.apiListPriceScope} ${HTML_LABELS.notABill}`)}</p>`,
    );
    expect(months).toContain(
      `<span class="nm-info-text" id="nm-months-info" role="note"><span>Months in UTC.</span><span>${escapeHtml(HTML_LABELS.repricing)}</span></span>`,
    );
    // $0.0123 is shown as dollars and cents: $0.01.
    expect(months).toContain('data-label="At API list price, 2026-09">$0.01</td>');
    expect(months).toContain("<td>none entered</td>");
    expect(months).toContain("<td>2026-09-03 10:00 to 2026-09-03 13:05</td>");
    expect(months).toContain(escapeHtml(HTML_LABELS.planHint));
    expect(months).not.toContain(escapeHtml(HTML_LABELS.unpricedNote));
  });

  it("shows an entered plan price, and the unpriced note when a month has unpriced requests", () => {
    const month: MonthBar = {
      ...(DATA.months[0] as MonthBar),
      planName: "Max",
      planUsdPerMonth: 100,
      unpricedRequests: 2,
      unpricedEvents: [16, 17],
    };
    const months = section(renderHtmlReport({ ...DATA, months: [month] }), "nm-months");
    expect(months).toContain("<td>Max, $100.00 per month</td>");
    // Two unpriced requests, lines 16 and 17.
    expect(months).toContain(
      '<td class="num" data-events="16 17" data-label="Unpriced requests, 2026-09">2</td>',
    );
    expect(months).toContain(escapeHtml(HTML_LABELS.unpricedNote));
    expect(months).not.toContain(escapeHtml(HTML_LABELS.planHint));
  });

  it("prints the rate-reading and lower-bound notes the data carries, each count with its requests", () => {
    const months = section(
      renderHtmlReport({
        ...DATA,
        priceNotes: {
          rateReadings: [
            { verifiedOn: "2026-09-10", pricedBeforeVerifiedRequests: 4, events: [2, 4, 6, 10] },
          ],
          lowerBoundRequests: 3,
          lowerBoundEvents: [4, 6, 10],
        },
      }),
      "nm-months",
    );
    // Each count is selectable and lists its own requests (principle 4).
    expect(months).toContain(
      `<p class="note" data-events="2 4 6 10" data-label="Requests priced at the rate read on 2026-09-10">${escapeHtml(
        "Rates were read from Anthropic's pricing page on 2026-09-10; 4 requests dated before that are priced at those rates.",
      )}</p>`,
    );
    expect(months).toContain(
      '<p class="note" data-events="4 6 10" data-label="Requests priced as a lower bound">Requests with cache writes of unrecorded duration, priced at the 5-minute rate (their cost is a lower bound): 3</p>',
    );
    expect(section(renderHtmlReport(DATA), "nm-months")).not.toContain("Rates were read");
  });
});

describe("traceability of the tables (principle 4)", () => {
  /**
   * Columns whose cells name or date something rather than count it, so they carry no events:
   * a window's name ("5-hour" has a digit), instants and spans, a month, a model name, and the plan
   * price the user entered with plan-price set, which no logged event is behind.
   */
  const IDENTITY_COLUMNS = new Set<string>([
    LABELS.columns.window,
    LABELS.columns.resets,
    HTML_LABELS.peakAt,
    LABELS.columns.readingAt,
    HTML_LABELS.time,
    HTML_LABELS.lockoutFrom,
    HTML_LABELS.lockoutUntil,
    LABELS.columns.month,
    LABELS.columns.model,
    LABELS.columns.planPrice,
    LABELS.columns.covers,
    // Step G2.1: a repository's path and kind name it; a projected instant dates the projection.
    LABELS.columns.repository,
    LABELS.columns.kind,
    HTML_LABELS.limitProjectedFor,
  ]);

  it("gives every table cell holding a number its events, outside the identity columns", () => {
    // A month with a plan price entered and unpriced requests, so every column has a digit.
    const month: MonthBar = {
      ...(DATA.months[0] as MonthBar),
      planName: "Max",
      planUsdPerMonth: 100,
      unpricedRequests: 2,
      unpricedEvents: [16, 17],
    };
    const tables = parseTables(renderHtmlReport({ ...DATA, months: [month] }));
    // Coverage, gauge, three series, lockouts, models, repositories, burn rate, months: 10.
    expect(tables).toHaveLength(10);
    let checked = 0;
    for (const table of tables) {
      for (const row of table.rows) {
        row.forEach((cell, column) => {
          const header = table.headers[column] ?? "";
          if (!/\d/.test(cell.text) || IDENTITY_COLUMNS.has(header)) {
            return;
          }
          checked += 1;
          // The caption, header, and text ride along, so a miss names the cell. A zero count has
          // the attribute with an empty list: nothing is behind it, and it says so when selected.
          expect({
            table: table.caption,
            header,
            text: cell.text,
            events: / data-events="[\d ]*"/.test(cell.attrs),
          }).toEqual({ table: table.caption, header, text: cell.text, events: true });
        });
      }
    }
    // Gauge 3 rows x 4 numbers (peak, last, readings, hits) = 12; series readings 3 + 1 + 4 = 8;
    // lockout 3 (elapsed, hits, next request); models 2 x 2 = 4; repositories 1 x 2 (requests,
    // output) = 2; burn rate 2 x 2 (last usage, rate) = 4; month 3 (amount, priced, unpriced):
    // 12 + 8 + 3 + 4 + 2 + 4 + 3 = 36, and the lockout's "resumed by Claude Code" count (D-077):
    // 37. The guard looked at every one of them.
    expect(checked).toBe(37);
  });

  it("keeps the identity columns free of number cells, so the exemption hides no count", () => {
    const identityCells = parseTables(renderHtmlReport(DATA)).flatMap((table) =>
      table.rows.flatMap((row) =>
        row
          .map((cell, column) => ({ header: table.headers[column] ?? "", attrs: cell.attrs }))
          .filter((cell) => IDENTITY_COLUMNS.has(cell.header)),
      ),
    );
    const seen = identityCells.length;
    // None is a number cell; the header rides along, so a miss names its column.
    expect(identityCells.filter((cell) => cell.attrs.includes('class="num"'))).toEqual([]);
    // Coverage 2 rows x 1 (Covers); gauge 3 x 4 (window, resets, peak at, reading at); series
    // 4 + 1 + 4 rows x 1 (time); lockouts 1 x 2 (hit, reset); models 2 x 1; repositories 1 x 2
    // (repository, kind); burn rate 2 x 4 (window, resets, reading at, limit projected for);
    // months 1 x 3 (month, plan price, covers): 2 + 12 + 9 + 2 + 2 + 2 + 8 + 3 = 40.
    expect(seen).toBe(40);
  });
});

describe("the tabs (step G2.1, D-084)", () => {
  const html = renderHtmlReport(DATA);
  const KEYS = ["overview", "windows", "interruptions", "models", "repos", "burn", "price"];

  /**
   * Cuts one tab panel out of the page.
   * @param key - The tab.
   * @returns The panel's HTML, from its opening tag to the next panel or the end of its part.
   */
  const panel = (key: string): string => {
    const start = html.indexOf(`<div class="nm-tabpanel`, html.indexOf(`id="nm-tab-${key}"`) - 60);
    const next = html.indexOf('<div class="nm-tabpanel', start + 1);
    return html.slice(start, next < 0 ? html.length : next);
  };

  it("lists seven tabs in two labeled groups, observed first, each controlling its panel", () => {
    const nav = /<nav class="nm-tabbar"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    expect([...nav.matchAll(/role="tablist"/g)]).toHaveLength(2);
    expect([...nav.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1])).toEqual(KEYS);
    for (const key of KEYS) {
      expect(nav).toContain(`id="nm-tabbtn-${key}" aria-controls="nm-tab-${key}"`);
      expect(html).toContain(
        `role="tabpanel" id="nm-tab-${key}" aria-labelledby="nm-tabbtn-${key}"`,
      );
    }
    // The overview starts selected and is the only tab in the keyboard order until another is chosen.
    expect([...nav.matchAll(/aria-selected="true"/g)]).toHaveLength(1);
    expect(nav).toContain(
      'id="nm-tabbtn-overview" aria-controls="nm-tab-overview" aria-selected="true" tabindex="0"',
    );
    expect(nav.indexOf(escapeHtml(HTML_LABELS.projectedGroup))).toBeGreaterThan(
      nav.indexOf(escapeHtml(HTML_LABELS.observedGroup)),
    );
  });

  it("keeps observed panels in the observed part and projected panels below the seam", () => {
    const seam = html.indexOf('id="nm-seam"');
    for (const key of ["overview", "windows", "interruptions", "models", "repos"]) {
      const at = html.indexOf(`id="nm-tab-${key}"`);
      expect({ key, observed: at > html.indexOf('id="nm-observed"') && at < seam }).toEqual({
        key,
        observed: true,
      });
    }
    for (const key of ["burn", "price"]) {
      expect({ key, projected: html.indexOf(`id="nm-tab-${key}"`) > seam }).toEqual({
        key,
        projected: true,
      });
    }
  });

  it("puts each section in its tab", () => {
    expect(panel("overview")).toContain('id="nm-coverage"');
    expect(panel("windows")).toContain('id="nm-gauge"');
    expect(panel("interruptions")).toContain('id="nm-lockouts"');
    expect(panel("models")).toContain('id="nm-models"');
    expect(panel("repos")).toContain('id="nm-repos"');
    expect(panel("burn")).toContain('id="nm-burn"');
    expect(panel("price")).toContain('id="nm-months"');
  });

  it("gives every overview card a span and numbers that list their events (principles 4, 5)", () => {
    const overview = panel("overview");
    // The open weekly window: last 16% at 13:05:10 (reading 14), which is also its peak.
    expect(overview).toContain(
      `<p class="count" data-events="14" data-label="${HTML_LABELS.weeklyNow}">${HTML_LABELS.weeklyNow}: 16% at 2026-09-03 13:05; resets 2026-09-10 00:00</p>`,
    );
    expect(overview).toContain(`data-events="14" data-label="${HTML_LABELS.weeklyPeak}"`);
    // One hit (line 8), inside the one lockout of 1 h; the lockout leads (D-090).
    expect(overview).toContain(
      `<p class="sub" data-events="8" data-label="${LABELS.limitHits}">${LABELS.limitHits}: 1 in 1 lockout</p>`,
    );
    expect(overview).toContain(
      `data-events="8" data-label="${HTML_LABELS.lockoutElapsed}">${HTML_LABELS.lockoutElapsed}: 1 h 0 m across 1 lockout</p>`,
    );
    // claude-opus-5, 360 output tokens; the unresolved repository, 460.
    expect(overview).toContain(`data-events="4 6 10" data-label="${HTML_LABELS.mostModel}"`);
    expect(overview).toContain(
      `data-events="2 4 6 10" data-label="${HTML_LABELS.mostRepo}">${HTML_LABELS.mostRepo}: unknown (no working directory), 460 output tokens</p>`,
    );
    const cards = overview.split('<section class="panel nm-card nm-chart"').slice(1);
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card).toMatch(/<p class="span">Covers: (session logs|status line) /);
      expect(card).toContain('<div class="nm-events" aria-live="polite" hidden></div>');
    }
    // Thumbnails are pictures: inert, so they add no keyboard stops (D-084).
    expect([...overview.matchAll(/<div class="nm-thumb" inert aria-hidden="true">/g)]).toHaveLength(
      4,
    );
    // No projection on the overview (principle 2).
    expect(overview).not.toMatch(/project|estimat/i);
  });

  it("draws repositories with the home directory and a table of every row", () => {
    // Rendered here: beforeEach clears the stubs' calls, so the shared page above has none.
    const repos = section(renderHtmlReport(DATA), "nm-repos");
    expect(charts.renderRepoBars).toHaveBeenCalledWith(
      { bars: DATA.repos, home: "" },
      { timeZone: "UTC", width: 960 },
    );
    expect(repos).toContain(escapeHtml(HTML_LABELS.repoCaveat));
    expect(repos).toContain(
      '<td class="num" data-events="2 4 6 10" data-label="Requests, unknown (no working directory)">4</td>',
    );
    // One repository, present: no faded key and no remainder key.
    expect(repos).not.toContain("k-faded");
    expect(repos).not.toContain("k-other");
    const gone = section(
      renderHtmlReport({
        ...DATA,
        home: "/home/example",
        repos: [
          {
            repository: "/home/example/x",
            kind: "missing",
            requests: 1,
            outputTokens: 1,
            events: [2],
          },
        ],
      }),
      "nm-repos",
    );
    expect(gone).toContain("k-faded");
    expect(gone).toContain("<td>~/x</td><td>directory no longer exists</td>");
  });

  it("states each open window's burn rate in the text report's words, with the reading behind it", () => {
    const burn = section(renderHtmlReport(DATA), "nm-burn");
    expect(burn).toContain('<p class="eyebrow projected">Projected</p>');
    expect(burn).toContain(escapeHtml(LABELS.burnRatePremise));
    for (const window of DATA.burn) {
      expect(burn).toContain(
        `data-events="14" data-label="Burn rate, ${window.window === "five_hour" ? "5-hour" : "weekly"} window resetting`,
      );
      expect(burn).toContain(escapeHtml(burnSentenceFor(window)));
      expect(charts.renderBurnRate).toHaveBeenCalledWith(
        {
          burn: window,
          series: DATA.series.find(
            (s) => s.window === window.window && s.resetAtUtc === window.resetAtUtc,
          ),
        },
        { timeZone: "UTC", width: 960 },
      );
    }
    expect(section(renderHtmlReport({ ...DATA, burn: [] }), "nm-burn")).toContain(
      escapeHtml(HTML_LABELS.noOpenWindow),
    );
  });

  it("moves between tabs with the arrow keys, Home, and End, wrapping at both ends", () => {
    const nm = pageHelpers(html);
    expect(nm.nextTab(0, "ArrowRight", 7)).toBe(1);
    expect(nm.nextTab(6, "ArrowRight", 7)).toBe(0);
    expect(nm.nextTab(0, "ArrowLeft", 7)).toBe(6);
    expect(nm.nextTab(3, "Home", 7)).toBe(0);
    expect(nm.nextTab(3, "End", 7)).toBe(6);
    expect(nm.nextTab(3, "Enter", 7)).toBe(-1);
  });

  it("opens the tab the page address names, else the overview", () => {
    const nm = pageHelpers(html);
    expect(nm.tabFromHash("#repos", KEYS)).toBe("repos");
    expect(nm.tabFromHash("burn", KEYS)).toBe("burn");
    expect(nm.tabFromHash("#nm-gauge", KEYS)).toBe("overview");
    expect(nm.tabFromHash("", KEYS)).toBe("overview");
  });

  it("hides the tab bar without the script and shows every tab when printed", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
    expect(style).toContain(".nm-tabbar { display: none; }");
    expect(style).toContain(".nm-tabs .nm-tabpanel:not(.nm-active) { display: none; }");
    const print = style.slice(style.indexOf("@media print"));
    expect(print).toContain(
      ".nm-tabs .nm-tabpanel:not(.nm-active), .nm-tabs .nm-part:not(.nm-has-active) { display: grid; }",
    );
  });
});

describe("interruptions per plan period (step G2.2, D-075)", () => {
  /** The scenario with Max 5x entered from 2026-09, so its one hit and lockout fall under it. */
  const MAX = {
    kind: "plan",
    fromMonth: "2026-09",
    toMonth: null,
    untilMonth: null,
    planName: "Max 5x",
  } as const;
  const PLANS: HtmlReportData = {
    ...DATA,
    lockouts: DATA.lockouts.map((bar) => ({ ...bar, period: MAX })),
    interruptions: {
      ...DATA.interruptions,
      byPlan: [
        {
          period: {
            kind: "none",
            fromMonth: null,
            toMonth: "2026-08",
            untilMonth: "2026-09",
            planName: null,
          },
          hits: 0,
          lockouts: 0,
          lockoutSeconds: 0,
          span: { from: at("10:00:00"), to: at("10:00:00") },
          hitEvents: [],
          lockoutEvents: [],
        },
        {
          period: MAX,
          hits: 1,
          lockouts: 1,
          lockoutSeconds: 3600,
          span: { from: at("10:00:05"), to: at("13:05:10") },
          hitEvents: [8],
          lockoutEvents: [8],
        },
      ],
    },
  };

  it("shows the per-plan table open on the interruptions tab, each number with its events", () => {
    const lockouts = section(renderHtmlReport(PLANS), "nm-lockouts");
    expect(lockouts).toContain(
      escapeHtml(`${LABELS.byPlan}: ${LABELS.byPlanNote} (months in UTC).`),
    );
    expect(lockouts).toContain(
      `<details class="nm-table" open><summary>Table view: ${HTML_LABELS.byPlanCaption}</summary>`,
    );
    expect(lockouts).toContain(
      '<td>Max 5x</td><td>2026-09 onward</td><td class="num" data-events="8" data-label="Limit hits, Max 5x, 2026-09 onward">1</td>',
    );
    expect(lockouts).toContain(
      'data-label="Elapsed lockout time, Max 5x, 2026-09 onward">1 h 0 m</td>',
    );
    expect(lockouts).toContain("<td>no plan entered</td><td>before 2026-09</td>");
  });

  it("shows no table and no lanes while no plan is entered", () => {
    const html = renderHtmlReport(DATA);
    expect(html).not.toContain(HTML_LABELS.byPlanCaption);
    expect(charts.renderLockouts).toHaveBeenCalledWith(DATA.lockouts, {
      timeZone: "UTC",
      width: 960,
    });
  });

  it("adds a line per plan to the overview's interruptions card", () => {
    const html = renderHtmlReport(PLANS);
    const card = section(html, "nm-card-interruptions");
    expect(card).toContain(
      `<p class="sub" data-events="8" data-label="${LABELS.columns.lockouts}, Max 5x">Max 5x, 2026-09 onward: 1 lockout</p>`,
    );
    expect(card).toContain(
      `data-events="" data-label="${LABELS.columns.lockouts}, no plan entered">no plan entered, before 2026-09: 0 lockouts</p>`,
    );
    // The chart is drawn with each bar's period, so it can draw its lanes.
    expect(charts.renderLockouts).toHaveBeenCalledWith(PLANS.lockouts, {
      timeZone: "UTC",
      width: 960,
    });
  });
});

describe("Claude Code's logged resumption (step G2.4, D-077)", () => {
  const RESUMED: HtmlReportData = {
    ...DATA,
    lockouts: DATA.lockouts.map((bar) => ({
      ...bar,
      autoContinuations: 1,
      firstAutoContinuationSeconds: 46,
      autoContinuationEvents: [21],
    })),
  };

  it("counts it in the lockout table and keys the ring, only when one was logged", () => {
    const resumed = section(renderHtmlReport(RESUMED), "nm-lockouts");
    expect(resumed).toContain(
      '<td class="num" data-events="21" data-label="Resumed by Claude Code, Lockout from 2026-09-03 12:00">1</td>',
    );
    expect(resumed).toContain(`<i class="k-resumed"></i>${escapeHtml(HTML_LABELS.legendResumed)}`);
    const none = section(renderHtmlReport(DATA), "nm-lockouts");
    expect(none).toContain(
      'data-label="Resumed by Claude Code, Lockout from 2026-09-03 12:00">0</td>',
    );
    expect(none).not.toContain("k-resumed");
  });

  it("adds a line to the overview's interruptions card", () => {
    expect(section(renderHtmlReport(RESUMED), "nm-card-interruptions")).toContain(
      '<p class="sub" data-events="21" data-label="Resumed by Claude Code">Resumed by Claude Code after a lockout: 1 session</p>',
    );
    expect(section(renderHtmlReport(DATA), "nm-card-interruptions")).not.toContain(
      "after a lockout",
    );
  });
});

describe("the empty report", () => {
  it("says what is missing instead of drawing empty charts, and keeps every span and the seam", () => {
    const html = renderHtmlReport(EMPTY);
    expect(section(html, "nm-coverage")).toContain(
      '<p class="span">Covers: session logs no data yet; status line no data yet</p>',
    );
    expect(section(html, "nm-gauge")).toContain(escapeHtml(LABELS.noReadings));
    expect(html).not.toContain('class="nm-series"');
    expect(section(html, "nm-lockouts")).toContain(">0 s</span> across 0 lockouts</p>");
    expect(section(html, "nm-lockouts")).toContain(escapeHtml(HTML_LABELS.noLockouts));
    expect(section(html, "nm-models")).toContain(escapeHtml(HTML_LABELS.noRequests));
    expect(section(html, "nm-months")).toContain(escapeHtml(HTML_LABELS.noRequests));
    expect(section(html, "nm-months")).toContain(
      '<p class="span">Covers: session logs no data yet</p>',
    );
    expect(html).toContain(`<h2 class="seam" id="nm-seam">${escapeHtml(LABELS.projected)}</h2>`);
    // Only the coverage chart is drawn; the rest have nothing to draw.
    expect(charts.renderGauge).not.toHaveBeenCalled();
    expect(charts.renderWindowSeries).not.toHaveBeenCalled();
    expect(charts.renderLockouts).not.toHaveBeenCalled();
    expect(charts.renderModelBars).not.toHaveBeenCalled();
    expect(charts.renderMonthBars).not.toHaveBeenCalled();
  });

  it("states no span for a source with no coverage row at all", () => {
    const html = renderHtmlReport({ ...EMPTY, coverage: [] });
    expect(section(html, "nm-models")).toContain(
      '<p class="span">Covers: session logs no data yet</p>',
    );
  });
});

describe("escaping", () => {
  it("escapes model names in the page, so a crafted name can't add elements", () => {
    const html = renderHtmlReport({
      ...DATA,
      models: [
        { model: '<img src=x onerror="alert(1)">', requests: 1, outputTokens: 1, events: [2] },
      ],
    });
    expect(html).toContain("<td>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</td>");
    expect(html).not.toContain("<img");
  });

  it("writes a model name outside ASCII as a character reference, keeping the file ASCII (D-063)", () => {
    const html = renderHtmlReport({
      ...DATA,
      models: [{ model: "caf\u00e9", requests: 1, outputTokens: 1, events: [2] }],
    });
    expect(section(html, "nm-models")).toContain("<td>caf&#xe9;</td>");
  });

  it("escapes paths in the embedded event table and reads them back unchanged", () => {
    const path = 'proj "a" & <b>/s1.jsonl';
    const html = renderHtmlReport({ ...DATA, files: [path, "x"] });
    const json = /<script type="application\/json" id="nm-data">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1];
    // `<`, `>`, and `&` become \u003c, \u003e, \u0026; the quote stays JSON's own \".
    expect(json).toContain('proj \\"a\\" \\u0026 \\u003cb\\u003e/s1.jsonl');
    expect((JSON.parse(json ?? "{}") as { files: string[] }).files[0]).toBe(path);
  });

  it("escapes HTML specials, control characters, and characters outside ASCII", () => {
    expect(escapeHtml(`a<b & "c" 'd'>`)).toBe("a&lt;b &amp; &quot;c&quot; &#39;d&#39;&gt;");
    // A newline becomes a visible \n, as in the text report (D-050).
    expect(escapeHtml("x\ny")).toBe("x\\ny");
    // U+1F600 is one code point, so one reference.
    expect(escapeHtml("\u{1f600}")).toBe("&#x1f600;");
  });

  it("embeds JSON that can't close its script tag and parses back to the same value", () => {
    const value = { path: "</script><!-- \u00e9 \u{1f600}" };
    const text = embedJson(value);
    expect(text).toBe('{"path":"\\u003c/script\\u003e\\u003c!-- \\u00e9 \\ud83d\\ude00"}');
    expect(JSON.parse(text)).toEqual(value);
  });

  it("merges event lists once each, in ascending order", () => {
    expect(mergeEvents([8, 2], [2, 20], [])).toEqual([2, 8, 20]);
  });
});

describe("the embedded data and the page script", () => {
  it("embeds the zone, the files, and every event for the script", () => {
    const html = renderHtmlReport(DATA);
    const json = /<script type="application\/json" id="nm-data">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1];
    expect(JSON.parse(json ?? "{}")).toEqual({
      timeZone: "UTC",
      files: DATA.files,
      events: DATA.events,
    });
  });

  it("has exactly two script blocks, neither loading anything, and no closing tag inside the script", () => {
    const html = renderHtmlReport(DATA);
    expect(html.match(/<script\b/g)).toHaveLength(2);
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    expect(script).not.toContain("</");
    expect(script).toContain(`var LIMIT = ${EVENT_LIST_LIMIT};`);
  });

  it("formats times in the report's zone the way the text report does", () => {
    const nm = pageHelpers(renderHtmlReport(DATA));
    expect(nm.formatAt(at("12:00:00"), "UTC")).toBe("2026-09-03 12:00");
    // America/Denver is UTC-6 in September: 12:00Z is 06:00.
    expect(nm.formatAt(at("12:00:00"), "America/Denver")).toBe("2026-09-03 06:00");
    expect(nm.formatAt(null, "UTC")).toBe("unknown");
  });

  it("reads and merges data-events values", () => {
    const nm = pageHelpers(renderHtmlReport(DATA));
    expect(nm.parseIds(" 8  20 x ")).toEqual([8, 20]);
    expect(nm.parseIds("")).toEqual([]);
    expect(
      nm.union([
        [8, 2],
        [2, 4],
      ]),
    ).toEqual([2, 4, 8]);
  });

  it("lists events as time then file:line, like nilometer explain, and names what it can't find", () => {
    const nm = pageHelpers(renderHtmlReport(DATA));
    const data = {
      timeZone: "UTC",
      files: [...DATA.files],
      events: { ...DATA.events, 30: { file: 9, line: 1, atUtc: null } },
    };
    // Line 2 is r1 at 10:00:05, line 8 is h1 at 12:00:00, both in -fixture-html/s1.jsonl.
    expect(nm.eventLines([2, 8, 30, 99], data, EVENT_LIST_LIMIT)).toEqual({
      lines: [
        "2026-09-03 10:00  -fixture-html/s1.jsonl:2",
        "2026-09-03 12:00  -fixture-html/s1.jsonl:8",
        "unknown  unknown location",
        "unknown  raw line 99: not in this file",
      ],
      more: 0,
    });
  });

  it("names a selection by its label, then its SVG title, then its aria-label", () => {
    const nm = pageHelpers(renderHtmlReport(DATA));
    const title = [{ tagName: "title", textContent: "103% at 11:58" }];
    expect(nm.labelOf(fakeElement({ "data-label": "Peak", "aria-label": "col" }, title))).toBe(
      "Peak",
    );
    expect(nm.labelOf(fakeElement({ "aria-label": "col" }, title))).toBe("103% at 11:58");
    // A gauge column has no data-label and no title of its own: its aria-label names the window.
    expect(
      nm.labelOf(
        fakeElement({ "aria-label": "5-hour window: peak 103%" }, [
          { tagName: "rect", textContent: "" },
        ]),
      ),
    ).toBe("5-hour window: peak 103%");
    expect(nm.labelOf(fakeElement({}))).toBe("");
  });

  it("caps the list at 200 events and counts the rest", () => {
    const nm = pageHelpers(renderHtmlReport(DATA));
    // 250 IDs with a limit of 200: 200 lines and 50 more.
    const ids = Array.from({ length: 250 }, (_, i) => i + 1000);
    const listed = nm.eventLines(ids, { timeZone: "UTC", files: [], events: {} }, EVENT_LIST_LIMIT);
    expect(listed.lines).toHaveLength(200);
    expect(listed.more).toBe(50);
  });
});
