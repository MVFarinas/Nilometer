/**
 * @file The HTML report's page (step G1.3, D-070): one self-contained document that frames the
 * charts from `viewer/html-charts.ts` in the text report's order, with a table view of every chart
 * and one small inline script that lists the events behind a selected element.
 *
 * Implements README section Measurement Principles as a page: observed sections sit above a
 * visible seam labeled as projected and the monthly repricing below it (principle 2), every chart
 * section states the span it covers (principle 5), and every drawn element and table cell with a
 * number carries the raw line IDs behind it, which the script resolves to `file:line` and time the
 * way `nilometer explain` does (principle 4). README section Privacy: the page embeds session log
 * paths, so it says so in its header. See D-070, D-012 (wording), D-030 (saved copies), D-063
 * (ASCII only: every symbol is an HTML entity and user text outside ASCII becomes a character
 * reference), and D-066 (plain, factual tone in what the page tells the reader).
 *
 * Nothing here fetches or links anything: no external script, stylesheet, font, or image, so the
 * README's "makes no network requests" promise holds for a file opened in any browser.
 */
import { formatCoverage, formatInstant, formatNumber, printable } from "./format.js";
import {
  renderCoverage,
  renderGauge,
  renderLockouts,
  renderModelBars,
  renderMonthBars,
  renderWindowSeries,
} from "./html-charts.js";
import type {
  ChartOptions,
  CoverageRow,
  EventRef,
  GaugeWindow,
  HtmlReportData,
  LockoutBar,
  ModelBar,
  MonthBar,
  RenderHtmlReport,
  Span,
  WindowSeries,
  PriceNotes,
} from "./html-contract.js";
import { LABELS, plural, windowName } from "./render.js";

/** The `viewBox` width every chart is drawn at; CSS scales the SVG to its container. */
const CHART_WIDTH = 960;

/** The most events one selection lists; the rest are counted, as `explain` does without `--all`. */
export const EVENT_LIST_LIMIT = 200;

/**
 * Visible text that is new with the HTML report. The text report's wording stays in `LABELS`; these
 * follow the add-metric skill's section 2, and the banned-phrase guard reads the whole page.
 */
export const HTML_LABELS = {
  privacy:
    "Privacy: this file holds session IDs and the paths of your session logs, like nilometer explain output, and it makes no network requests. Think before sharing it.",
  coverage: "What each number covers",
  sessionLogsHold: "tokens, models, limit hits",
  statusLineHolds: "usage windows",
  source: "Source",
  holds: "What it holds",
  tableView: "Table view",
  legendPeak: "Peak usage in the window",
  legendLast: "Last observed usage (a lower bound)",
  legendHit: "Limit hit in the window",
  over100: "Readings above 100% are shown as recorded.",
  seriesHint:
    "Select a column to show that window's readings over time and list the events behind it. Select any bar, point, count, or table cell with a number to list its events.",
  peakAt: "Peak reading at",
  limitHits: "Limit hits",
  time: "Time",
  event: "Event",
  usage: "Observed usage",
  reading: "Status line reading",
  hit: "Limit hit",
  lockoutFrom: "Limit hit",
  lockoutUntil: "Reset",
  lockoutElapsed: "Elapsed lockout time",
  hits: "Hits",
  lockoutCaveat:
    "Each interval runs from a limit hit to the window's reset. What happened during it isn't observed.",
  noLockouts: "No lockouts in the covered span.",
  noRequestAfter: "no request after the reset in the logs",
  resetAfterLogs: "reset came after the logs end",
  models: "Claude Code output tokens by model",
  noRequests: "No Claude Code requests in the logs yet.",
  projectedTag: "Projected",
  legendPrice: "Observed tokens at API list price",
  legendPlan: "Plan price entered for that month",
  repricing:
    "Only the plan price is a price. The bars reprice the tokens observed at API list rates; they aren't a bill, because paying per token changes how people work.",
  unpricedNote:
    "Unpriced requests have no verified rate and are left out of the amounts, not counted as $0.",
  planHint:
    "To show a plan price beside these amounts: plan-price set <YYYY-MM> <usd> --name <plan>",
} as const;

/** Which character each HTML-special character becomes. */
const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Makes text from the logs or a label safe to place in HTML text or a quoted attribute.
 *
 * Model names and paths come from data an attacker can influence (D-050), so the five special
 * characters become entities. Control characters are first written as visible escapes, as the text
 * report does, and anything outside printable ASCII becomes a numeric character reference, so the
 * file stays ASCII whatever the logs hold (D-063).
 * @param value - Any text.
 * @returns The escaped text; never throws.
 * @example
 * escapeHtml('a<b & "c"'); // "a&lt;b &amp; &quot;c&quot;"
 * escapeHtml("caf\u00e9"); // "caf&#xe9;"
 */
export function escapeHtml(value: string): string {
  // `u` so an astral character is one code point and one reference, not two broken surrogates.
  return printable(value).replace(
    /[&<>"']|[^ -~]/gu,
    // A regex match is never empty, so the first code point always exists.
    (char) => ENTITIES[char] ?? `&#x${(char.codePointAt(0) as number).toString(16)};`,
  );
}

/**
 * Serializes data for a `<script type="application/json">` block.
 *
 * A `<` inside the JSON could close the tag early (`</script>` in a path) or open a comment, so it
 * is written as the six-character JSON escape backslash-u-003c, which JSON.parse reads back as the
 * same character. `>` and `&` become their escapes (u003e, u0026) the same way for good measure,
 * and every character outside printable ASCII is escaped as well, one UTF-16 unit at a time, which
 * is valid JSON and keeps the file ASCII (D-063).
 * @param value - Any JSON-serializable value.
 * @returns JSON text safe to place between the script tags; never throws for plain data.
 */
export function embedJson(value: unknown): string {
  // No `u` flag: an astral character must become its two surrogate escapes, which JSON requires.
  return JSON.stringify(value).replace(
    /[<>&]|[^ -~]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Merges event lists into one, each ID once, in ascending raw line order.
 * @param lists - Event lists, possibly overlapping.
 * @returns The union, sorted.
 */
export function mergeEvents(...lists: readonly EventRef[]): number[] {
  return [...new Set(lists.flat())].sort((a, b) => a - b);
}

/**
 * Builds the `data-events` attribute the page script reads (principle 4).
 * @param events - Raw line IDs.
 * @returns ` data-events="1 2 3"`, with a leading space so it can follow a tag name.
 */
function eventsAttr(events: EventRef): string {
  return ` data-events="${events.join(" ")}"`;
}

/**
 * States a span with the source it comes from.
 * @param source - `session logs` or `status line`, as the text report writes it.
 * @param span - The span; nulls mean no data yet.
 * @param timeZone - Display zone.
 * @returns E.g. `session logs 2026-09-03 10:00 to 13:05 (UTC)`.
 */
function sourceSpan(source: string, span: Span, timeZone: string): string {
  return `${source} ${formatCoverage(span.from, span.to, timeZone)}`;
}

/**
 * Finds one source's coverage.
 * @param data - Report data.
 * @param source - Which source.
 * @returns Its span, or an empty span when the source has no row.
 */
function coverageOf(data: HtmlReportData, source: CoverageRow["source"]): Span {
  return data.coverage.find((row) => row.source === source)?.span ?? { from: null, to: null };
}

/** One table cell: its text and, for a number, the events behind it. */
interface Cell {
  /** Display text, unescaped. */
  readonly text: string;
  /** Raw line IDs behind the value; omitted for text that isn't a measured number. */
  readonly events?: EventRef;
  /** True for a number, which is right-aligned. */
  readonly numeric?: boolean;
}

/** One table row: the name the script shows for its cells, and the cells. */
interface Row {
  /** Names the row in an event panel's label, e.g. `5-hour window resetting 2026-09-03 13:00`. */
  readonly name: string;
  /** The row's cells, in column order. */
  readonly cells: readonly Cell[];
}

/**
 * Builds a plain text cell.
 * @param text - Display text.
 * @returns The cell.
 */
function textCell(text: string): Cell {
  return { text };
}

/**
 * Builds a number cell that resolves to its events.
 * @param text - The formatted number.
 * @param events - Raw line IDs behind it.
 * @returns The cell.
 */
function numberCell(text: string, events: EventRef): Cell {
  return { text, events, numeric: true };
}

/**
 * Renders a chart's table view, readable without JavaScript and by a screen reader (D-070).
 *
 * Built here from the same data as the chart, so the table and the picture can't disagree. A cell
 * with events carries `data-events` and a label naming its column and row, so a keyboard user can
 * list the events behind any number from the table too.
 * @param caption - What the table shows.
 * @param headers - Column names.
 * @param rows - The rows.
 * @returns A closed `<details>` holding the table.
 */
function tableView(caption: string, headers: readonly string[], rows: readonly Row[]): string {
  const head = headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = row.cells
        .map((cell, column) => {
          const numeric = cell.numeric === true ? ' class="num"' : "";
          const events =
            cell.events === undefined
              ? ""
              : // Rows are built beside their headers, one cell per column, so the header exists.
                `${eventsAttr(cell.events)} data-label="${escapeHtml(`${String(headers[column])}, ${row.name}`)}"`;
          return `<td${numeric}${events}>${escapeHtml(cell.text)}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("\n");
  return [
    `<details class="nm-table"><summary>${escapeHtml(`${HTML_LABELS.tableView}: ${caption}`)}</summary>`,
    `<div class="table-scroll"><table><caption>${escapeHtml(caption)}</caption>`,
    `<thead><tr>${head}</tr></thead>`,
    `<tbody>\n${body}\n</tbody></table></div></details>`,
  ].join("\n");
}

/** What one chart section holds. */
interface SectionParts {
  /** The section's `id`, which the order guard reads. */
  readonly id: string;
  /** Heading text, unescaped. */
  readonly heading: string;
  /** The span line, unescaped, starting with "Covers:" (principle 5). */
  readonly span: string;
  /** HTML placed under the span. */
  readonly body: string;
  /** A small tag above the heading, unescaped; used to say "Projected" in the label itself. */
  readonly tag?: string;
}

/**
 * Wraps a chart in its section: heading, span, body, and a hidden panel the script fills with the
 * events behind a selected element.
 * @param parts - The section's parts.
 * @returns The section HTML.
 */
function chartSection(parts: SectionParts): string {
  const tag = parts.tag === undefined ? "" : `<p class="eyebrow">${escapeHtml(parts.tag)}</p>\n`;
  return [
    `<section class="panel nm-chart" id="${parts.id}" aria-labelledby="${parts.id}-h">`,
    `${tag}<div class="panel-title"><h3 id="${parts.id}-h">${escapeHtml(parts.heading)}</h3>`,
    `<p class="span">${escapeHtml(parts.span)}</p></div>`,
    parts.body,
    // Hidden until the script fills it: without JavaScript it would be an empty box.
    '<div class="nm-events" aria-live="polite" hidden></div>',
    "</section>",
  ].join("\n");
}

/**
 * Wraps chart SVG so CSS can scale it.
 * @param svg - SVG text from a chart function.
 * @returns The wrapped chart.
 */
function plot(svg: string): string {
  return `<div class="plot">${svg}</div>`;
}

/**
 * Renders a paragraph of escaped text.
 * @param text - Text, unescaped.
 * @param className - CSS class.
 * @returns The paragraph.
 */
function para(text: string, className = "caveat"): string {
  return `<p class="${className}">${escapeHtml(text)}</p>`;
}

/**
 * Renders a paragraph stating a count, which resolves to the events behind it like any drawn
 * element (principle 4): the script lists them when the paragraph is selected.
 * @param text - The line, unescaped, with the count in it.
 * @param events - Raw line IDs behind the count.
 * @param label - Names the count at the head of its events list.
 * @param className - CSS class.
 * @returns The paragraph.
 */
function countPara(text: string, events: EventRef, label: string, className = "caveat"): string {
  return `<p class="${className}"${eventsAttr(events)} data-label="${escapeHtml(label)}">${escapeHtml(text)}</p>`;
}

/**
 * Renders a line of split counts in the text report's phrasing, each count its own element with
 * its own events, so every number on the line resolves to exactly the hits behind it (principle 4).
 * @param parts - Each split: its phrase before the count, the count, its events, and its name at
 *   the head of an events list.
 * @returns The paragraph, with the visible text `a: 1 | b: 2`.
 */
function splitPara(
  parts: readonly {
    readonly phrase: string;
    readonly count: number;
    readonly events: EventRef;
    readonly name: string;
  }[],
): string {
  const counts = parts.map(
    (part) =>
      `${escapeHtml(part.phrase)}: <span class="num"${eventsAttr(part.events)} data-label="${escapeHtml(part.name)}">${escapeHtml(formatNumber(part.count, "count"))}</span>`,
  );
  return `<p class="sub">${counts.join(" | ")}</p>`;
}

/**
 * Says how many limit hits no gauge column holds (D-023's membership rule in the contract), in the
 * same plain terms as the other caveats. Singular and plural differ past the count itself.
 * @param count - Hits in no column; above zero.
 * @returns The line, unescaped.
 */
function noColumnText(count: number): string {
  const one = count === 1;
  // The three ways a hit misses every column, as the contract's membership rule defines them.
  return one
    ? "1 limit hit isn't in any column: its window is unknown, it has no time, or no counted window of its kind holds its time."
    : `${plural(count, "limit hit", "limit hits")} aren't in any column: their windows are unknown, they have no time, or no counted window of their kind holds their time.`;
}

/**
 * Finds the span of a list of instants.
 * @param instants - ISO-8601 UTC text, in any order.
 * @returns The earliest and latest; nulls when the list is empty.
 */
function spanOf(instants: readonly string[]): Span {
  // ISO-8601 UTC text sorts chronologically, so a string sort finds both ends without parsing.
  const sorted = [...instants].sort();
  return { from: sorted[0] ?? null, to: sorted.at(-1) ?? null };
}

/**
 * Renders a legend of color keys.
 * @param entries - Key class and label pairs.
 * @returns The legend.
 */
function legend(entries: readonly (readonly [string, string])[]): string {
  const items = entries
    .map(([key, label]) => `<span><i class="${key}"></i>${escapeHtml(label)}</span>`)
    .join("");
  return `<div class="legend">${items}</div>`;
}

/**
 * Renders the header: title, zone, last ingest, and the privacy note (README section Privacy).
 * @param data - Report data.
 * @returns The header HTML.
 */
function renderHeader(data: HtmlReportData): string {
  const zone = data.timeZone;
  const ingest = data.lastIngestAt === null ? "none yet" : formatInstant(data.lastIngestAt, zone);
  const meta = `Times are in ${zone}. Last ingest: ${ingest}. Report produced: ${formatInstant(data.generatedAtUtc, zone)}.`;
  return [
    '<header class="nm-head">',
    `<h1>${escapeHtml(LABELS.title)}</h1>`,
    para(meta, "meta"),
    para(HTML_LABELS.privacy, "privacy"),
    "</header>",
  ].join("\n");
}

/**
 * Renders the coverage section: how far back each source reaches.
 * @param data - Report data.
 * @param options - Chart options.
 * @returns The section.
 */
function renderCoverageSection(data: HtmlReportData, options: ChartOptions): string {
  const zone = data.timeZone;
  const logs = coverageOf(data, "session_logs");
  const status = coverageOf(data, "status_line");
  const rows: Row[] = [
    {
      name: "Session logs",
      cells: [
        textCell("Session logs"),
        textCell(HTML_LABELS.sessionLogsHold),
        textCell(formatCoverage(logs.from, logs.to, zone)),
      ],
    },
    {
      name: "Status line",
      cells: [
        textCell("Status line"),
        textCell(HTML_LABELS.statusLineHolds),
        textCell(formatCoverage(status.from, status.to, zone)),
      ],
    },
  ];
  return chartSection({
    id: "nm-coverage",
    heading: HTML_LABELS.coverage,
    span: `Covers: ${sourceSpan("session logs", logs, zone)}; ${sourceSpan("status line", status, zone)}`,
    body: [
      plot(renderCoverage(data.coverage, options)),
      tableView(
        HTML_LABELS.coverage,
        [HTML_LABELS.source, HTML_LABELS.holds, LABELS.columns.covers],
        rows,
      ),
    ].join("\n"),
  });
}

/**
 * Names a usage window instance for headings and table rows.
 * @param window - Window key.
 * @param resetAtUtc - Reset instant.
 * @param timeZone - Display zone.
 * @returns E.g. `5-hour window resetting 2026-09-03 13:00`.
 */
function windowTitle(window: string, resetAtUtc: string, timeZone: string): string {
  return `${windowName(window)} window resetting ${formatInstant(resetAtUtc, timeZone)}`;
}

/**
 * Renders one window's readings over time inside a closed `<details>`, which the script opens when
 * its gauge column is selected; without JavaScript it opens by hand (D-070).
 *
 * Its span line states the readings' span as the status line's, and the drawn hits' span apart
 * under their own name: a hit's time can come from a session log, so folding it into the status
 * line's span would claim that source covers a time it doesn't (principle 5). When the column
 * counts hits the series can't draw, a line says how many, with their events.
 * @param series - The window's readings and hits.
 * @param options - Chart options.
 * @returns The series container.
 */
function renderSeries(series: WindowSeries, options: ChartOptions): string {
  const zone = options.timeZone;
  const readingSpan = spanOf(series.points.map((p) => p.atUtc));
  const hitSpan = spanOf(series.hits.map((h) => h.atUtc));
  const covers =
    `Covers: ${sourceSpan("status line", readingSpan, zone)}` +
    (series.hits.length > 0 ? `; ${sourceSpan("limit hits", hitSpan, zone)}` : "");
  const title = windowTitle(series.window, series.resetAtUtc, zone);
  const rows: { at: string; cells: Cell[] }[] = [
    ...series.points.map((p) => ({
      at: p.atUtc,
      cells: [
        textCell(formatInstant(p.atUtc, zone)),
        textCell(HTML_LABELS.reading),
        numberCell(formatNumber(p.used, "percent"), [p.event]),
      ],
    })),
    ...series.hits.map((h) => ({
      at: h.atUtc,
      cells: [
        textCell(formatInstant(h.atUtc, zone)),
        // A hit has no usage value; its event hangs on the "Limit hit" cell instead.
        { text: HTML_LABELS.hit, events: [h.event] },
        { text: "", numeric: true },
      ],
    })),
  ];
  // Readings and hits interleaved in time order, as the chart draws them.
  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const key = `${series.window}|${series.resetAtUtc}`;
  return [
    `<details class="nm-series" data-series="${escapeHtml(key)}">`,
    `<summary>${escapeHtml(`${title}: readings over time`)}</summary>`,
    para(covers, "span"),
    plot(renderWindowSeries(series, options)),
    tableView(
      `${title}: readings over time`,
      [HTML_LABELS.time, HTML_LABELS.event, HTML_LABELS.usage],
      rows.map((row) => ({ name: `${title}, ${formatInstant(row.at, zone)}`, cells: row.cells })),
    ),
    "</details>",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * Finds a gauge column's series by the window's identity (D-024), not by position, so a
 * reordering in the data can't pair a column with another window's readings.
 * @param data - Report data.
 * @param window - Window key.
 * @param resetAtUtc - Reset instant.
 * @returns The series; undefined when the data has none for that window.
 */
function seriesOf(
  data: HtmlReportData,
  window: string,
  resetAtUtc: string,
): WindowSeries | undefined {
  return data.series.find((s) => s.window === window && s.resetAtUtc === resetAtUtc);
}

/**
 * Renders the lines under the gauge that count what no column shows: readings captured after
 * their window's reset (D-024) and limit hits in no column. Each appears only when its count is
 * above zero, as the text report prints the first, and each resolves to its events.
 * @param data - Report data.
 * @returns Paragraphs, possibly none.
 */
function gaugeNotes(data: HtmlReportData): string[] {
  const lines: string[] = [];
  const after = data.afterReset;
  if (after.count > 0) {
    lines.push(
      countPara(
        `Readings captured after their window's reset, not counted: ${formatNumber(after.count, "count")}`,
        after.events,
        "Readings captured after their window's reset",
      ),
    );
  }
  const totals = data.interruptions;
  if (totals.hitsInNoColumn > 0) {
    lines.push(
      countPara(
        noColumnText(totals.hitsInNoColumn),
        totals.hitsInNoColumnEvents,
        "Limit hits in no column",
      ),
    );
  }
  return lines;
}

/**
 * Renders the gauge section: one column per window, each window's series, and the gauge's table.
 * @param data - Report data.
 * @param options - Chart options.
 * @returns The section.
 */
function renderGaugeSection(data: HtmlReportData, options: ChartOptions): string {
  const zone = data.timeZone;
  const status = coverageOf(data, "status_line");
  const span = `Covers: ${sourceSpan("status line", status, zone)}. Readings start when the collector is installed.`;
  const notes = gaugeNotes(data);
  if (data.gauge.length === 0) {
    return chartSection({
      id: "nm-gauge",
      heading: LABELS.windows,
      span,
      body: [para(LABELS.noReadings), ...notes].join("\n"),
    });
  }
  const c = LABELS.columns;
  const rows = data.gauge.map((w: GaugeWindow): Row => ({
    name: windowTitle(w.window, w.resetAtUtc, zone),
    cells: [
      textCell(windowName(w.window)),
      textCell(formatInstant(w.resetAtUtc, zone)),
      numberCell(formatNumber(w.peak, "percent"), w.peakEvents),
      textCell(formatInstant(w.peakAtUtc, zone)),
      numberCell(formatNumber(w.last, "percent"), w.lastEvents),
      textCell(formatInstant(w.lastAtUtc, zone)),
      // The counted readings are the window's series points, one event each.
      numberCell(
        formatNumber(w.readings, "count"),
        (seriesOf(data, w.window, w.resetAtUtc)?.points ?? []).map((p) => p.event),
      ),
      numberCell(formatNumber(w.limitHits, "count"), w.hitEvents),
      textCell(w.open ? "open" : "reset"),
    ],
  }));
  return chartSection({
    id: "nm-gauge",
    heading: LABELS.windows,
    span,
    body: [
      legend([
        ["k-fill", HTML_LABELS.legendPeak],
        ["k-tick", HTML_LABELS.legendLast],
        ["k-hit", HTML_LABELS.legendHit],
      ]),
      plot(renderGauge(data.gauge, options)),
      para(`${LABELS.windowsCaveat} ${HTML_LABELS.over100}`),
      ...notes,
      para(HTML_LABELS.seriesHint, "nm-hint"),
      `<div class="nm-series-list">\n${data.series.map((s) => renderSeries(s, options)).join("\n")}\n</div>`,
      tableView(
        LABELS.windows,
        [
          c.window,
          c.resets,
          c.peak,
          HTML_LABELS.peakAt,
          c.lastUsage,
          c.readingAt,
          c.readings,
          HTML_LABELS.limitHits,
          c.status,
        ],
        rows,
      ),
    ].join("\n"),
  });
}

/**
 * Builds the cell for what followed a lockout's reset: a duration that resolves to the request
 * that ended it, or, when no request followed, the reason as plain text with no events.
 * @param bar - The lockout.
 * @returns The cell.
 */
function nextRequestCell(bar: LockoutBar): Cell {
  if (bar.resetToNextRequestSeconds !== null) {
    return numberCell(
      formatNumber(bar.resetToNextRequestSeconds, "duration"),
      bar.nextRequestEvents,
    );
  }
  return textCell(bar.resetAfterCoverage ? HTML_LABELS.resetAfterLogs : HTML_LABELS.noRequestAfter);
}

/**
 * Renders the counts the text report prints beside the lockouts (renderObserved), in its exact
 * phrases, each resolving to its events. Each split count by window and by source has its own
 * event list, so selecting one lists only the hits behind that number.
 * @param data - Report data.
 * @returns The total line and the count lines.
 */
function interruptionCounts(data: HtmlReportData): string {
  const t = data.interruptions;
  /**
   * Formats a count as the text report does.
   * @param value - The count.
   * @returns E.g. `1,204`.
   */
  const n = (value: number): string => formatNumber(value, "count");
  // The intervals' hits are exactly the events behind the total; hits with an unknown reset aren't.
  const inIntervals = mergeEvents(...data.lockouts.map((bar) => bar.events));
  const total = `<p class="total"><span class="num"${eventsAttr(inIntervals)} data-label="${escapeHtml(HTML_LABELS.lockoutElapsed)}">${escapeHtml(formatNumber(t.lockoutSeconds, "duration"))}</span> ${escapeHtml(`across ${plural(t.lockoutIntervals, "lockout", "lockouts")}`)}</p>`;
  return [
    '<div class="nm-counts">',
    total,
    countPara(
      `Hits with an unknown reset time, not included: ${n(t.hitsWithUnknownReset)}`,
      t.unknownResetEvents,
      "Hits with an unknown reset time",
      "sub",
    ),
    countPara(`${LABELS.limitHits}: ${n(t.hits)}`, t.events, LABELS.limitHits, "count"),
    splitPara([
      {
        phrase: "5-hour window",
        count: t.fiveHourHits,
        events: t.fiveHourEvents,
        name: `${LABELS.limitHits}, 5-hour window`,
      },
      {
        phrase: "weekly window",
        count: t.sevenDayHits,
        events: t.sevenDayEvents,
        name: `${LABELS.limitHits}, weekly window`,
      },
      {
        phrase: "window unknown",
        count: t.unknownWindowHits,
        events: t.unknownWindowEvents,
        name: `${LABELS.limitHits}, window unknown`,
      },
    ]),
    splitPara([
      {
        phrase: "From the session logs",
        count: t.loggedHits,
        events: t.loggedEvents,
        name: `${LABELS.limitHits}, from the session logs`,
      },
      {
        phrase: "seen only in the status line",
        count: t.statusLineOnlyHits,
        events: t.statusLineOnlyEvents,
        name: `${LABELS.limitHits}, seen only in the status line`,
      },
    ]),
    "</div>",
  ].join("\n");
}

/**
 * Renders the elapsed lockout time section, with the interruption counts and caveats next to the
 * number. The total is the view's own (`obs_lockout_time` through the data), not a sum of the
 * drawn bars, so the page and the text report print the same figure.
 * @param data - Report data.
 * @param options - Chart options.
 * @returns The section.
 */
function renderLockoutSection(data: HtmlReportData, options: ChartOptions): string {
  const zone = data.timeZone;
  // The counts' own span, as the text report states it beside them.
  const span = `Covers: ${sourceSpan("session logs", data.interruptions.span, zone)}; ${sourceSpan("status line", coverageOf(data, "status_line"), zone)}`;
  const bars = data.lockouts;
  const summary = interruptionCounts(data);
  // The text report's auto-resume caveat qualifies the not-resumed counts, which the page doesn't
  // print, so it stays with them in the text report rather than seeming to qualify the hits here.
  const caveats = para(HTML_LABELS.lockoutCaveat);
  if (bars.length === 0) {
    return chartSection({
      id: "nm-lockouts",
      heading: LABELS.lockout,
      span,
      body: [summary, para(HTML_LABELS.noLockouts), caveats].join("\n"),
    });
  }
  const resetHeader =
    LABELS.resetToNextRequest.charAt(0).toUpperCase() + LABELS.resetToNextRequest.slice(1);
  const rows = bars.map((bar): Row => ({
    name: `Lockout from ${formatInstant(bar.lockedFromUtc, zone)}`,
    cells: [
      textCell(formatInstant(bar.lockedFromUtc, zone)),
      textCell(formatInstant(bar.lockedUntilUtc, zone)),
      numberCell(formatNumber(bar.seconds, "duration"), bar.events),
      numberCell(formatNumber(bar.hits, "count"), bar.events),
      nextRequestCell(bar),
    ],
  }));
  return chartSection({
    id: "nm-lockouts",
    heading: LABELS.lockout,
    span,
    body: [
      summary,
      caveats,
      plot(renderLockouts(bars, options)),
      tableView(
        LABELS.lockout,
        [
          HTML_LABELS.lockoutFrom,
          HTML_LABELS.lockoutUntil,
          HTML_LABELS.lockoutElapsed,
          HTML_LABELS.hits,
          resetHeader,
        ],
        rows,
      ),
    ].join("\n"),
  });
}

/**
 * Renders output tokens by model.
 * @param data - Report data.
 * @param options - Chart options.
 * @returns The section.
 */
function renderModelSection(data: HtmlReportData, options: ChartOptions): string {
  const span = `Covers: ${sourceSpan("session logs", coverageOf(data, "session_logs"), data.timeZone)}`;
  if (data.models.length === 0) {
    return chartSection({
      id: "nm-models",
      heading: HTML_LABELS.models,
      span,
      body: para(HTML_LABELS.noRequests),
    });
  }
  const c = LABELS.columns;
  const rows = data.models.map((m: ModelBar): Row => ({
    name: m.model,
    cells: [
      textCell(m.model),
      numberCell(formatNumber(m.requests, "count"), m.events),
      numberCell(formatNumber(m.outputTokens, "tokens"), m.events),
    ],
  }));
  return chartSection({
    id: "nm-models",
    heading: HTML_LABELS.models,
    span,
    body: [
      plot(renderModelBars(data.models, options)),
      tableView(HTML_LABELS.models, [c.model, c.requests, c.output], rows),
    ].join("\n"),
  });
}

/**
 * Formats the plan price cell, as the text report does.
 * @param month - A month.
 * @returns Name and price, or "none entered".
 */
function planText(month: MonthBar): string {
  return month.planName === null
    ? "none entered"
    : `${month.planName}, ${formatNumber(month.planUsdPerMonth, "usd")} per month`;
}

/**
 * Renders the notes the text report prints under the monthly table. The two counts resolve to
 * their requests like any other number on the page (principle 4); the plain notes don't count.
 * @param months - The months shown.
 * @param notes - Rate readings and the lower-bound count, with their requests.
 * @returns Paragraphs, escaped.
 */
function monthNotes(months: readonly MonthBar[], notes: PriceNotes): string[] {
  const lines: string[] = [];
  // One line per reading date, each with its own count, as renderProjected prints them.
  for (const reading of notes.rateReadings) {
    lines.push(
      countPara(
        `Rates were read from Anthropic's pricing page on ${reading.verifiedOn}; ${formatNumber(reading.pricedBeforeVerifiedRequests, "count")} requests dated before that are priced at those rates.`,
        reading.events,
        `Requests priced at the rate read on ${reading.verifiedOn}`,
        "note",
      ),
    );
  }
  if (notes.lowerBoundRequests > 0) {
    lines.push(
      countPara(
        `Requests with cache writes of unrecorded duration, priced at the 5-minute rate (their cost is a lower bound): ${formatNumber(notes.lowerBoundRequests, "count")}`,
        notes.lowerBoundEvents,
        "Requests priced as a lower bound",
        "note",
      ),
    );
  }
  if (months.some((month) => month.unpricedRequests > 0)) {
    lines.push(para(HTML_LABELS.unpricedNote, "note"));
  }
  if (months.every((month) => month.planName === null)) {
    lines.push(para(HTML_LABELS.planHint, "note"));
  }
  return lines;
}

/**
 * Renders observed tokens at API list price by month, the projected section below the seam.
 * @param data - Report data.
 * @param options - Chart options.
 * @returns The section.
 */
function renderMonthSection(data: HtmlReportData, options: ChartOptions): string {
  const zone = data.timeZone;
  const months = data.months;
  // Months come in order, so the first starts the span and the last ends it.
  const span: Span = { from: months[0]?.span.from ?? null, to: months.at(-1)?.span.to ?? null };
  const heading = { id: "nm-months", heading: LABELS.apiListPrice, tag: HTML_LABELS.projectedTag };
  const spanText = `Covers: ${sourceSpan("session logs", span, zone)}`;
  // The zone and the Claude Code-only scope sit next to the amounts, as in the text report.
  const scope = para(`Months in ${zone}. ${LABELS.apiListPriceScope}`);
  if (months.length === 0) {
    return chartSection({
      ...heading,
      span: spanText,
      body: [scope, para(HTML_LABELS.noRequests)].join("\n"),
    });
  }
  const c = LABELS.columns;
  const rows = months.map((m): Row => ({
    name: m.month,
    cells: [
      textCell(m.month),
      numberCell(formatNumber(m.apiListPriceUsd, "usd"), m.events),
      textCell(planText(m)),
      numberCell(formatNumber(m.pricedRequests, "count"), m.events),
      numberCell(formatNumber(m.unpricedRequests, "count"), m.unpricedEvents),
      textCell(`${formatInstant(m.span.from, zone)} to ${formatInstant(m.span.to, zone)}`),
    ],
  }));
  return chartSection({
    ...heading,
    span: spanText,
    body: [
      legend([
        ["k-price", HTML_LABELS.legendPrice],
        ["k-plan", HTML_LABELS.legendPlan],
      ]),
      scope,
      para(HTML_LABELS.repricing),
      plot(renderMonthBars(months, options)),
      tableView(
        LABELS.apiListPrice,
        [c.month, c.apiListPrice, c.planPrice, c.priced, c.unpriced, c.covers],
        rows,
      ),
      ...monthNotes(months, data.priceNotes),
    ].join("\n"),
  });
}

/**
 * The page's styles. Theme tokens are shared with the chart SVG (G1.2), which fills and strokes
 * with `var(--...)`, so one redefinition under `prefers-color-scheme: dark` switches both. System
 * font stacks only: a web font would be a network request.
 */
const PAGE_STYLE = `
:root {
  color-scheme: light dark;
  --page: #eef1f1; --surface: #fbfcfc; --sunken: #e3e8e8; --ink: #13212a; --ink-2: #44535c;
  --muted: #6f7d85; --grid: #d9e0e1; --axis: #b6c1c3; --water: #1f7a8c; --water-deep: #155e6c;
  --silt: #a8793a; --limit: #c2412d;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0c1417; --surface: #121c20; --sunken: #0f181b; --ink: #eef3f4; --ink-2: #b9c6ca;
    --muted: #8a999e; --grid: #223035; --axis: #33454b; --water: #3aa7b8; --water-deep: #7cc9d5;
    --silt: #d1a563; --limit: #e5604b;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font-family: var(--sans); font-size: 15px; line-height: 1.55; }
main { max-width: 1040px; margin: 0 auto; padding: 32px 20px 64px; display: grid; gap: 28px; }
@media (max-width: 520px) { main { padding: 20px 16px 48px; } }
h1 { font-size: clamp(24px, 4vw, 32px); line-height: 1.15; font-weight: 600; margin: 0; }
h2, h3 { margin: 0; }
h3 { font-size: 16px; font-weight: 600; }
p { margin: 0; }
.nm-head { display: grid; gap: 6px; }
.meta, .span, .note { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.privacy { font-size: 13px; color: var(--ink-2); }
.eyebrow { font-family: var(--mono); font-size: 12px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--water); font-weight: 600; }
.nm-part { display: grid; gap: 28px; }
.panel { display: grid; gap: 10px; background: var(--surface); border-radius: 10px; padding: 18px 20px; min-width: 0; }
@media (max-width: 520px) { .panel { padding: 14px 12px; } }
.panel-title { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 4px 16px; }
.caveat { font-size: 13px; color: var(--ink-2); }
.total { font-size: 15px; }
.total .num { font-weight: 600; }
.nm-counts { display: grid; gap: 2px; }
.nm-counts .count { font-size: 14px; margin-top: 6px; }
.nm-counts .sub { font-size: 13px; color: var(--ink-2); padding-left: 16px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 12.5px; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { display: inline-block; }
.k-fill { width: 12px; height: 12px; border-radius: 2px; background: var(--water); }
.k-tick { width: 14px; height: 2px; background: var(--ink); }
.k-hit { width: 12px; height: 12px; border-radius: 2px; background: var(--limit); }
.k-price { width: 12px; height: 12px; border-radius: 2px; background: var(--silt); opacity: 0.55; }
.k-plan { width: 14px; height: 0; border-top: 2px dashed var(--silt); }
.plot svg { display: block; width: 100%; height: auto; overflow: visible; }
svg text { font-family: var(--mono); font-size: 10.5px; fill: var(--muted); }
.nm-js [data-events], .nm-js .nm-col { cursor: pointer; }
[data-events]:focus-visible, .nm-col:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.nm-sel { outline: 2px solid var(--ink); outline-offset: 1px; }
.nm-hint { display: none; font-size: 13px; color: var(--muted); }
.nm-js .nm-hint { display: block; }
.nm-series-list { display: grid; gap: 6px; }
.nm-js .nm-series:not([open]) { display: none; }
.nm-series { background: var(--sunken); border-radius: 8px; padding: 10px 12px; }
.nm-series > summary { font-weight: 600; cursor: pointer; }
.nm-series[open] > * + * { margin-top: 8px; }
.seam { display: flex; align-items: center; gap: 12px; font-family: var(--mono); font-size: 12px; font-weight: 600; letter-spacing: 0.06em; color: var(--silt); }
.seam::before, .seam::after { content: ""; flex: 1; border-top: 2px dashed var(--silt); opacity: 0.7; }
#nm-observed-h { color: var(--water); }
.nm-events { background: var(--sunken); border-radius: 8px; padding: 10px 12px; font-size: 13px; display: grid; gap: 6px; }
.nm-events[hidden] { display: none; }
.nm-events ol { margin: 0; padding-left: 22px; font-family: var(--mono); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
details.nm-table > summary { cursor: pointer; font-size: 13px; color: var(--ink-2); }
details.nm-table, .nm-series { min-width: 0; max-width: 100%; }
.table-scroll { overflow-x: auto; max-width: 100%; margin-top: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
caption { text-align: left; font-size: 12px; color: var(--muted); padding-bottom: 4px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { font-weight: 500; color: var(--muted); background: var(--sunken); white-space: nowrap; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
code { font-family: var(--mono); }
`;

/**
 * The page's one script. Plain ES2015 in a string, with no imports and no network: it reads the
 * embedded event table and, on a click or on Enter or Space, lists the events behind the selected
 * element in its section's panel, formatted as `nilometer explain` prints them (time, then
 * `file:line`), and opens a gauge column's series. Its pure helpers sit on a global `NM` object so
 * the unit tests can run them in Node; the DOM wiring runs only in a browser. Every value from the
 * data reaches the page through `textContent`, never `innerHTML`, so a crafted path can't inject
 * elements. It must never contain a closing-tag sequence, which a test checks.
 */
const PAGE_SCRIPT = `
"use strict";
var NM = (function () {
  /* Formats an ISO instant as the text report does: YYYY-MM-DD HH:MM in the report's zone. */
  function formatAt(iso, zone) {
    if (iso === null || iso === undefined) { return "unknown"; }
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(iso));
    function part(type) {
      for (var i = 0; i < parts.length; i++) { if (parts[i].type === type) { return parts[i].value; } }
      return "";
    }
    return part("year") + "-" + part("month") + "-" + part("day") + " " + part("hour") + ":" + part("minute");
  }
  /* Reads a data-events value: raw line IDs separated by spaces. */
  function parseIds(text) {
    return String(text || "").split(/\\s+/).filter(function (s) { return s !== ""; })
      .map(Number).filter(function (n) { return isFinite(n); });
  }
  /* Merges ID lists, each ID once, ascending, the order the data layer uses. */
  function union(lists) {
    var seen = {}, out = [];
    lists.forEach(function (list) { list.forEach(function (id) { if (!seen[id]) { seen[id] = true; out.push(id); } }); });
    return out.sort(function (a, b) { return a - b; });
  }
  /* One line per event, as explain prints it: time, two spaces, file:line. Capped at limit. */
  function eventLines(ids, data, limit) {
    var lines = [];
    ids.slice(0, limit).forEach(function (id) {
      var e = data.events[id];
      if (!e) { lines.push("unknown  raw line " + id + ": not in this file"); return; }
      var file = data.files[e.file];
      var where = file === undefined ? "unknown location" : file + ":" + e.line;
      lines.push(formatAt(e.atUtc, data.timeZone) + "  " + where);
    });
    return { lines: lines, more: Math.max(0, ids.length - limit) };
  }
  /* Names a selected element at the head of its list: its data-label, else its SVG title, else
     its aria-label, which is how a gauge column names its window when opened by Enter. */
  function labelOf(el) {
    if (el.hasAttribute("data-label")) { return el.getAttribute("data-label"); }
    for (var i = 0; i < el.children.length; i++) {
      if (el.children[i].tagName.toLowerCase() === "title") { return el.children[i].textContent; }
    }
    if (el.hasAttribute("aria-label")) { return el.getAttribute("aria-label"); }
    return "";
  }
  return { formatAt: formatAt, parseIds: parseIds, union: union, eventLines: eventLines, labelOf: labelOf };
})();
if (typeof document !== "undefined") {
  (function () {
    var LIMIT = ${EVENT_LIST_LIMIT};
    var source = document.getElementById("nm-data");
    if (!source) { return; }
    var data = JSON.parse(source.textContent);
    document.documentElement.classList.add("nm-js");
    var selected = null;
    /* Every element with events becomes reachable by keyboard; a gauge column is one stop. */
    Array.prototype.forEach.call(document.querySelectorAll("[data-events], .nm-col"), function (el) {
      var col = el.closest(".nm-col");
      if (col && col !== el) { return; }
      if (!el.hasAttribute("tabindex")) { el.setAttribute("tabindex", "0"); }
      if (el instanceof SVGElement && !el.hasAttribute("role")) { el.setAttribute("role", "button"); }
    });
    function collect(el) {
      var lists = [];
      if (el.hasAttribute("data-events")) { lists.push(NM.parseIds(el.getAttribute("data-events"))); }
      Array.prototype.forEach.call(el.querySelectorAll("[data-events]"), function (child) {
        lists.push(NM.parseIds(child.getAttribute("data-events")));
      });
      return NM.union(lists);
    }
    function show(panel, ids, label) {
      var listed = NM.eventLines(ids, data, LIMIT);
      panel.textContent = "";
      if (label) { var head = document.createElement("p"); head.className = "nm-events-label"; head.textContent = label; panel.appendChild(head); }
      var count = document.createElement("p");
      count.textContent = ids.length + (ids.length === 1 ? " event" : " events") + " behind it, each as time (" + data.timeZone + ") and file:line:";
      panel.appendChild(count);
      var list = document.createElement("ol");
      listed.lines.forEach(function (line) { var li = document.createElement("li"); li.textContent = line; list.appendChild(li); });
      panel.appendChild(list);
      if (listed.more > 0) {
        var more = document.createElement("p");
        more.textContent = listed.more + " more events not listed; nilometer explain lists every event.";
        panel.appendChild(more);
      }
      panel.hidden = false;
    }
    function openSeries(key) {
      Array.prototype.forEach.call(document.querySelectorAll("details.nm-series"), function (d) {
        d.open = d.getAttribute("data-series") === key;
      });
    }
    function activate(target) {
      var col = target.closest(".nm-col");
      var el = target.closest("[data-events]");
      /* An element inside the column lists its own events; the column itself lists them all. */
      var chosen = el && (!col || col.contains(el)) ? el : col;
      if (!chosen) { return; }
      if (col) { openSeries(col.getAttribute("data-series")); }
      var ids = chosen === el ? NM.parseIds(el.getAttribute("data-events")) : collect(col);
      var section = chosen.closest("section.nm-chart");
      var panel = section ? section.querySelector(".nm-events") : null;
      if (panel) { show(panel, ids, NM.labelOf(chosen)); }
      if (selected) { selected.classList.remove("nm-sel"); }
      selected = chosen;
      selected.classList.add("nm-sel");
    }
    document.addEventListener("click", function (e) {
      if (e.target instanceof Element) { activate(e.target); }
    });
    document.addEventListener("keydown", function (e) {
      var t = e.target;
      if ((e.key === "Enter" || e.key === " ") && t instanceof Element && t.matches("[data-events], .nm-col")) {
        e.preventDefault();
        activate(t);
      }
    });
  })();
}
`;

/**
 * Renders the whole page (step G1.3, D-070): header, coverage, the observed sections, the seam,
 * and the projected monthly section, in the text report's order, with the event table embedded for
 * the script and a table view under every chart.
 * @param data - Everything the report draws, from `loadHtmlData`.
 * @returns One self-contained, ASCII-only HTML document; never throws for well-formed data.
 * @see D-070
 */
function renderPage(data: HtmlReportData): string {
  const options: ChartOptions = { timeZone: data.timeZone, width: CHART_WIDTH };
  const embedded = embedJson({ timeZone: data.timeZone, files: data.files, events: data.events });
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(`${LABELS.title} | Nilometer`)}</title>`,
    `<style>${PAGE_STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    renderHeader(data),
    renderCoverageSection(data, options),
    '<section class="nm-part" id="nm-observed" aria-labelledby="nm-observed-h">',
    `<h2 class="eyebrow" id="nm-observed-h">${escapeHtml(LABELS.observed)}</h2>`,
    renderGaugeSection(data, options),
    renderLockoutSection(data, options),
    renderModelSection(data, options),
    "</section>",
    // The seam: everything below it is derived from the observations above (principle 2).
    '<section class="nm-part" id="nm-projected" aria-labelledby="nm-seam">',
    `<h2 class="seam" id="nm-seam">${escapeHtml(LABELS.projected)}</h2>`,
    renderMonthSection(data, options),
    "</section>",
    "</main>",
    `<script type="application/json" id="nm-data">${embedded}</script>`,
    `<script>${PAGE_SCRIPT}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * Renders the HTML report, typed by the contract so a signature change fails the typecheck.
 * @param data - Everything the report draws.
 * @returns The page.
 * @see D-070
 */
export const renderHtmlReport: RenderHtmlReport = renderPage;
