/**
 * @file Guards on the HTML report's output (step G1.3, D-070): audit check A9's banned-phrase
 * rule over the page's visible text, no network reference anywhere in the file, observed sections
 * above the seam and the projected one below it (principle 2), a span in every chart section
 * (principle 5), embedded data that can't break out of its script tag, and ASCII-only output
 * (D-063).
 *
 * Runs the real page with the real chart module, so a chart that brings in a banned phrase or a
 * network URL fails here too. The report data is synthetic and built by hand in this file (no
 * database), in three shapes: a full report modeled on the scenario in
 * `tests/unit/viewer/html-fixture.ts`, an empty one, and a hostile one whose names try to break out
 * of the page. Each guard first proves it can see what it is looking for, so a guard that never
 * fires can't pass for one that works.
 */
import { describe, expect, it } from "vitest";

import type { HtmlReportData } from "../../viewer/html-contract.js";
import { HTML_LABELS, renderHtmlReport } from "../../viewer/html.js";
import { LABELS } from "../../viewer/render.js";
import { bannedPhrases, findBanned } from "./banned-phrases.js";

/**
 * Places a time on the scenario's day.
 * @param time - `HH:MM:SS` UTC.
 * @returns ISO-8601 UTC with milliseconds.
 */
const at = (time: string): string => `2026-09-03T${time}.000Z`;

/**
 * Full synthetic report: a window reading 103% with a hit, a lockout, two models, a month. Every
 * conditional line has something to say, so its wording is guarded too: hit 9 has an unknown
 * window and reset, and hit 16 has no time, so both are in no column (the contract's rule); and
 * reading 15 came after its window's reset.
 */
const FULL: HtmlReportData = {
  timeZone: "UTC",
  lastIngestAt: at("13:10:00"),
  generatedAtUtc: at("14:00:00"),
  coverage: [
    { source: "session_logs", span: { from: at("10:00:00"), to: at("13:05:10") } },
    { source: "status_line", span: { from: at("10:00:05"), to: at("13:05:10") } },
  ],
  gauge: [
    {
      window: "five_hour",
      resetAtUtc: at("13:00:00"),
      open: false,
      peak: 103,
      peakAtUtc: at("11:58:00"),
      last: 103,
      lastAtUtc: at("11:58:00"),
      readings: 3,
      // Only hit 8: hit 16 has no time, so no column holds it.
      limitHits: 1,
      peakEvents: [13],
      lastEvents: [13],
      hitEvents: [8],
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
        { atUtc: at("10:00:05"), used: 20, event: 11 },
        { atUtc: at("10:00:20"), used: 60, event: 12 },
        { atUtc: at("11:58:00"), used: 103, event: 13 },
      ],
      hits: [{ atUtc: at("12:00:00"), event: 8 }],
    },
    {
      window: "seven_day",
      resetAtUtc: "2026-09-10T00:00:00.000Z",
      points: [
        { atUtc: at("10:00:05"), used: 10, event: 11 },
        { atUtc: at("13:05:10"), used: 16, event: 14 },
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
      resetToNextRequestSeconds: 310,
      resetAfterCoverage: false,
      events: [8],
      nextRequestEvents: [10],
    },
  ],
  interruptions: {
    hits: 3,
    fiveHourHits: 2,
    sevenDayHits: 0,
    unknownWindowHits: 1,
    loggedHits: 3,
    statusLineOnlyHits: 0,
    lockoutSeconds: 3600,
    lockoutIntervals: 1,
    hitsWithUnknownReset: 2,
    unknownResetEvents: [9, 16],
    hitsInNoColumn: 2,
    hitsInNoColumnEvents: [9, 16],
    events: [8, 9, 16],
    // By hand: 9 has no window (so it's in no column); 8 and 16 are five-hour; all three logged.
    fiveHourEvents: [8, 16],
    sevenDayEvents: [],
    unknownWindowEvents: [9],
    loggedEvents: [8, 9, 16],
    statusLineOnlyEvents: [],
    span: { from: at("10:00:00"), to: at("13:05:10") },
  },
  afterReset: { count: 1, events: [15] },
  models: [
    { model: "claude-opus-5", requests: 3, outputTokens: 360, events: [4, 6, 10] },
    { model: "claude-sonnet-5", requests: 1, outputTokens: 100, events: [2] },
  ],
  months: [
    {
      month: "2026-09",
      apiListPriceUsd: 0.0123,
      planName: "Max",
      planUsdPerMonth: 100,
      pricedRequests: 4,
      unpricedRequests: 1,
      unpricedEvents: [12],
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
    9: { file: 0, line: 9, atUtc: at("12:40:00") },
    10: { file: 0, line: 10, atUtc: at("13:05:10") },
    11: { file: 1, line: 1, atUtc: at("10:00:05") },
    12: { file: 1, line: 2, atUtc: at("10:00:20") },
    13: { file: 1, line: 3, atUtc: at("11:58:00") },
    14: { file: 1, line: 4, atUtc: null },
    15: { file: 1, line: 5, atUtc: at("13:00:30") },
    16: { file: 0, line: 12, atUtc: null },
  },
};

/** The same report with nothing recorded. */
const EMPTY: HtmlReportData = {
  ...FULL,
  lastIngestAt: null,
  coverage: [
    { source: "session_logs", span: { from: null, to: null } },
    { source: "status_line", span: { from: null, to: null } },
  ],
  gauge: [],
  series: [],
  lockouts: [],
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
  files: [],
  events: {},
};

/** A path that tries to close the data block and open a script of its own. */
const HOSTILE_PATH = "-evil/</script><script>alert(1)</script><!--.jsonl";

/** The full report with names that try to break out of the page. */
const HOSTILE: HtmlReportData = {
  ...FULL,
  models: [{ model: "</script><b>x</b>", requests: 1, outputTokens: 1, events: [2] }],
  files: [HOSTILE_PATH, "status-line/readings.jsonl"],
};

/** Every report shape the guards run over. */
const REPORTS: readonly (readonly [string, HtmlReportData])[] = [
  ["full", FULL],
  ["empty", EMPTY],
  ["hostile", HOSTILE],
];

/** Named character references the page writes, decoded for reading. */
const NAMED: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  nbsp: " ",
  middot: "|",
  ndash: "-",
};

/**
 * Decodes the character references in HTML text.
 * @param text - Text with references.
 * @returns The text a reader sees; an unknown named reference becomes a space.
 */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (_, ref: string) => {
    if (ref.startsWith("#x") || ref.startsWith("#X")) {
      return String.fromCodePoint(parseInt(ref.slice(2), 16));
    }
    if (ref.startsWith("#")) {
      return String.fromCodePoint(parseInt(ref.slice(1), 10));
    }
    return NAMED[ref.toLowerCase()] ?? " ";
  });
}

/**
 * Extracts what a reader of the page sees: scripts, styles, tags, and their attributes removed,
 * references decoded. SVG `<title>` text stays, since a browser shows it on hover.
 * @param html - The page.
 * @returns The visible text.
 */
function visibleText(html: string): string {
  // Whitespace runs collapse to one space, as a browser renders them, so a sentence built from
  // inline elements (each split count is its own <span>) reads as the sentence the reader sees.
  // findBanned already matches across any whitespace; this is for the tests that quote sentences.
  return decode(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  ).replace(/\s+/g, " ");
}

/**
 * Collects attribute values that reach a reader another way: read aloud by a screen reader, shown
 * as a tooltip, or written into the events panel by the script.
 * @param html - The page.
 * @returns The values, decoded, one per line.
 */
function spokenAttributes(html: string): string {
  return [...html.matchAll(/\s(?:aria-label|title|alt|data-label)="([^"]*)"/g)]
    .map((match) => decode(match[1] ?? ""))
    .join("\n");
}

/**
 * Collects the string literals of the page's inline script: the text it writes into the events
 * panel (the count line, the "more events" line, "unknown location") reaches the reader without
 * ever being in the page's HTML, so the visible-text guard can't see it. Comments are skipped;
 * they are never shown.
 * @param html - The page, or any text holding a bare script block.
 * @returns Each literal's contents, one per line.
 */
function scriptStrings(html: string): string {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1] ?? "")
    .join("\n")
    // A comment could hold a quote that would pair with one in code, so comments go first.
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  return [...script.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`([^`]*)`/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
    .join("\n");
}

/** Patterns that would make the page fetch, link, or load something. */
const NETWORK_PATTERNS: readonly RegExp[] = [
  /https?:\/\//i,
  /<link\b/i,
  /@import/i,
  /<script\b[^>]*\bsrc\s*=/i,
  // A url() or a src/href that isn't a fragment in this document or inline data points outside.
  /url\((?!\s*["']?(?:#|data:))/i,
  /\b(?:src|href|srcset|action)\s*=(?!\s*["']?(?:#|data:))/i,
  /\b(?:fetch|importScripts)\s*\(|\bimport\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/,
];

/**
 * Finds anything in the page that could make a request.
 * @param html - The page.
 * @returns Each matching pattern's source; empty when there is none.
 */
function networkReferences(html: string): string[] {
  return NETWORK_PATTERNS.filter((pattern) => pattern.test(html)).map((pattern) => pattern.source);
}

/**
 * Finds characters outside ASCII.
 * @param text - Any text.
 * @returns Each distinct offending character's code point, e.g. `U+00B7`.
 */
function nonAscii(text: string): string[] {
  const found = new Set<string>();
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x7f) {
      found.add(`U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }
  return [...found];
}

describe("the guards see what they look for", () => {
  const phrases = bannedPhrases();

  it("finds a banned phrase in visible text and in a spoken attribute, but not in script or style", () => {
    const page =
      "<p>Your savings</p><svg><title>Time\n lost</title></svg><script>var savings;</script><style>.verdict{}</style>";
    expect(findBanned(visibleText(page), phrases).sort()).toEqual(["savings", "time lost"]);
    expect(findBanned(spokenAttributes('<td data-label="a verdict">1</td>'), phrases)).toEqual([
      "verdict",
    ]);
    expect(findBanned(visibleText('<p data-x="wasted">ok</p>'), phrases)).toEqual([]);
  });

  it("finds a banned phrase in any kind of script string, but not in a comment or code", () => {
    const page =
      "<script>/* verdict */ var savings = 1; a(\"your savings\"); b('it was wasted'); c(`time lost`);</script>";
    expect(findBanned(scriptStrings(page), phrases).sort()).toEqual([
      "savings",
      "time lost",
      "wasted",
    ]);
    // An escaped quote stays inside its string.
    expect(scriptStrings('<script>x("a \\" verdict")</script>')).toBe('a \\" verdict');
  });

  it("reads the strings the real page script writes into the events panel", () => {
    const strings = scriptStrings(renderHtmlReport(FULL));
    for (const panelText of [
      " behind it, each as time (",
      " more events not listed; nilometer explain lists every event.",
      "unknown location",
    ]) {
      expect(strings).toContain(panelText);
    }
  });

  it("sees every conditional line of the full report, so guard (a) reads their wording", () => {
    const text = visibleText(renderHtmlReport(FULL));
    // Hits 9 (no window) and 16 (no time) are in no column: 2.
    expect(text).toContain("Readings captured after their window's reset, not counted: 1");
    expect(text).toContain("2 limit hits aren't in any column");
    expect(text).toContain("Hits with an unknown reset time, not included: 2");
    expect(text).toContain("5-hour window: 2 | weekly window: 0 | window unknown: 1");
  });

  it("reads a sentence built from inline elements as the reader sees it", () => {
    expect(
      visibleText('<p class="sub">5-hour window: <span class="num">2</span> | weekly</p>'),
    ).toBe(" 5-hour window: 2 | weekly ");
  });

  it("decodes references before matching, so an escaped phrase is still found", () => {
    expect(findBanned(visibleText("<p>cheaper&#32;by &amp; more</p>"), phrases)).toEqual([
      "cheaper by",
    ]);
    expect(decode("&middot;&ndash;&nbsp;&lt;&#x41;&unknown;")).toBe("|- <A ");
  });

  it("finds every kind of network reference", () => {
    for (const bad of [
      '<script src="x.js"></script>',
      "<link rel=stylesheet href=a.css>",
      "@import 'a.css';",
      "a { background: url(//cdn.example/x.png) }",
      "see https://example.com",
      '<img src="x.png">',
      '<a href="page.html">',
      "fetch('/x')",
      "new WebSocket(u)",
    ]) {
      // The sample rides along in the compared value, so a miss names it.
      expect({ bad, found: networkReferences(bad).length > 0 }).toEqual({ bad, found: true });
    }
    expect(
      networkReferences('<a href= "#nm-seam"></a><use href="#g"/> url( #grad) url("data:,x")'),
    ).toEqual([]);
  });

  it("finds a character outside ASCII", () => {
    expect(nonAscii("a \u00b7 b \u2013 c")).toEqual(["U+00B7", "U+2013"]);
    expect(nonAscii("plain ascii")).toEqual([]);
  });
});

describe.each(REPORTS)("the %s HTML report", (_name, data) => {
  const html = renderHtmlReport(data);
  const phrases = bannedPhrases();

  it("(a) has no banned phrase in its visible text, spoken attributes, or script strings (A9, D-012)", () => {
    expect(findBanned(visibleText(html), phrases)).toEqual([]);
    expect(findBanned(spokenAttributes(html), phrases)).toEqual([]);
    expect(findBanned(scriptStrings(html), phrases)).toEqual([]);
  });

  it("(b) has no network reference anywhere in the file", () => {
    expect(networkReferences(html)).toEqual([]);
  });

  it("(c) places every observed section above the seam and the monthly amounts below it", () => {
    const seam = html.indexOf('id="nm-seam"');
    expect(seam).toBeGreaterThan(0);
    for (const id of ["nm-coverage", "nm-observed", "nm-gauge", "nm-lockouts", "nm-models"]) {
      const index = html.indexOf(`id="${id}"`);
      expect({ id, aboveSeam: index > 0 && index < seam }).toEqual({ id, aboveSeam: true });
    }
    expect(html.indexOf('id="nm-months"')).toBeGreaterThan(seam);
    // Nothing above the seam calls itself a projection or an estimate (principle 2).
    expect(visibleText(html.slice(0, seam))).not.toMatch(/project|estimat/i);
    expect(visibleText(html.slice(seam))).toContain(LABELS.projected);
  });

  it("(d) states a span in every chart section and every window's series", () => {
    const sections = html.split('<section class="panel nm-chart"').slice(1);
    // Coverage, gauge, lockouts, models, months.
    expect(sections).toHaveLength(5);
    const span = /<p class="span">Covers: [^<]*(\d{4}-\d{2}-\d{2} \d{2}:\d{2} to|no data yet)/;
    for (const part of sections) {
      expect(part).toMatch(span);
    }
    for (const part of html.split('<details class="nm-series"').slice(1)) {
      expect(part).toMatch(span);
    }
  });

  it("(e) keeps its embedded data inside the data block", () => {
    // One closing tag for the data block and one for the page script, whatever the data holds.
    expect(html.match(/<\/script/gi)).toHaveLength(2);
    expect(html).not.toContain("<!--");
    const json = /<script type="application\/json" id="nm-data">([\s\S]*?)<\/script>/.exec(
      html,
    )?.[1];
    expect((JSON.parse(json ?? "null") as { files: string[] }).files).toEqual(data.files);
  });

  it("(f) is ASCII only (D-063)", () => {
    expect(nonAscii(html)).toEqual([]);
  });
});

describe("the hostile report", () => {
  it("carries the crafted path only as escaped data and the crafted model only as escaped text", () => {
    const html = renderHtmlReport(HOSTILE);
    expect(html).toContain("-evil/\\u003c/script\\u003e\\u003cscript\\u003ealert(1)");
    expect(html).toContain("&lt;/script&gt;&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("keeps the new labels free of banned phrases too", () => {
    expect(findBanned(Object.values(HTML_LABELS).join("\n"), bannedPhrases())).toEqual([]);
  });
});
