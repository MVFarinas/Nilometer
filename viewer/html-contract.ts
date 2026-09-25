/**
 * @file The contract between the HTML report's parts (step G1.0, D-070): shared types and the
 * names and signatures each part must export. Types only; nothing here runs.
 *
 * Implements README section MVP scope as a picture: the same observed and projected numbers as the text
 * report, from the same views, with every drawn bar, column, and point carrying the raw line IDs
 * of the events behind it (principle 4) and every chart carrying its span (principle 5). Observed
 * charts sit above the seam and projected ones below it (principle 2). See D-070, D-045, D-067,
 * D-068.
 *
 * Who implements what (step G1):
 * - `viewer/html-data.ts` exports `loadHtmlData`, typed {@link LoadHtmlData}.
 * - `viewer/html-charts.ts` exports `renderCoverage`, `renderGauge`, `renderWindowSeries`,
 *   `renderLockouts`, `renderModelBars`, and `renderMonthBars`, each typed {@link RenderChart}.
 * - `viewer/html.ts` exports `renderHtmlReport`, typed {@link RenderHtmlReport}.
 * - `viewer/save.ts` gains an optional `html` argument and `SavedReport.htmlPath` (G1.4).
 *
 * Every timestamp here is ISO-8601 UTC text as the views return it (`YYYY-MM-DDTHH:MM:SS.sssZ`).
 * Conversion to the display zone happens only when drawing, as the text report does.
 */
import type { Db } from "../core/db/database.js";
import type { ObservedReport } from "./queries.js";

/** Raw line IDs (`raw_lines.id`) of the events behind one drawn element, in canonical order. */
export type EventRef = readonly number[];

/** The time span a chart covers, from the data present (principle 5). */
export interface Span {
  /** Earliest event covered; null when the source has no data. */
  readonly from: string | null;
  /** Latest event covered; null when the source has no data. */
  readonly to: string | null;
}

/** How far back one source reaches, from `source_coverage`. */
export interface CoverageRow {
  /** `session_logs` (tokens, models, limit hits) or `status_line` (usage windows). */
  readonly source: "session_logs" | "status_line";
  /** What the source covers. */
  readonly span: Span;
}

/** One usage window instance: a column in the gauge (D-024, D-068). */
export interface GaugeWindow {
  /** `five_hour` or `seven_day`. */
  readonly window: "five_hour" | "seven_day";
  /** The window's reset instant; with `window`, the window's identity. */
  readonly resetAtUtc: string;
  /** True while the window hasn't reset as of the last reading. */
  readonly open: boolean;
  /** Highest observed `used_percentage`; may exceed 100 (D-068); null with no usable reading. */
  readonly peak: number | null;
  /** When the peak was observed (D-045); null with no usable reading. */
  readonly peakAtUtc: string | null;
  /** Last observed `used_percentage` before the reset, a lower bound (D-024); null when none. */
  readonly last: number | null;
  /** When the last reading was observed; null when none. */
  readonly lastAtUtc: string | null;
  /** Readings counted for the window. */
  readonly readings: number;
  /**
   * Limit hits in the window, logged or status line. A hit belongs to the column of its own window
   * kind whose span holds its time: hit time in (reset minus the window's length, reset], the rule
   * D-023 uses to merge hits. Its own reset isn't matched, so a hit whose reset is unknown or a
   * second off still lands in its column. A hit whose window is unknown, or whose window has no
   * counted reading, or with no time, belongs to no column and is counted in
   * {@link InterruptionTotals.hitsInNoColumn}. Where two columns of one kind both hold a hit's time
   * (resets a second apart), the earlier reset takes it, as `obs_limit_hits_events` picks the
   * earliest status line group, so no hit counts twice.
   */
  readonly limitHits: number;
  /** The reading behind `peak`. */
  readonly peakEvents: EventRef;
  /** The reading behind `last`. */
  readonly lastEvents: EventRef;
  /** The limit-hit lines (or status line readings, for status-line-only hits) in the window. */
  readonly hitEvents: EventRef;
}

/** One observed reading in a window's line over time. */
export interface SeriesPoint {
  /** When the reading was observed (D-045). */
  readonly atUtc: string;
  /** `used_percentage` as recorded; may exceed 100 (D-068). */
  readonly used: number;
  /** The reading's raw line ID. */
  readonly event: number;
}

/** A limit hit placed on a window's line over time. */
export interface SeriesHit {
  /** When the hit was logged or first seen at the limit. */
  readonly atUtc: string;
  /** The hit's raw line ID. */
  readonly event: number;
}

/** One window's usage over time, opened by clicking its gauge column (D-070). */
export interface WindowSeries {
  /** Same identity as the {@link GaugeWindow} it belongs to. */
  readonly window: "five_hour" | "seven_day";
  /** Same identity as the {@link GaugeWindow} it belongs to. */
  readonly resetAtUtc: string;
  /** Every counted reading, in observation order. */
  readonly points: readonly SeriesPoint[];
  /** Limit hits inside the window, in time order. */
  readonly hits: readonly SeriesHit[];
}

/** One lockout interval: limit hit to reset, overlapping hits merged (D-023). */
export interface LockoutBar {
  /** First hit of the interval. */
  readonly lockedFromUtc: string;
  /** The reset that ended it. */
  readonly lockedUntilUtc: string;
  /** Elapsed lockout time in seconds, unrounded. */
  readonly seconds: number;
  /** Hits merged into the interval. */
  readonly hits: number;
  /** Reset to the next Claude Code request, in seconds; null when none followed. */
  readonly resetToNextRequestSeconds: number | null;
  /** True when the reset came after the logs end, so no request could follow yet. */
  readonly resetAfterCoverage: boolean;
  /** The hits merged into the interval. */
  readonly events: EventRef;
  /** The first Claude Code request after the reset, behind `resetToNextRequestSeconds`; empty when none. */
  readonly nextRequestEvents: EventRef;
}

/** The interruption counts the text report prints beside the lockouts, so the page states them too. */
export interface InterruptionTotals {
  /** Rate-limit interruptions, logged hits and status-line-only hits merged (D-023). */
  readonly hits: number;
  /** Of those, in 5-hour windows. */
  readonly fiveHourHits: number;
  /** Of those, in weekly windows. */
  readonly sevenDayHits: number;
  /** Of those, with no known window. */
  readonly unknownWindowHits: number;
  /** Of those, from the session logs. */
  readonly loggedHits: number;
  /** Of those, seen only in the status line. */
  readonly statusLineOnlyHits: number;
  /** Elapsed lockout time over all intervals, seconds, unrounded (`obs_lockout_time`). */
  readonly lockoutSeconds: number;
  /** Lockout intervals. */
  readonly lockoutIntervals: number;
  /** Hits with an unknown reset time or hit time, not included in elapsed lockout time. */
  readonly hitsWithUnknownReset: number;
  /** The hits behind `hitsWithUnknownReset`. */
  readonly unknownResetEvents: EventRef;
  /** Hits no gauge column holds: an unknown window, no time, or a window with no counted reading. */
  readonly hitsInNoColumn: number;
  /** The hits behind `hitsInNoColumn`. */
  readonly hitsInNoColumnEvents: EventRef;
  /** Every hit behind `hits`. */
  readonly events: EventRef;
  /** The hits behind `fiveHourHits`, so each split number resolves to its own events (principle 4). */
  readonly fiveHourEvents: EventRef;
  /** The hits behind `sevenDayHits`. */
  readonly sevenDayEvents: EventRef;
  /** The hits behind `unknownWindowHits`. */
  readonly unknownWindowEvents: EventRef;
  /** The hits behind `loggedHits`. */
  readonly loggedEvents: EventRef;
  /** The hits behind `statusLineOnlyHits`. */
  readonly statusLineOnlyEvents: EventRef;
  /** What the counts cover: the session logs' span, as the text report states it. */
  readonly span: Span;
}

/** Readings captured after their window's reset: not counted in any window (D-024). */
export interface AfterResetReadings {
  /** How many, as the text report prints it. */
  readonly count: number;
  /** The readings. */
  readonly events: EventRef;
}

/** One model's observed tokens (per request, D-007). */
export interface ModelBar {
  /** The exact `message.model` string. */
  readonly model: string;
  /** Deduplicated requests. */
  readonly requests: number;
  /** Output tokens, unrounded. */
  readonly outputTokens: number;
  /** The deduplicated requests behind the bar. */
  readonly events: EventRef;
}

/** One month of observed tokens at API list price, a projection (D-027, principle 3). */
export interface MonthBar {
  /** `YYYY-MM` in the display zone. */
  readonly month: string;
  /** Observed tokens at API list price in USD, unrounded; null when nothing was priced. */
  readonly apiListPriceUsd: number | null;
  /** Plan name entered for the month; null when none was entered. */
  readonly planName: string | null;
  /** Plan price entered for the month, USD; null when none was entered. */
  readonly planUsdPerMonth: number | null;
  /** Requests priced. */
  readonly pricedRequests: number;
  /** Requests left unpriced, never counted as $0 (D-005). */
  readonly unpricedRequests: number;
  /** The unpriced requests, grouped into months the same way as the priced ones. */
  readonly unpricedEvents: EventRef;
  /** The month's covered span. */
  readonly span: Span;
  /** The priced requests behind the bar. */
  readonly events: EventRef;
}

/** One price-reading date and the priced requests dated before it (D-020). */
export interface RateReading {
  /** The day the rate was read from Anthropic's pricing page, `YYYY-MM-DD`. */
  readonly verifiedOn: string;
  /** Priced requests dated before that day, priced at the rate read on it. */
  readonly pricedBeforeVerifiedRequests: number;
  /** Those requests, so the count resolves to its events (principle 4). */
  readonly events: EventRef;
}

/** The notes the text report prints under the monthly amounts, carried so the page prints them too. */
export interface PriceNotes {
  /** One entry per reading date that has requests dated before it, oldest first (as the text report prints them). */
  readonly rateReadings: readonly RateReading[];
  /** Requests whose cache writes had no recorded duration, priced at the 5-minute rate: their cost is a lower bound (D-020). */
  readonly lowerBoundRequests: number;
  /** Those requests. */
  readonly lowerBoundEvents: EventRef;
}

/** Where one event was read from, for the panel a click opens (like `nilometer explain`). */
export interface EventDetail {
  /** Index into {@link HtmlReportData.files}, so a path is stored once however many events share it. */
  readonly file: number;
  /** 1-based line number in that file. */
  readonly line: number;
  /** The event's timestamp; null when it didn't parse. */
  readonly atUtc: string | null;
}

/** Everything the HTML report draws, loaded once from the database. */
export interface HtmlReportData {
  /** IANA zone every time is drawn in (D-007). */
  readonly timeZone: string;
  /** When the last ingest finished; null when never. */
  readonly lastIngestAt: string | null;
  /** When the report was produced, as passed in by the caller (tests fix it). */
  readonly generatedAtUtc: string;
  /** One row per source. */
  readonly coverage: readonly CoverageRow[];
  /** Every window with at least one counted reading, oldest reset first (the gauge reads left to right). */
  readonly gauge: readonly GaugeWindow[];
  /** One series per gauge window, same order. */
  readonly series: readonly WindowSeries[];
  /** Lockout intervals in time order. */
  readonly lockouts: readonly LockoutBar[];
  /** The interruption totals and caveats beside the lockouts. */
  readonly interruptions: InterruptionTotals;
  /** Readings that fell after their window's reset, which no column counts. */
  readonly afterReset: AfterResetReadings;
  /** Models by output tokens, largest first. */
  readonly models: readonly ModelBar[];
  /** Months in order, projected (below the seam). */
  readonly months: readonly MonthBar[];
  /** The notes under the monthly amounts, from the same projected views as the text report. */
  readonly priceNotes: PriceNotes;
  /** Source file paths as stored (relative to their log root), indexed by {@link EventDetail.file}. */
  readonly files: readonly string[];
  /** Every event any element refers to, keyed by raw line ID. */
  readonly events: Readonly<Record<number, EventDetail>>;
}

/** What the caller supplies besides the database. */
export interface HtmlMeta {
  /** IANA zone to draw times in. */
  readonly timeZone: string;
  /** When the report is produced; fixed in tests. */
  readonly generatedAt: Date;
}

/**
 * What the text report already read, in the same transaction, which `loadHtmlData` reuses instead
 * of computing the costliest views twice. Same snapshot, so the numbers can't differ (D-070).
 */
export interface LoadedReport {
  /** `loadObserved(db)` as the text report read it: its limit-hit and lockout totals are reused. */
  readonly observed: ObservedReport;
}

/**
 * `loadHtmlData` in `viewer/html-data.ts`: reads everything from the existing views, in SQL. Given
 * what the text report already read from the same open database, it reuses those rows.
 */
export type LoadHtmlData = (db: Db, meta: HtmlMeta, loaded?: LoadedReport) => HtmlReportData;

/** Layout options every chart takes. */
export interface ChartOptions {
  /** IANA zone for axis labels and titles. */
  readonly timeZone: string;
  /** The SVG `viewBox` width; the page scales it to its container. */
  readonly width: number;
}

/**
 * A chart function in `viewer/html-charts.ts`: pure, deterministic SVG text from contract types,
 * with no DOM. Every bar, column, and point drawn from events has `data-events="<ids,
 * space-separated>"` and a `<title>` stating its value and span. Coverage bars draw a span, not
 * events, so they carry only the `<title>`.
 */
export type RenderChart<T> = (input: T, options: ChartOptions) => string;

/** `renderHtmlReport` in `viewer/html.ts`: the whole self-contained page, with no network references. */
export type RenderHtmlReport = (data: HtmlReportData) => string;
