/**
 * @file The HTML report's charts (step G1.2, D-070). Each exported function turns contract types
 * into one inline `<svg>` element as text: pure and deterministic, with no DOM, no clock, and no
 * randomness, so the page (G1.3) embeds the string and a test reads it in Node.
 *
 * Implements README "MVP scope" and "Measurement Principles" as pictures:
 * - every drawn column, bar, point, and hit flag carries `data-events` with the raw line IDs of the
 *   events behind it, and a `<title>` stating its value and what it is (principle 4); the one
 *   exception is a coverage bar, which draws a span rather than events, so it has only a title;
 * - every chart whose input carries times states the span it covers (principle 5);
 * - the month chart says "projected" in its own label (principles 2 and 3).
 *
 * Usage charts draw only the user's own 100% line, never a Pro or Max limit (D-009, D-070), and
 * their scale reaches above 100% whenever a reading does (D-068). A window is `(window, reset)`
 * (D-024), and readings are dated by their API response (D-045). Colors are CSS variables the page
 * defines for both themes; text always wears a text color, never a series color. Source text is
 * ASCII (D-063). See D-024, D-045, D-063, D-068, D-070.
 */
import type {
  ChartOptions,
  CoverageRow,
  EventRef,
  GaugeWindow,
  LockoutBar,
  ModelBar,
  MonthBar,
  RenderChart,
  WindowSeries,
} from "./html-contract.js";
import {
  UNKNOWN,
  formatCoverage,
  formatDuration,
  formatInstant,
  formatNumber,
  printable,
} from "./format.js";
import { LABELS, plural, windowName } from "./render.js";

/** Attributes of one SVG element, written in insertion order; an undefined value is left out. */
type Attrs = Readonly<Record<string, string | number | undefined>>;

/** The percentage plot shared by the gauge and a window's line, so both read on the same ruler. */
const PLOT = {
  /**
   * Room above the plot: the 100% key on the first row, group or reset labels on the second, and
   * hit flags below that. Labels drawn on the plot itself collided with columns and the reset.
   */
  top: 56,
  /** Baseline of the first label row above the plot (the 100% key). */
  keyRow: 14,
  /** Baseline of the second label row above the plot (group names, the reset). */
  labelRow: 34,
  /** Plot height; 220 makes a 0 to 110% scale exactly 2 units per percentage point. */
  height: 220,
  /** Room left of the plot for the percentage labels. */
  left: 44,
  /** Room right of the plot. */
  right: 12,
  /** Room below the plot for the column labels and the span caption. */
  bottom: 60,
} as const;

/** Most minor ticks the percentage scale draws before it widens its step, so it stays legible. */
const MAX_MINOR_TICKS = 24;

/** Widest a gauge column is drawn, in viewBox units (thin columns; the slot's leftover is air). */
const MAX_COLUMN = 24;

/** Space between the 5-hour group and the weekly group of gauge columns. */
const GROUP_GAP = 24;

/** Closest two column labels in one row may sit before the later one is left out. */
const MIN_LABEL_GAP = 40;

/** Label text for the user's own 100% line: the only limit any usage chart draws (D-009, D-070). */
const LIMIT_LABEL = "100%, your plan's limit";

/** Window order in the gauge: the 5-hour group reads first, then the weekly group. */
const WINDOW_ORDER = ["five_hour", "seven_day"] as const;

/** What each coverage source is called and what it covers, as the text report names them. */
const SOURCES = {
  session_logs: { name: "Session logs", covers: "tokens, models, and limit hits" },
  status_line: { name: "Status line", covers: "usage windows" },
} as const;

/**
 * Escapes text for an SVG text node or a double-quoted attribute value, keeping the output ASCII.
 * @param value - Any text, including model names from the logs.
 * @returns The text with control characters written as visible escapes (D-050: a raw control
 *   character isn't even well-formed XML), `&`, `<`, `>`, `"` as entities, and every other
 *   character outside printable ASCII as a numeric character reference (D-063).
 */
function esc(value: string): string {
  return (
    printable(value)
      // `&` first, so the references written below and the entities after it aren't escaped twice.
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      // A model name from the logs may hold anything; the browser shows the reference as the same
      // character, so the page keeps the name while its source stays ASCII (D-063). The `u` flag
      // takes a character outside the Basic Multilingual Plane as one match, one reference.
      .replace(/[^\x20-\x7e]/gu, reference)
  );
}

/**
 * Writes one character as a numeric character reference.
 * @param char - One code point outside printable ASCII (control characters are already escaped).
 * @returns `&#x<hex>;`; a lone surrogate, which no reference may name in well-formed XML (D-050),
 *   is written as the replacement character U+FFFD, as a browser would show it.
 */
function reference(char: string): string {
  const code = char.codePointAt(0) as number;
  const shown = code >= 0xd800 && code <= 0xdfff ? 0xfffd : code;
  return `&#x${shown.toString(16)};`;
}

/**
 * Writes a coordinate. Rounding here is display rounding: every position is computed unrounded.
 * @param value - A coordinate or length in viewBox units.
 * @returns At most two decimals, trailing zeros dropped; `-0` is written `0`.
 */
function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Writes an element's attributes.
 * @param attributes - Name to value; numbers are coordinates, strings are escaped.
 * @returns ` name="value"` pairs, in insertion order, skipping undefined values.
 */
function attrs(attributes: Attrs): string {
  return Object.entries(attributes)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([name, value]) => ` ${name}="${typeof value === "number" ? num(value) : esc(value)}"`)
    .join("");
}

/**
 * Writes one SVG element.
 * @param tag - Element name.
 * @param attributes - Its attributes.
 * @param children - SVG text inside it, already escaped; empty writes a self-closing element.
 * @returns The element as SVG text.
 */
function el(tag: string, attributes: Attrs, children = ""): string {
  return children === ""
    ? `<${tag}${attrs(attributes)}/>`
    : `<${tag}${attrs(attributes)}>${children}</${tag}>`;
}

/**
 * Writes a `<title>` child, which browsers show on hover and screen readers read.
 * @param text - What the element is and its value, in the report's wording.
 * @returns The escaped element.
 */
function title(text: string): string {
  return `<title>${esc(text)}</title>`;
}

/**
 * Writes a text element in a text color (series colors are for drawn elements only).
 * @param x - Anchor x.
 * @param y - Baseline y.
 * @param content - The text, escaped here.
 * @param attributes - Extra attributes; `fill` defaults to the muted text color.
 * @returns The element as SVG text.
 */
function text(x: number, y: number, content: string, attributes: Attrs = {}): string {
  return el("text", { x, y, fill: "var(--muted)", ...attributes }, esc(content));
}

/**
 * Writes the `data-events` value for a drawn element (principle 4).
 * @param ids - Raw line IDs.
 * @returns The IDs separated by single spaces; empty when there are none.
 */
function eventList(ids: EventRef): string {
  return ids.join(" ");
}

/**
 * Merges event lists for a container that stands for several drawn elements.
 * @param lists - Event lists.
 * @returns Every ID once, ascending.
 */
function union(...lists: readonly EventRef[]): number[] {
  return [...new Set(lists.flat())].sort((a, b) => a - b);
}

/**
 * Finds the earliest and latest of some instants.
 * @param isos - ISO-8601 instants.
 * @returns The earliest and latest as given, or null when there are none.
 */
function extent(isos: readonly string[]): { from: string; to: string } | null {
  if (isos.length === 0) {
    return null;
  }
  // Compare as instants, not as text, so a differently written offset can't reorder them.
  const sorted = [...isos].sort((a, b) => Date.parse(a) - Date.parse(b));
  return { from: sorted[0] as string, to: sorted[sorted.length - 1] as string };
}

/**
 * Writes a chart's root element.
 * @param kind - Short chart name; the root gets class `nm-chart-<kind>`, apart from the element classes.
 * @param options - Width and zone.
 * @param height - viewBox height.
 * @param label - The accessible name: what the chart shows and its span.
 * @param body - Child SVG text.
 * @param extra - Extra root attributes (the window series carries `data-series`).
 * @returns The `<svg>` element.
 */
function svg(
  kind: string,
  options: ChartOptions,
  height: number,
  label: string,
  body: readonly string[],
  extra: Attrs = {},
): string {
  // No xmlns: the element is embedded inline in HTML, which needs none, and the namespace URI
  // would be the only URL in a file that promises to make no network requests (D-070).
  return el(
    "svg",
    {
      class: `nm-chart nm-chart-${kind}`,
      viewBox: `0 0 ${num(options.width)} ${num(height)}`,
      preserveAspectRatio: "xMinYMin meet",
      role: "img",
      "aria-label": label,
      "font-size": 11,
      ...extra,
    },
    body.join(""),
  );
}

/**
 * Writes the chart shown for empty input: a label and no drawn data elements.
 * @param kind - Short chart name.
 * @param options - Width and zone.
 * @param label - What the chart would show.
 * @param extra - Extra root attributes.
 * @returns A small `<svg>` saying "No data".
 */
function noData(kind: string, options: ChartOptions, label: string, extra: Attrs = {}): string {
  return svg(
    kind,
    options,
    40,
    `${label}: No data`,
    [text(0, 24, "No data", { class: "nm-empty" })],
    extra,
  );
}

/** A percentage scale: 0 to `top`, a small tick every `minor`, a number every second tick. */
interface PercentScale {
  /** The highest percentage the scale reaches; always above 100 and above every value. */
  readonly top: number;
  /** Percentage points between small ticks: 10 unless the values need a wider step. */
  readonly minor: number;
}

/**
 * Chooses a percentage scale that reaches above 100% and above every value (D-068).
 *
 * The scale is one minor step past the highest of 100 and the values, so a reading of exactly
 * 100 or 103 still has room above it. Steps run 10, 20, 50, 100, ... so a stray very large valid
 * reading (anything below the epoch check, D-068) widens the ticks instead of drawing hundreds.
 * @param values - Percentages to fit; null and non-finite values are ignored.
 * @returns The scale.
 */
function percentScale(values: readonly (number | null)[]): PercentScale {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const reach = Math.max(100, ...finite);
  let step = 0;
  let minor = 10;
  while (Math.floor(reach / minor) + 1 > MAX_MINOR_TICKS) {
    step += 1;
    minor = oneTwoFive(step) * 10;
  }
  return { top: (Math.floor(reach / minor) + 1) * minor, minor };
}

/**
 * The 1, 2, 5, 10, 20, 50, ... sequence, for tick steps a reader can add up at a glance.
 * @param index - Position in the sequence, from 0.
 * @returns The value at that position.
 */
function oneTwoFive(index: number): number {
  const digit = index % 3 === 0 ? 1 : index % 3 === 1 ? 2 : 5;
  return digit * 10 ** Math.floor(index / 3);
}

/**
 * Places a percentage on the shared plot.
 * @param scale - The chart's scale.
 * @param percent - A percentage, possibly above 100 (D-068).
 * @returns Its y coordinate: {@link PLOT}.top at the scale's top, top plus height at 0.
 */
function percentY(scale: PercentScale, percent: number): number {
  return PLOT.top + ((scale.top - percent) / scale.top) * PLOT.height;
}

/**
 * Draws the graduated percentage scale and the user's own 100% line.
 * @param scale - The chart's scale.
 * @param left - Plot's left edge.
 * @param right - Plot's right edge.
 * @returns Grid lines, small ticks, labels, and the dashed 100% line.
 */
function percentAxis(scale: PercentScale, left: number, right: number): string[] {
  const parts: string[] = [];
  // Multiply rather than accumulate, so no floating-point drift moves a tick.
  for (let k = 0; k * scale.minor <= scale.top; k += 1) {
    const percent = k * scale.minor;
    const y = percentY(scale, percent);
    if (k % 2 === 0) {
      // A recessive hairline and a number every second tick; the baseline is one step stronger.
      parts.push(
        el("line", {
          class: "nm-grid",
          x1: left,
          x2: right,
          y1: y,
          y2: y,
          stroke: percent === 0 ? "var(--axis)" : "var(--grid)",
          "stroke-width": 1,
        }),
        text(left - 7, y + 3.5, formatNumber(percent, "percent"), {
          class: "nm-tick",
          "text-anchor": "end",
        }),
      );
    } else {
      // The small graduation between numbers, drawn at the axis only, like a stone gauge.
      parts.push(
        el("line", {
          class: "nm-tick",
          x1: left - 4,
          x2: left,
          y1: y,
          y2: y,
          stroke: "var(--axis)",
          "stroke-width": 1,
        }),
      );
    }
  }
  // The only limit line on a usage chart: the user's own plan at 100% (D-009, D-070).
  const limitY = percentY(scale, 100);
  parts.push(
    el("line", {
      class: "nm-limit",
      x1: left,
      x2: right,
      y1: limitY,
      y2: limitY,
      stroke: "var(--limit)",
      "stroke-width": 1.5,
      "stroke-dasharray": "5 4",
    }),
    // Its key sits above the plot, where no column, point, or reset label can cover it.
    el("line", {
      class: "nm-limit-key",
      x1: left,
      x2: left + 18,
      y1: PLOT.keyRow - 4,
      y2: PLOT.keyRow - 4,
      stroke: "var(--limit)",
      "stroke-width": 1.5,
      "stroke-dasharray": "5 4",
    }),
    text(left + 24, PLOT.keyRow, LIMIT_LABEL, { class: "nm-label", fill: "var(--ink-2)" }),
  );
  return parts;
}

/**
 * Names a window instance for titles and labels.
 * @param window - `five_hour` or `seven_day`.
 * @param resetAtUtc - The window's reset.
 * @param timeZone - Display zone.
 * @returns E.g. `5-hour window resetting 2026-09-03 13:00`.
 */
function windowTitle(window: string, resetAtUtc: string, timeZone: string): string {
  return `${windowName(window)} window resetting ${formatInstant(resetAtUtc, timeZone)}`;
}

/**
 * Draws one gauge column: the track, the fill to the peak, the tick at the last reading, and the
 * hit count on top.
 * @param w - The window.
 * @param cx - Column centre.
 * @param width - Column width.
 * @param scale - The gauge's scale.
 * @param timeZone - Display zone.
 * @returns The column's `<g>`, focusable, carrying the window's identity in `data-series`.
 */
function gaugeColumn(
  w: GaugeWindow,
  cx: number,
  width: number,
  scale: PercentScale,
  timeZone: string,
): string {
  const x = cx - width / 2;
  const top = percentY(scale, scale.top);
  const baseline = percentY(scale, 0);
  const name = windowTitle(w.window, w.resetAtUtc, timeZone);
  // The track is the column's full height, so the whole column is a target, not only its fill.
  const parts = [
    el("rect", {
      class: "nm-track",
      x,
      y: top,
      width,
      height: baseline - top,
      rx: 2,
      fill: "var(--sunken)",
    }),
  ];
  if (w.peak !== null) {
    const y = percentY(scale, w.peak);
    parts.push(
      el(
        "rect",
        {
          class: "nm-data nm-peak",
          "data-events": eventList(w.peakEvents),
          x,
          y,
          width,
          height: baseline - y,
          rx: 2,
          fill: "var(--water)",
        },
        title(
          `${LABELS.columns.peak} ${formatNumber(w.peak, "percent")} at ${formatInstant(w.peakAtUtc, timeZone)}, ${name}`,
        ),
      ),
    );
  }
  if (w.last !== null) {
    const y = percentY(scale, w.last);
    // Wider than the column so the tick stays visible where it meets the fill (last <= peak).
    parts.push(
      el(
        "line",
        {
          class: "nm-data nm-last",
          "data-events": eventList(w.lastEvents),
          x1: x - 3,
          x2: x + width + 3,
          y1: y,
          y2: y,
          stroke: "var(--ink)",
          "stroke-width": 2,
        },
        title(
          `${LABELS.columns.lastUsage} ${formatNumber(w.last, "percent")} at ${formatInstant(w.lastAtUtc, timeZone)}, a lower bound, ${name}`,
        ),
      ),
    );
  }
  if (w.limitHits > 0) {
    // On top of the column: above the fill, or above the baseline when no reading was usable.
    const y = percentY(scale, w.peak ?? w.last ?? 0) - 12;
    parts.push(
      el(
        "circle",
        {
          class: "nm-data nm-hit",
          "data-events": eventList(w.hitEvents),
          cx,
          cy: y,
          r: 8,
          fill: "var(--limit)",
          stroke: "var(--surface)",
          "stroke-width": 2,
        },
        title(`${plural(w.limitHits, "limit hit", "limit hits")} in the ${name}`),
      ),
      // The count sits inside the colored disc, so it takes the surface color to stay legible.
      text(cx, y + 3.5, formatNumber(w.limitHits, "count"), {
        class: "nm-hit-count",
        "text-anchor": "middle",
        fill: "var(--surface)",
        "font-size": 10,
        "font-weight": 600,
        "aria-hidden": "true",
        "pointer-events": "none",
      }),
    );
  }
  if (w.open) {
    parts.push(text(cx, baseline + 12, "open", { class: "nm-open", "text-anchor": "middle" }));
  }
  const summary = [
    `peak ${formatNumber(w.peak, "percent")}`,
    `${LABELS.columns.lastUsage.toLowerCase()} ${formatNumber(w.last, "percent")}`,
    plural(w.limitHits, "limit hit", "limit hits"),
    plural(w.readings, "reading", "readings"),
    ...(w.open ? ["open"] : []),
  ].join(", ");
  const accessibleName = `${name}: ${summary}`;
  return el(
    "g",
    {
      class: "nm-col",
      "data-series": `${w.window}|${w.resetAtUtc}`,
      "data-events": eventList(union(w.peakEvents, w.lastEvents, w.hitEvents)),
      tabindex: "0",
      role: "button",
      "aria-label": accessibleName,
      // The page heads the column's events panel with this: a `<g>` has no `<title>` of its own to
      // read, and the panel should name the window the same way a screen reader does.
      "data-label": accessibleName,
    },
    parts.join(""),
  );
}

/**
 * The gauge: one column per usage window, filled to its peak, ticked at its last observed reading,
 * with its limit hit count on top and the user's own 100% line (D-024, D-068, D-070).
 *
 * 5-hour and weekly windows are two labeled groups side by side, separated by a gap and a
 * hairline, on one shared percentage axis. Within a group, columns keep the input's order (oldest
 * reset first). Each column is a focusable `g.nm-col` whose `data-series` is `<window>|<reset>`,
 * which the page uses to open that window's line.
 * @param windows - Windows with at least one counted reading.
 * @param options - Width and zone.
 * @returns One `<svg>`; a "No data" svg when there are no windows.
 */
export const renderGauge: RenderChart<readonly GaugeWindow[]> = (windows, options) => {
  const label = "Usage windows: peak and last observed usage per window";
  const groups = WINDOW_ORDER.map((window) => windows.filter((w) => w.window === window)).filter(
    (group) => group.length > 0,
  );
  const count = groups.reduce((sum, group) => sum + group.length, 0);
  if (count === 0) {
    return noData("gauge", options, label);
  }
  const tz = options.timeZone;
  const scale = percentScale(windows.flatMap((w) => [w.peak, w.last]));
  const left = PLOT.left;
  const right = options.width - PLOT.right;
  const baseline = percentY(scale, 0);
  const slot = (right - left - GROUP_GAP * (groups.length - 1)) / count;
  const width = Math.min(MAX_COLUMN, slot * 0.62);
  const parts = percentAxis(scale, left, right);
  // Column labels in two rows below the baseline; a label too close to the last shown one in its
  // row is left out, so labels never overlap (each column's title still names its reset).
  let lastTimeX = -Infinity;
  let lastDayX = -Infinity;
  let cursor = left;
  groups.forEach((group, g) => {
    if (g > 0) {
      const x = cursor - GROUP_GAP / 2;
      parts.push(
        el("line", {
          class: "nm-group-rule",
          x1: x,
          x2: x,
          y1: percentY(scale, scale.top),
          y2: baseline,
          stroke: "var(--grid)",
          "stroke-width": 1,
        }),
      );
    }
    parts.push(
      text(cursor, PLOT.labelRow, `${windowName(group[0]?.window ?? "")} windows`, {
        class: "nm-label",
        fill: "var(--ink-2)",
      }),
    );
    let previousDay = "";
    group.forEach((w, i) => {
      const cx = cursor + slot * (i + 0.5);
      parts.push(gaugeColumn(w, cx, width, scale, tz));
      const instant = formatInstant(w.resetAtUtc, tz);
      if (cx - lastTimeX >= MIN_LABEL_GAP) {
        parts.push(text(cx, baseline + 24, instant.slice(11), { "text-anchor": "middle" }));
        lastTimeX = cx;
      }
      // The date only where it changes, as a calendar would.
      const day = instant.slice(5, 10);
      if (day !== previousDay && cx - lastDayX >= MIN_LABEL_GAP) {
        parts.push(text(cx, baseline + 36, day, { "text-anchor": "middle" }));
        lastDayX = cx;
        previousDay = day;
      }
    });
    cursor += slot * group.length + GROUP_GAP;
  });
  const resets = extent(windows.map((w) => w.resetAtUtc)) as { from: string; to: string };
  const span = `Windows resetting ${formatCoverage(resets.from, resets.to, tz)}`;
  parts.push(text(left, baseline + 54, span, { class: "nm-span" }));
  return svg("gauge", options, PLOT.top + PLOT.height + PLOT.bottom, `${label}. ${span}`, parts);
};

/**
 * One window's usage over time: a 2px line through its readings, a point at each reading, a flag
 * at each limit hit, the user's own 100% line, and the reset (D-045, D-068, D-070).
 *
 * The time axis runs from the first reading or hit to the reset (or to a later hit, if any), and
 * the percentage axis is the gauge's, so a column and its line read on the same ruler.
 * @param series - The window's readings and hits.
 * @param options - Width and zone.
 * @returns One `<svg>` whose `data-series` is `<window>|<reset>`; a "No data" svg, with the same
 *   `data-series`, when the window has no readings.
 */
export const renderWindowSeries: RenderChart<WindowSeries> = (series, options) => {
  const tz = options.timeZone;
  const name = windowTitle(series.window, series.resetAtUtc, tz);
  const identity = { "data-series": `${series.window}|${series.resetAtUtc}` };
  const label = `${name}: observed usage over time`;
  if (series.points.length === 0) {
    return noData("series", options, label, identity);
  }
  const scale = percentScale(series.points.map((p) => p.used));
  const reset = Date.parse(series.resetAtUtc);
  const times = [...series.points, ...series.hits].map((p) => Date.parse(p.atUtc));
  const from = Math.min(...times);
  const to = Math.max(reset, ...times);
  // A single instant still needs a width to divide by; one millisecond keeps it at the left edge.
  const duration = Math.max(1, to - from);
  const left = PLOT.left;
  const right = options.width - PLOT.right;
  const top = percentY(scale, scale.top);
  const baseline = percentY(scale, 0);
  /**
   * Places an instant on the time axis.
   * @param iso - ISO-8601 instant.
   * @returns Its x coordinate.
   */
  const timeX = (iso: string): number =>
    left + ((Date.parse(iso) - from) / duration) * (right - left);
  const parts = percentAxis(scale, left, right);
  const resetX = timeX(series.resetAtUtc);
  const resetLabel = `${LABELS.columns.resets} ${formatInstant(series.resetAtUtc, tz)}`;
  parts.push(
    el("line", {
      class: "nm-reset",
      x1: resetX,
      x2: resetX,
      y1: top,
      y2: baseline,
      stroke: "var(--ink-2)",
      "stroke-width": 1,
    }),
    // Above the plot, ending at the reset line; when the reset is too near the left edge for the
    // label to fit before it, the label starts at the line instead.
    resetX - left >= 160
      ? text(resetX, PLOT.labelRow, resetLabel, {
          class: "nm-label",
          "text-anchor": "end",
          fill: "var(--ink-2)",
        })
      : text(resetX, PLOT.labelRow, resetLabel, { class: "nm-label", fill: "var(--ink-2)" }),
  );
  // Hit flags first, so the line and its points draw over the flag staffs.
  for (const hit of series.hits) {
    const x = timeX(hit.atUtc);
    parts.push(
      el(
        "path",
        {
          class: "nm-data nm-hit",
          "data-events": String(hit.event),
          // A staff from the baseline to the top, and a small pennant at the top.
          d: `M${num(x)} ${num(baseline)}V${num(top)}M${num(x)} ${num(top)}h8l-8 5z`,
          fill: "var(--limit)",
          stroke: "var(--limit)",
          "stroke-width": 1.5,
        },
        title(`Limit hit at ${formatInstant(hit.atUtc, tz)}`),
      ),
    );
  }
  const readings = extent(series.points.map((p) => p.atUtc)) as { from: string; to: string };
  const span = `Readings ${formatCoverage(readings.from, readings.to, tz)}`;
  parts.push(
    el(
      "path",
      {
        class: "nm-data nm-line",
        "data-events": eventList(series.points.map((p) => p.event)),
        d: series.points
          .map(
            (p, i) =>
              `${i === 0 ? "M" : "L"}${num(timeX(p.atUtc))} ${num(percentY(scale, p.used))}`,
          )
          .join(""),
        fill: "none",
        stroke: "var(--water)",
        "stroke-width": 2,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      },
      title(
        `Observed usage in the ${name}, ${plural(series.points.length, "reading", "readings")}`,
      ),
    ),
    ...series.points.map((p) =>
      el(
        "circle",
        {
          class: "nm-data nm-point",
          "data-events": String(p.event),
          cx: timeX(p.atUtc),
          cy: percentY(scale, p.used),
          r: 4,
          fill: "var(--water)",
          // A ring in the surface color keeps overlapping points apart.
          stroke: "var(--surface)",
          "stroke-width": 2,
        },
        title(`Observed usage ${formatNumber(p.used, "percent")} at ${formatInstant(p.atUtc, tz)}`),
      ),
    ),
    text(left, baseline + 16, formatInstant(new Date(from).toISOString(), tz)),
  );
  if (to > reset) {
    // A hit logged after the reset extends the axis; label its end so the extra reach is visible.
    parts.push(
      text(right, baseline + 16, formatInstant(new Date(to).toISOString(), tz), {
        "text-anchor": "end",
      }),
    );
  }
  parts.push(text(left, baseline + 54, span, { class: "nm-span" }));
  return svg(
    "series",
    options,
    PLOT.top + PLOT.height + PLOT.bottom,
    `${label}, ${plural(series.points.length, "reading", "readings")}, ${plural(series.hits.length, "limit hit", "limit hits")}. ${span}`,
    parts,
    identity,
  );
};

/** Layout of the coverage chart. */
const COVERAGE = { left: 110, right: 12, top: 6, row: 24 } as const;

/**
 * What each number covers: one bar per source on one shared time axis (principle 5).
 *
 * A coverage bar draws a span, not events, so it carries a `<title>` and no `data-events`.
 * @param rows - One row per source.
 * @param options - Width and zone.
 * @returns One `<svg>`; a "No data" svg when no source has any data.
 */
export const renderCoverage: RenderChart<readonly CoverageRow[]> = (rows, options) => {
  const label = "What each number covers";
  const tz = options.timeZone;
  const known = extent(
    rows.flatMap((row) =>
      row.span.from === null || row.span.to === null ? [] : [row.span.from, row.span.to],
    ),
  );
  if (known === null) {
    return noData("coverage", options, label);
  }
  const from = Date.parse(known.from);
  const duration = Math.max(1, Date.parse(known.to) - from);
  const left = COVERAGE.left;
  const right = options.width - COVERAGE.right;
  /**
   * Places an instant on the time axis.
   * @param iso - ISO-8601 instant.
   * @returns Its x coordinate.
   */
  const timeX = (iso: string): number =>
    left + ((Date.parse(iso) - from) / duration) * (right - left);
  const parts: string[] = [];
  const spoken: string[] = [];
  rows.forEach((row, i) => {
    const source = SOURCES[row.source];
    const y = COVERAGE.top + i * COVERAGE.row;
    const covered = formatCoverage(row.span.from, row.span.to, tz);
    spoken.push(`${source.name.toLowerCase()} ${covered}`);
    parts.push(
      text(0, y + 13, source.name, { class: "nm-label", fill: "var(--ink-2)" }),
      el("rect", {
        class: "nm-track",
        x: left,
        y: y + 3,
        width: right - left,
        height: 12,
        rx: 3,
        fill: "var(--sunken)",
      }),
    );
    if (row.span.from === null || row.span.to === null) {
      parts.push(text(left + 6, y + 13, covered));
      return;
    }
    const x = timeX(row.span.from);
    parts.push(
      el(
        "rect",
        {
          // No `nm-data` and no `data-events`: a span is not an event, and an empty list would make
          // the page offer an events panel with nothing in it. The title still states the span.
          class: "nm-coverage",
          x,
          y: y + 3,
          // A source with one instant still shows as a sliver rather than vanishing.
          width: Math.max(2, timeX(row.span.to) - x),
          height: 12,
          rx: 3,
          fill: "var(--water)",
        },
        title(`${source.name}: ${covered}, covering ${source.covers}`),
      ),
    );
  });
  const axisY = COVERAGE.top + rows.length * COVERAGE.row + 12;
  parts.push(
    text(left, axisY, formatInstant(known.from, tz)),
    text(right, axisY, formatInstant(known.to, tz), { "text-anchor": "end" }),
  );
  return svg("coverage", options, axisY + 6, `${label}: ${spoken.join("; ")}`, parts);
};

/** Layout of the lockout chart. */
const LOCKOUT = { left: 124, valueRoom: 110, top: 8, row: 28 } as const;

/** Duration tick steps in seconds, from a minute to four weeks. */
const DURATION_STEPS = [
  60, 300, 600, 900, 1_800, 3_600, 7_200, 10_800, 21_600, 43_200, 86_400, 172_800, 345_600, 604_800,
  1_209_600, 2_419_200,
] as const;

/**
 * Chooses a duration axis: the smallest listed step that needs at most six ticks.
 * @param longest - The longest duration drawn, in seconds.
 * @returns The step and the axis end (a whole number of steps, at least one), in seconds.
 */
function durationAxis(longest: number): { step: number; end: number } {
  const step =
    DURATION_STEPS.find((s) => Math.ceil(longest / s) <= 6) ??
    // Past four weeks, widen by whole four-week steps.
    2_419_200 * Math.ceil(longest / 2_419_200 / 6);
  return { step, end: Math.max(1, Math.ceil(longest / step)) * step };
}

/**
 * Labels a duration tick in its largest whole unit.
 * @param seconds - A multiple of 60.
 * @returns `0`, `10 m`, `2 h`, or `3 d`.
 */
function durationTick(seconds: number): string {
  if (seconds === 0) {
    return "0";
  }
  if (seconds % 86_400 === 0) {
    return `${seconds / 86_400} d`;
  }
  if (seconds % 3_600 === 0) {
    return `${seconds / 3_600} h`;
  }
  return `${seconds / 60} m`;
}

/**
 * Describes what followed a lockout's reset.
 * @param bar - The lockout.
 * @returns The reset-to-next-request text, or why there is none.
 */
function afterReset(bar: LockoutBar): string {
  if (bar.resetToNextRequestSeconds !== null) {
    return `${formatDuration(bar.resetToNextRequestSeconds)} ${LABELS.resetToNextRequest}`;
  }
  return bar.resetAfterCoverage
    ? "the reset came after the logs end"
    : "no Claude Code request followed the reset";
}

/**
 * Elapsed lockout time: one bar per interval, limit hit to reset, overlapping hits merged (D-023).
 * All bars share one duration axis that starts at 0; each row is labeled with the first hit.
 * @param bars - Lockout intervals in time order.
 * @param options - Width and zone.
 * @returns One `<svg>`; a "No data" svg when there are no lockouts.
 */
export const renderLockouts: RenderChart<readonly LockoutBar[]> = (bars, options) => {
  const label = "Elapsed lockout time, limit hit to reset";
  if (bars.length === 0) {
    return noData("lockouts", options, label);
  }
  const tz = options.timeZone;
  const axis = durationAxis(Math.max(...bars.map((b) => b.seconds)));
  const left = LOCKOUT.left;
  const plotWidth = options.width - left - LOCKOUT.valueRoom;
  const bottom = LOCKOUT.top + bars.length * LOCKOUT.row;
  const parts: string[] = [];
  for (let k = 0; k * axis.step <= axis.end; k += 1) {
    const x = left + ((k * axis.step) / axis.end) * plotWidth;
    parts.push(
      el("line", {
        class: "nm-grid",
        x1: x,
        x2: x,
        y1: LOCKOUT.top,
        y2: bottom,
        stroke: k === 0 ? "var(--axis)" : "var(--grid)",
        "stroke-width": 1,
      }),
      text(x, bottom + 14, durationTick(k * axis.step), {
        class: "nm-tick",
        "text-anchor": "middle",
      }),
    );
  }
  bars.forEach((bar, i) => {
    const y = LOCKOUT.top + i * LOCKOUT.row;
    const width = (bar.seconds / axis.end) * plotWidth;
    const hits = plural(bar.hits, "hit", "hits");
    parts.push(
      text(0, y + 18, formatInstant(bar.lockedFromUtc, tz), {
        class: "nm-label",
        fill: "var(--ink-2)",
      }),
      el(
        "rect",
        {
          class: "nm-data nm-lockout",
          "data-events": eventList(bar.events),
          x: left,
          y: y + 6,
          width,
          height: 16,
          rx: 2,
          fill: "var(--limit)",
        },
        title(
          `Elapsed lockout time ${formatDuration(bar.seconds)}, ${formatCoverage(bar.lockedFromUtc, bar.lockedUntilUtc, tz)}, ${plural(bar.hits, "limit hit", "limit hits")}; ${afterReset(bar)}`,
        ),
      ),
      text(left + width + 6, y + 18, `${formatDuration(bar.seconds)}, ${hits}`, {
        class: "nm-value",
        fill: "var(--ink-2)",
      }),
    );
  });
  const covered = extent(bars.flatMap((b) => [b.lockedFromUtc, b.lockedUntilUtc])) as {
    from: string;
    to: string;
  };
  const span = `Lockouts ${formatCoverage(covered.from, covered.to, tz)}`;
  parts.push(text(0, bottom + 34, span, { class: "nm-span" }));
  return svg("lockouts", options, bottom + 40, `${label}. ${span}`, parts);
};

/** Layout of the model chart. */
const MODELS = { top: 4, row: 24, valueRoom: 90, charWidth: 6.6, maxChars: 32 } as const;

/**
 * Shortens a long model name for its row label; the bar's title keeps the full name.
 * @param model - The exact `message.model` string.
 * @returns The name, or its start and `...` past {@link MODELS}.maxChars characters.
 */
function modelLabel(model: string): string {
  const shown = printable(model);
  return shown.length > MODELS.maxChars ? `${shown.slice(0, MODELS.maxChars - 3)}...` : shown;
}

/**
 * Output tokens by model: one bar per model, one hue, in the input's order (largest first).
 *
 * The contract's model rows carry no dates, so this chart can't state its span; the page states
 * it from the session log coverage.
 * @param bars - Models by output tokens.
 * @param options - Width and zone.
 * @returns One `<svg>`; a "No data" svg when there are no models.
 */
export const renderModelBars: RenderChart<readonly ModelBar[]> = (bars, options) => {
  const label = `${LABELS.byModel}: output tokens`;
  if (bars.length === 0) {
    return noData("models", options, label);
  }
  const labels = bars.map((b) => modelLabel(b.model));
  // Size the label column to the longest name, within bounds, so bars start after every label.
  const longest = Math.max(...labels.map((l) => l.length));
  const left = Math.min(options.width * 0.45, Math.max(80, longest * MODELS.charWidth + 12));
  const plotWidth = options.width - left - MODELS.valueRoom;
  const most = Math.max(...bars.map((b) => b.outputTokens));
  const parts: string[] = [];
  bars.forEach((bar, i) => {
    const y = MODELS.top + i * MODELS.row;
    // With no output tokens at all, every bar is empty rather than divided by zero.
    const width = most > 0 ? (bar.outputTokens / most) * plotWidth : 0;
    parts.push(
      text(0, y + 15, labels[i] ?? "", { class: "nm-label", fill: "var(--ink-2)" }),
      el(
        "rect",
        {
          class: "nm-data nm-model",
          "data-events": eventList(bar.events),
          x: left,
          y: y + 5,
          width,
          height: 14,
          rx: 2,
          fill: "var(--water)",
        },
        title(
          `${bar.model}: ${formatNumber(bar.outputTokens, "tokens")} output tokens from ${plural(bar.requests, "request", "requests")}`,
        ),
      ),
      text(left + width + 6, y + 15, formatNumber(bar.outputTokens, "tokens"), {
        class: "nm-value",
        fill: "var(--ink-2)",
      }),
    );
  });
  return svg(
    "models",
    options,
    MODELS.top + bars.length * MODELS.row + 4,
    `${label}, ${plural(bars.length, "model", "models")}`,
    parts,
  );
};

/** Layout of the month chart. */
const MONTHS = { top: 24, height: 180, left: 56, right: 12, bottom: 56, maxBar: 40 } as const;

/**
 * Chooses a dollar axis: the smallest 1-2-5 step that needs at most five steps.
 * @param highest - The largest dollar amount drawn.
 * @returns The step and the axis end (a whole number of steps, at least one).
 */
function dollarAxis(highest: number): { step: number; end: number } {
  if (!(highest > 0)) {
    return { step: 1, end: 1 };
  }
  const base = 10 ** Math.floor(Math.log10(highest / 5));
  const step =
    [1, 2, 5, 10].map((m) => base * m).find((s) => Math.ceil(highest / s) <= 5) ?? base * 10;
  return { step, end: Math.max(1, Math.ceil(highest / step)) * step };
}

/**
 * Labels a dollar tick with as many decimals as its step needs.
 * @param value - The tick's value.
 * @param step - The axis step.
 * @returns E.g. `$1,000`, `$50`, `$0.02`.
 */
function dollarTick(value: number, step: number): string {
  if (step >= 1) {
    return `$${formatNumber(value, "count")}`;
  }
  // Enough decimals to tell neighbouring ticks apart; the epsilon absorbs log10 rounding.
  return `$${value.toFixed(Math.ceil(-Math.log10(step) - 1e-9))}`;
}

/**
 * Projected: observed tokens at API list price, one column per month, with the plan price entered
 * for that month as a dashed line only when one was entered (D-027, principle 3).
 *
 * A month with nothing priced shows "unknown", never a $0 column (D-005). Nothing here compares
 * the two: both are shown as they are.
 * @param bars - Months in order.
 * @param options - Width and zone.
 * @returns One `<svg>`; a "No data" svg when there are no months.
 */
export const renderMonthBars: RenderChart<readonly MonthBar[]> = (bars, options) => {
  const label = `${LABELS.apiListPrice} (projected)`;
  if (bars.length === 0) {
    return noData("months", options, label);
  }
  const tz = options.timeZone;
  const amounts = bars.flatMap((b) => [b.apiListPriceUsd, b.planUsdPerMonth]);
  const axis = dollarAxis(Math.max(0, ...amounts.filter((v): v is number => v !== null)));
  const left = MONTHS.left;
  const right = options.width - MONTHS.right;
  const baseline = MONTHS.top + MONTHS.height;
  /**
   * Places a dollar amount on the axis.
   * @param usd - Amount, unrounded.
   * @returns Its y coordinate.
   */
  const usdY = (usd: number): number => MONTHS.top + ((axis.end - usd) / axis.end) * MONTHS.height;
  const parts: string[] = [];
  for (let k = 0; k * axis.step <= axis.end * (1 + 1e-9); k += 1) {
    const value = k * axis.step;
    const y = usdY(value);
    parts.push(
      el("line", {
        class: "nm-grid",
        x1: left,
        x2: right,
        y1: y,
        y2: y,
        stroke: k === 0 ? "var(--axis)" : "var(--grid)",
        "stroke-width": 1,
      }),
      text(left - 7, y + 3.5, dollarTick(value, axis.step), {
        class: "nm-tick",
        "text-anchor": "end",
      }),
    );
  }
  const slot = (right - left) / bars.length;
  const width = Math.min(MONTHS.maxBar, slot * 0.5);
  bars.forEach((bar, i) => {
    const cx = left + slot * (i + 0.5);
    const covered = formatCoverage(bar.span.from, bar.span.to, tz);
    if (bar.apiListPriceUsd === null) {
      // Nothing priced: say so, rather than draw a $0 column (D-005).
      parts.push(text(cx, baseline - 6, UNKNOWN, { "text-anchor": "middle" }));
    } else {
      const y = usdY(bar.apiListPriceUsd);
      const usd = formatNumber(bar.apiListPriceUsd, "usd");
      parts.push(
        el(
          "rect",
          {
            class: "nm-data nm-month",
            "data-events": eventList(bar.events),
            x: cx - width / 2,
            y,
            width,
            height: baseline - y,
            rx: 2,
            fill: "var(--silt)",
            "fill-opacity": 0.55,
          },
          title(
            `Projected: observed tokens at API list price for ${bar.month}, ${usd}; ${plural(bar.pricedRequests, "priced request", "priced requests")}, ${plural(bar.unpricedRequests, "unpriced request", "unpriced requests")} (not counted as $0); covers ${covered}`,
          ),
        ),
        text(cx, y - 6, usd, { class: "nm-value", "text-anchor": "middle", fill: "var(--ink)" }),
      );
    }
    if (bar.planUsdPerMonth !== null) {
      const y = usdY(bar.planUsdPerMonth);
      const price = `${bar.planName ?? LABELS.columns.planPrice} ${formatNumber(bar.planUsdPerMonth, "usd")}`;
      parts.push(
        el(
          "line",
          {
            class: "nm-ref nm-plan",
            x1: cx - width / 2 - 8,
            x2: cx + width / 2 + 8,
            y1: y,
            y2: y,
            stroke: "var(--silt)",
            "stroke-width": 2,
            "stroke-dasharray": "4 3",
          },
          title(`${LABELS.columns.planPrice} for ${bar.month}: ${price}`),
        ),
        text(cx + width / 2 + 12, y + 4, price, { class: "nm-label", fill: "var(--ink-2)" }),
      );
    }
    parts.push(text(cx, baseline + 16, bar.month, { "text-anchor": "middle" }));
  });
  const covered = extent(
    bars.flatMap((b) =>
      b.span.from === null || b.span.to === null ? [] : [b.span.from, b.span.to],
    ),
  );
  const span = `Months ${formatCoverage(covered?.from, covered?.to, tz)}`;
  parts.push(text(left, baseline + 34, span, { class: "nm-span" }));
  return svg("months", options, baseline + MONTHS.bottom, `${label}. ${span}`, parts);
};
