/**
 * @file The HTML report's data layer (step G1.1, D-070): everything the page draws, read once
 * from the same views the text report reads, with the raw line IDs behind every drawn element.
 *
 * Implements README, section MVP scope, as a picture, under the Measurement Principles: observed rows and
 * projected rows are loaded by separate functions from separate views (principle 2), every element
 * carries the raw line IDs of its events (principle 4), and every chart's span comes from the
 * views' own coverage columns (principle 5). All selection, grouping, and arithmetic stays in SQL;
 * this module only maps rows onto the contract's types and collects the events they reference.
 * Numbers come back unrounded, so rounding happens only at display.
 *
 * Which events stand behind each element follows `viewer/explain.ts`, so the page and `nilometer
 * explain` list the same events for the same number. Each view is read in one pass, with each
 * element's events gathered by an ordered `json_group_array`, rather than one query per element:
 * the views behind limit hits and readings are costly to evaluate, and a month of real data has
 * hundreds of window instances. See D-023, D-024, D-045, D-067, D-068, D-070.
 *
 * Limit hits sit in gauge columns by time, not by reset (step G1.7): a hit belongs to the column of
 * its own window kind whose span holds it, the rule D-023 merges hits by, so a hit whose logged
 * reset is unknown or a second off the status line's still lands in its window. Every hit no
 * column holds is counted beside the lockouts, so the columns and that count add up to the text
 * report's total.
 */
import { listAliases } from "../core/plans/repository-aliases.js";
import type { Db } from "../core/db/database.js";
import type {
  AfterResetReadings,
  BurnWindow,
  CoverageRow,
  EventDetail,
  EventRef,
  GaugeWindow,
  HtmlMeta,
  LoadedReport,
  PriceNotes,
  HtmlReportData,
  InterruptionTotals,
  LoadHtmlData,
  LockoutBar,
  ModelBar,
  MonthBar,
  PlanPeriodRef,
  PlanPeriodTotals,
  RepoBar,
  SeriesHit,
  SeriesPoint,
  WeeklyCrossing,
  WindowSeries,
} from "./html-contract.js";
import {
  type CrossingRow,
  type LimitHits,
  type LockoutTime,
  type ObservedReport,
  type PlanPeriodRow,
  lastIngestAt,
} from "./queries.js";

/**
 * The canonical raw line order (file, then first run, then line) from `001_ingestion.sql`, for a
 * `raw_lines` row aliased `l`. Every {@link EventRef} is in this order, as the contract promises.
 */
const CANONICAL = "l.source_file_id, l.first_run_id, l.line_number";

/**
 * Two CTEs, for the head of a `WITH`: `columns`, the gauge's columns, and `placed`, every row of
 * `obs_limit_hits_events` with the reset of the column that holds it (`column_reset_at_utc`, null
 * when none does). Shared text, so the columns' hits and the count of hits in no column come from
 * one rule and always add up to `obs_limit_hits.hits`.
 *
 * The rule is the contract's (GaugeWindow.limitHits): same window kind, and hit time in
 * (reset minus the window's length, reset], compared in epoch seconds as `obs_limit_hits_events`
 * compares them when it merges hits (D-023). The hit's own `reset_at_utc` plays no part.
 */
const PLACED_HITS = `columns AS MATERIALIZED (
         -- The gauge's columns: every window instance with a counted reading (D-024), the rows
         -- obs_window_headroom has with readings > 0. Read from window_readings, whose counted rows
         -- window_instances groups into those instances, because the headroom view's other columns
         -- cost seconds on a month of real data and nothing here needs them.
         SELECT r.window, r.reset_at_utc, r.resets_at AS reset_s,
           CASE r.window WHEN 'five_hour' THEN 5 * 3600 ELSE 7 * 86400 END AS window_seconds
         FROM window_readings r
         WHERE r.after_reset = 0
         GROUP BY r.window, r.resets_at
       ),
       placed AS MATERIALIZED (
         -- Materialized because the events view is costly and several aggregates read this.
         SELECT e.raw_line_id, e.window, e.source, e.hit_at_utc, e.reset_at_utc,
           -- An unknown window or hit time compares as NULL, so such a hit is in no column. Where
           -- jittered resets make two same-kind spans overlap, the earliest reset takes the hit, as
           -- obs_limit_hits_events picks the earliest status line group, so no hit counts twice.
           (SELECT c.reset_at_utc FROM columns c
             WHERE c.window = e.window
               AND unixepoch(e.hit_at_utc, 'subsec') > c.reset_s - c.window_seconds
               AND unixepoch(e.hit_at_utc, 'subsec') <= c.reset_s
             ORDER BY c.reset_s
             LIMIT 1) AS column_reset_at_utc
         FROM obs_limit_hits_events e
       )`;

/** One `source_coverage` row. */
interface CoverageSqlRow {
  /** Which source. */
  readonly source: CoverageRow["source"];
  /** Earliest event, or null with no data. */
  readonly covers_from: string | null;
  /** Latest event, or null with no data. */
  readonly covers_to: string | null;
}

/** One window instance: `obs_window_headroom` and `obs_window_peak`, with its readings and hits. */
interface WindowSqlRow {
  /** `five_hour` or `seven_day`; `window_readings` admits no other window (D-024). */
  readonly window: GaugeWindow["window"];
  /** The instance's reset, ISO-8601 UTC. */
  readonly reset_at_utc: string;
  /** 1 while the window hasn't reset as of the last reading. */
  readonly window_open: number | null;
  /** Highest counted reading. */
  readonly peak_used_percentage: number | null;
  /** When that reading was observed (D-045). */
  readonly peak_reading_at_utc: string | null;
  /** The reading's raw line. */
  readonly peak_reading_raw_line_id: number | null;
  /** Last counted reading before the reset. */
  readonly last_used_percentage: number | null;
  /** When it was observed (D-045). */
  readonly last_reading_at_utc: string | null;
  /** Its raw line. */
  readonly last_reading_raw_line_id: number | null;
  /** Readings counted for the window. */
  readonly readings: number;
  /** Limit hits the window's span holds ({@link PLACED_HITS}). */
  readonly limit_hits: number;
  /** JSON array of the hits' raw line IDs, canonical order. */
  readonly hit_ids: string;
  /** JSON array of `[hit_at_utc, raw_line_id]` for the same hits, in time order. */
  readonly series_hits: string;
  /** JSON array of `[observed_at_utc, used_percentage, raw_line_id]`, in observation order. */
  readonly points: string;
}

/** One `obs_lockout_intervals` row with its hits. */
interface LockoutSqlRow {
  /** The interval's number, shared with obs_lockout_by_plan_events. */
  readonly interval_number: number;
  /** First hit. */
  readonly locked_from_utc: string;
  /** The reset that ended it. */
  readonly locked_until_utc: string;
  /** Hits merged into it. */
  readonly hits: number;
  /** Its logged hits, each a refused request (D-090). */
  readonly refused_requests: number;
  /** Distinct sessions with a hit in it (D-090). */
  readonly sessions: number;
  /** Hit to reset, seconds. */
  readonly lockout_seconds: number;
  /** Reset to the next request, seconds; null when none followed. */
  readonly reset_to_next_request_seconds: number | null;
  /** 1 when the reset came after the session logs end; null when there are no session logs. */
  readonly reset_after_coverage: number | null;
  /** JSON array of the merged hits' raw line IDs, canonical order. */
  readonly hit_ids: string;
  /** The request behind `next_request_at_utc`; null when none followed. */
  readonly next_request_raw_line_id: number | null;
  /** Sessions Claude Code resumed by itself after the reset (D-077). */
  readonly auto_continuations: number;
  /** Seconds from the reset to the first of those; null when none. */
  readonly first_auto_continuation_seconds: number | null;
  /** JSON array of the auto-continuation lines, canonical order. */
  readonly auto_continuation_ids: string;
}

/** The hits behind the interruption counts, one JSON list per count ({@link PLACED_HITS}). */
interface InterruptionListsRow {
  /** Hits no gauge column holds. */
  readonly hits_in_no_column: number;
  /** JSON array of every hit's raw line ID, canonical order. */
  readonly hit_ids: string;
  /** JSON array of the hits behind `hits_with_unknown_reset`. */
  readonly unknown_reset_ids: string;
  /** JSON array of the hits behind `hits_in_no_column`. */
  readonly no_column_ids: string;
  /** JSON array of the hits behind `five_hour_hits`. */
  readonly five_hour_ids: string;
  /** JSON array of the hits behind `seven_day_hits`. */
  readonly seven_day_ids: string;
  /** JSON array of the hits behind `unknown_window_hits`. */
  readonly unknown_window_ids: string;
  /** JSON array of the hits behind `logged_hits`. */
  readonly logged_ids: string;
  /** JSON array of the hits behind `status_line_only_hits`. */
  readonly status_line_only_ids: string;
}

/** Readings captured after their window's reset. */
interface AfterResetSqlRow {
  /** How many. */
  readonly count: number;
  /** JSON array of their raw line IDs, canonical order. */
  readonly ids: string;
}

/** One `obs_usage_by_model` row with its requests. */
interface ModelSqlRow {
  /** `message.model` as written. */
  readonly model: string;
  /** Deduplicated requests. */
  readonly requests: number;
  /** Output tokens. */
  readonly output_tokens: number;
  /** JSON array of the requests' raw line IDs, canonical order. */
  readonly request_ids: string;
}

/** One `obs_usage_by_repo` row with its requests. */
interface RepoSqlRow {
  /** Repository root or working directory; null with no `cwd`. */
  readonly repository: string | null;
  /** How the working directory resolved (`request_repositories.repo_kind`). */
  readonly repo_kind: string;
  /** Deduplicated requests. */
  readonly requests: number;
  /** Output tokens. */
  readonly output_tokens: number;
  /** JSON array of the requests' raw line IDs, canonical order. */
  readonly request_ids: string;
}

/** One open window's `proj_burn_rate` row with the reading it starts from. */
interface BurnSqlRow {
  /** `five_hour` or `seven_day`. */
  readonly window: BurnWindow["window"];
  /** The window's reset. */
  readonly reset_at_utc: string;
  /** Reset minus the window's length. */
  readonly window_start_utc: string;
  /** Last counted reading. */
  readonly last_used_percentage: number | null;
  /** When it was observed. */
  readonly last_reading_at_utc: string | null;
  /** 1 when that reading was at or above 100. */
  readonly limit_reached: number | null;
  /** Percentage points per hour. */
  readonly projected_percentage_points_per_hour: number | null;
  /** When the projection reaches 100. */
  readonly projected_limit_at_utc: string | null;
  /** 1 when that comes before the reset. */
  readonly projected_limit_before_reset: number | null;
  /** The status line's span, from `source_coverage`. */
  readonly covers_from: string | null;
  /** The status line's span. */
  readonly covers_to: string | null;
  /** The last reading's raw line. */
  readonly last_reading_raw_line_id: number | null;
}

/** One `proj_api_list_price` row with its priced requests. */
interface MonthSqlRow {
  /** `YYYY-MM`, grouped by the view in the process's local zone (D-007). */
  readonly month: string;
  /** USD, or null when nothing was priced. */
  readonly api_list_price_usd: number | null;
  /** Plan name entered for the month. */
  readonly plan_name: string | null;
  /** Plan price entered for the month, USD. */
  readonly plan_usd_per_month: number | null;
  /** Requests priced. */
  readonly priced_requests: number;
  /** Requests left unpriced. */
  readonly unpriced_requests: number;
  /** Earliest request in the month. */
  readonly covers_from: string;
  /** Latest request in the month. */
  readonly covers_to: string;
  /** JSON array of the priced requests' raw line IDs, canonical order. */
  readonly request_ids: string;
  /** JSON array of the unpriced requests' raw line IDs, canonical order. */
  readonly unpriced_ids: string;
}

/** Where one raw line came from. */
interface EventSqlRow {
  /** `raw_lines.id`. */
  readonly id: number;
  /** `source_files.relative_path`, as stored. */
  readonly relative_path: string;
  /** 1-based line number. */
  readonly line_number: number;
  /** The event's time, as {@link loadEvents} chooses it. */
  readonly at_utc: string | null;
}

/**
 * Parses a JSON array of raw line IDs built by `json_group_array`.
 * @param json - The array's text; `[]` when the group is empty.
 * @returns The IDs, in the array's order.
 */
function parseIds(json: string): EventRef {
  // Integers below 2^53 round-trip through JSON exactly, so no ID changes on the way.
  return JSON.parse(json) as number[];
}

/**
 * Wraps a single optional raw line ID as an {@link EventRef}.
 * @param id - A raw line ID, or null when the value has no event behind it.
 * @returns A one-element list, or an empty one for null.
 */
function single(id: number | null): EventRef {
  return id === null ? [] : [id];
}

/**
 * Loads how far back each source reaches.
 * @param db - Open, migrated database.
 * @returns One row per source, `session_logs` then `status_line`; spans are null for a source with no data.
 */
function loadCoverage(db: Db): CoverageRow[] {
  return (
    db
      .prepare("SELECT source, covers_from, covers_to FROM source_coverage ORDER BY source")
      .all() as unknown as CoverageSqlRow[]
  ).map((row) => ({ source: row.source, span: { from: row.covers_from, to: row.covers_to } }));
}

/**
 * Loads every window instance with at least one counted reading, with its readings and limit hits.
 * @param db - Open, migrated database.
 * @param at - The page's time in Unix seconds: a window is open only until its reset, as of it (D-083).
 * @returns One row per window instance, oldest reset first; empty with no counted reading.
 * @see D-024 for what a window instance is and which readings count, D-045 for observed times,
 * {@link PLACED_HITS} for which hits a window holds.
 */
function loadWindows(db: Db, at: number): WindowSqlRow[] {
  return db
    .prepare(
      `WITH ${PLACED_HITS},
       hits AS (
         -- Each column's hits by the shared rule. A placed hit always has a time, so every hit in
         -- the gauge also sits on its window's line over time.
         SELECT x.window, x.column_reset_at_utc AS reset_at_utc,
           COUNT(*) AS limit_hits,
           json_group_array(x.raw_line_id ORDER BY ${CANONICAL}) AS hit_ids,
           json_group_array(json_array(x.hit_at_utc, x.raw_line_id) ORDER BY x.hit_at_utc, x.raw_line_id)
             AS series_hits
         FROM placed x
         JOIN raw_lines l ON l.id = x.raw_line_id
         WHERE x.column_reset_at_utc IS NOT NULL
         GROUP BY x.window, x.column_reset_at_utc
       ),
       points AS (
         -- The readings window_instances counts (after_reset = 0), in the order the reading-pair
         -- view walks them, so a series has exactly the window's readings count of points (D-024).
         SELECT r.window, r.reset_at_utc,
           json_group_array(json_array(r.observed_at_utc, r.used_percentage, r.raw_line_id, r.stale)
             ORDER BY r.observed_at_s, r.raw_line_id) AS points
         FROM window_readings r
         WHERE r.after_reset = 0
         GROUP BY r.window, r.resets_at
       )
       -- Open only until its reset, as of the page's time (D-083), as the text report reads it.
       SELECT h.window, h.reset_at_utc,
         (h.window_open = 1 AND unixepoch(h.reset_at_utc, 'subsec') > :at) AS window_open,
         p.peak_used_percentage, p.peak_reading_at_utc, p.peak_reading_raw_line_id,
         h.last_used_percentage, h.last_reading_at_utc, h.last_reading_raw_line_id,
         h.readings,
         COALESCE(x.limit_hits, 0) AS limit_hits,
         COALESCE(x.hit_ids, '[]') AS hit_ids,
         COALESCE(x.series_hits, '[]') AS series_hits,
         COALESCE(r.points, '[]') AS points
       FROM obs_window_headroom h
       -- The same join loadObserved uses, so every number here equals the text report's.
       JOIN obs_window_peak p ON p.window = h.window AND p.reset_at_utc = h.reset_at_utc
       LEFT JOIN hits x ON x.window = h.window AND x.reset_at_utc = h.reset_at_utc
       LEFT JOIN points r ON r.window = h.window AND r.reset_at_utc = h.reset_at_utc
       -- A window whose every reading came after its reset has nothing to draw (D-024).
       WHERE h.readings > 0
       ORDER BY h.reset_at_utc, h.window`,
    )
    .all({ at }) as unknown as WindowSqlRow[];
}

/**
 * Maps a window instance onto its gauge column.
 * @param row - From {@link loadWindows}.
 * @returns The column; `peak` may exceed 100 (D-068).
 */
function toGauge(row: WindowSqlRow): GaugeWindow {
  return {
    window: row.window,
    resetAtUtc: row.reset_at_utc,
    // NULL can't occur with a counted reading, but it would mean "not known open", so it reads false.
    open: row.window_open === 1,
    peak: row.peak_used_percentage,
    peakAtUtc: row.peak_reading_at_utc,
    last: row.last_used_percentage,
    lastAtUtc: row.last_reading_at_utc,
    readings: row.readings,
    limitHits: row.limit_hits,
    peakEvents: single(row.peak_reading_raw_line_id),
    lastEvents: single(row.last_reading_raw_line_id),
    hitEvents: parseIds(row.hit_ids),
  };
}

/**
 * Maps a window instance onto its usage-over-time series.
 * @param row - From {@link loadWindows}.
 * @returns The series: one point per counted reading, dated when observed (D-045), and its hits.
 */
function toSeries(row: WindowSqlRow): WindowSeries {
  // Real values round-trip through SQLite's JSON exactly (17 significant digits), so each point
  // keeps the recorded used_percentage unrounded, including values above 100 (D-068).
  const points = (JSON.parse(row.points) as [string, number, number, number][]).map(
    ([atUtc, used, event, stale]): SeriesPoint => ({ atUtc, used, event, stale: stale === 1 }),
  );
  const hits = (JSON.parse(row.series_hits) as [string, number][]).map(
    ([atUtc, event]): SeriesHit => ({ atUtc, event }),
  );
  return { window: row.window, resetAtUtc: row.reset_at_utc, points, hits };
}

/** One lockout interval's plan period, from `obs_lockout_by_plan_events`. */
interface LockoutPeriodSqlRow {
  /** The interval. */
  readonly interval_number: number;
  /** `plan` or `none`: an interval always has a time. */
  readonly period_kind: "plan" | "none";
  /** The period's first month. */
  readonly from_month: string | null;
  /** The month it stops applying. */
  readonly until_month: string | null;
  /** The plan's name. */
  readonly plan_name: string | null;
  /** The plan's last month; null while it applies. */
  readonly to_month: string | null;
}

/**
 * Maps a plan period's columns onto the contract's reference, with its last month as the view
 * computes it for the per-plan table (the month before `until_month`).
 * @param row - The period's columns.
 * @returns The reference.
 */
function periodRef(
  row: Pick<PlanPeriodRow, "period_kind" | "from_month" | "until_month" | "plan_name"> & {
    readonly to_month?: string | null;
  },
): PlanPeriodRef {
  return {
    kind: row.period_kind,
    fromMonth: row.from_month,
    toMonth: row.to_month ?? null,
    untilMonth: row.until_month,
    planName: row.plan_name,
  };
}

/**
 * Loads the lockout intervals, each with the hits merged into it.
 * @param db - Open, migrated database.
 * @param withPeriods - Whether to tag each interval with its plan period (D-075): only once a plan
 *   has been entered, as the text report only then prints the split.
 * @returns Intervals in time order; empty with no hit whose reset is known.
 * @see D-023 for the interval (hit to reset, overlaps merged) and reset to next request.
 */
function loadLockouts(db: Db, withPeriods = false): LockoutBar[] {
  const rows = db
    .prepare(
      `WITH members AS (
         SELECT h.interval_number, json_group_array(h.raw_line_id ORDER BY ${CANONICAL}) AS hit_ids
         FROM obs_lockout_interval_hits h
         JOIN raw_lines l ON l.id = h.raw_line_id
         GROUP BY h.interval_number
       )
       SELECT i.interval_number, i.locked_from_utc, i.locked_until_utc, i.hits, i.refused_requests,
         i.sessions, i.lockout_seconds,
         i.auto_continuations, i.first_auto_continuation_seconds,
         -- The markers obs_lockout_intervals counts, so the list re-adds to auto_continuations.
         COALESCE((SELECT json_group_array(a.raw_line_id ORDER BY ${CANONICAL})
                   FROM obs_auto_continuation_events a
                   JOIN raw_lines l ON l.id = a.raw_line_id
                   WHERE a.interval_number = i.interval_number), '[]') AS auto_continuation_ids,
         i.reset_to_next_request_seconds, i.reset_after_coverage,
         COALESCE(m.hit_ids, '[]') AS hit_ids,
         -- The request behind the view's next_request_at_utc: matching that value, rather than
         -- restating its rule, keeps the event tied to the number shown. Requests sharing that
         -- instant are equally behind it, so the first in canonical order stands for them.
         (SELECT d.raw_line_id FROM requests_dedup d
            JOIN raw_lines l ON l.id = d.raw_line_id
            WHERE d.timestamp_utc = i.next_request_at_utc
            ORDER BY ${CANONICAL}
            LIMIT 1) AS next_request_raw_line_id
       FROM obs_lockout_intervals i
       LEFT JOIN members m ON m.interval_number = i.interval_number
       -- Intervals are numbered in start order, as loadObserved reads them.
       ORDER BY i.interval_number`,
    )
    .all() as unknown as LockoutSqlRow[];
  const periods = new Map(
    (withPeriods
      ? (db
          .prepare(
            // to_month as obs_interruptions_by_plan computes it, so a lane names the same months.
            `SELECT interval_number, period_kind, from_month, until_month, plan_name,
               CASE WHEN until_month IS NOT NULL
                 THEN strftime('%Y-%m', until_month || '-01', '-1 month') END AS to_month
             FROM obs_lockout_by_plan_events`,
          )
          .all() as unknown as LockoutPeriodSqlRow[])
      : []
    ).map((row) => [row.interval_number, periodRef(row)]),
  );
  return rows.map((row) => ({
    ...(periods.has(row.interval_number)
      ? { period: periods.get(row.interval_number) as PlanPeriodRef }
      : {}),
    lockedFromUtc: row.locked_from_utc,
    lockedUntilUtc: row.locked_until_utc,
    seconds: row.lockout_seconds,
    hits: row.hits,
    refusedRequests: row.refused_requests,
    sessions: row.sessions,
    resetToNextRequestSeconds: row.reset_to_next_request_seconds,
    // NULL means there are no session logs to compare with; nothing says the reset came after
    // them, so it reads false and the null reset-to-next-request stands on its own.
    resetAfterCoverage: row.reset_after_coverage === 1,
    events: parseIds(row.hit_ids),
    nextRequestEvents: single(row.next_request_raw_line_id),
    autoContinuations: row.auto_continuations,
    firstAutoContinuationSeconds: row.first_auto_continuation_seconds,
    autoContinuationEvents: parseIds(row.auto_continuation_ids),
  }));
}

/**
 * Loads the interruption counts the text report prints beside the lockouts, with their hits.
 * @param db - Open, migrated database.
 * @param totals - The text report's `obs_limit_hits` and `obs_lockout_time` rows, when the caller
 *   already read them in the same transaction; read here otherwise. Both views are among the
 *   costliest on real data, so reading them once matters.
 * @returns The totals, and the hits behind each count, including those no gauge column holds.
 * @see D-023 for merging and unknown resets, {@link PLACED_HITS} for which hits a column holds.
 */
function loadInterruptions(
  db: Db,
  totals?: Pick<ObservedReport, "limitHits" | "lockout" | "interruptionsByPlan">,
): InterruptionTotals {
  const { limitHits, lockout, interruptionsByPlan } = totals ?? {
    limitHits: db.prepare("SELECT * FROM obs_limit_hits").get() as unknown as LimitHits,
    lockout: db.prepare("SELECT * FROM obs_lockout_time").get() as unknown as LockoutTime,
    interruptionsByPlan: db
      .prepare(
        `SELECT * FROM obs_interruptions_by_plan
         ORDER BY CASE period_kind WHEN 'none' THEN 0 WHEN 'plan' THEN 1 ELSE 2 END, from_month`,
      )
      .all() as unknown as PlanPeriodRow[],
  };
  const row = db
    .prepare(
      `WITH ${PLACED_HITS},
       lists AS (
         -- placed is obs_limit_hits_events row for row, so these lists are the view's hits.
         SELECT
           json_group_array(p.raw_line_id ORDER BY ${CANONICAL}) AS hit_ids,
           -- The same test obs_lockout_time counts hits_with_unknown_reset by.
           json_group_array(p.raw_line_id ORDER BY ${CANONICAL})
             FILTER (WHERE p.reset_at_utc IS NULL OR p.hit_at_utc IS NULL) AS unknown_reset_ids,
           COUNT(*) FILTER (WHERE p.column_reset_at_utc IS NULL) AS hits_in_no_column,
           json_group_array(p.raw_line_id ORDER BY ${CANONICAL})
             FILTER (WHERE p.column_reset_at_utc IS NULL) AS no_column_ids,
           -- The same FILTERs obs_limit_hits counts its splits by, so each split number and its
           -- list come from one rule (principle 4).
           json_group_array(p.raw_line_id ORDER BY ${CANONICAL})
             FILTER (WHERE p.window = 'five_hour') AS five_hour_ids,
           json_group_array(p.raw_line_id ORDER BY ${CANONICAL})
             FILTER (WHERE p.window = 'seven_day') AS seven_day_ids,
           json_group_array(p.raw_line_id ORDER BY ${CANONICAL})
             FILTER (WHERE p.window IS NULL) AS unknown_window_ids,
           json_group_array(p.raw_line_id ORDER BY ${CANONICAL})
             FILTER (WHERE p.source = 'session_log') AS logged_ids,
           json_group_array(p.raw_line_id ORDER BY ${CANONICAL})
             FILTER (WHERE p.source = 'status_line') AS status_line_only_ids
         FROM placed p
         JOIN raw_lines l ON l.id = p.raw_line_id
       )
       -- Ungrouped, lists always has one row, and json_group_array gives [] over no rows.
       SELECT * FROM lists`,
    )
    .get() as unknown as InterruptionListsRow;
  return {
    hits: limitHits.hits,
    fiveHourHits: limitHits.five_hour_hits,
    sevenDayHits: limitHits.seven_day_hits,
    unknownWindowHits: limitHits.unknown_window_hits,
    loggedHits: limitHits.logged_hits,
    statusLineOnlyHits: limitHits.status_line_only_hits,
    lockoutSeconds: lockout.lockout_seconds,
    lockoutIntervals: lockout.intervals,
    hitsWithUnknownReset: lockout.hits_with_unknown_reset,
    unknownResetEvents: parseIds(row.unknown_reset_ids),
    hitsInNoColumn: row.hits_in_no_column,
    hitsInNoColumnEvents: parseIds(row.no_column_ids),
    events: parseIds(row.hit_ids),
    fiveHourEvents: parseIds(row.five_hour_ids),
    sevenDayEvents: parseIds(row.seven_day_ids),
    unknownWindowEvents: parseIds(row.unknown_window_ids),
    loggedEvents: parseIds(row.logged_ids),
    statusLineOnlyEvents: parseIds(row.status_line_only_ids),
    // obs_limit_hits carries the session logs' span from source_coverage, the span the text
    // report prints beside these counts (principle 5).
    span: { from: limitHits.covers_from, to: limitHits.covers_to },
    byPlan: loadByPlan(db, interruptionsByPlan),
  };
}

/**
 * Loads the per-plan interruptions (D-075), with the events behind each count, only once a plan
 * has been entered: the text report prints the split only then.
 * @param db - Open, migrated database.
 * @param rows - `obs_interruptions_by_plan`, as the text report read it.
 * @returns One entry per row, in the rows' order; empty with no plan entered.
 */
function loadByPlan(db: Db, rows: readonly PlanPeriodRow[]): PlanPeriodTotals[] {
  if (!rows.some((row) => row.period_kind === "plan")) {
    return [];
  }
  // Grouped by the same two columns obs_interruptions_by_plan counts by, so each list re-adds.
  const hitLists = db
    .prepare(
      `SELECT b.period_kind, b.from_month, json_group_array(b.raw_line_id ORDER BY ${CANONICAL}) AS ids
       FROM obs_limit_hits_by_plan_events b
       JOIN raw_lines l ON l.id = b.raw_line_id
       GROUP BY b.period_kind, b.from_month`,
    )
    .all() as { period_kind: string; from_month: string | null; ids: string }[];
  const lockoutLists = db
    .prepare(
      `SELECT i.period_kind, i.from_month, json_group_array(h.raw_line_id ORDER BY ${CANONICAL}) AS ids
       FROM obs_lockout_by_plan_events i
       JOIN obs_lockout_interval_hits h ON h.interval_number = i.interval_number
       JOIN raw_lines l ON l.id = h.raw_line_id
       GROUP BY i.period_kind, i.from_month`,
    )
    .all() as { period_kind: string; from_month: string | null; ids: string }[];
  /**
   * Finds a period's list.
   * @param lists - Lists keyed by kind and first month.
   * @param row - The period.
   * @returns Its IDs; empty when it has none.
   */
  const listOf = (
    lists: readonly { period_kind: string; from_month: string | null; ids: string }[],
    row: PlanPeriodRow,
  ): EventRef =>
    parseIds(
      lists.find((x) => x.period_kind === row.period_kind && x.from_month === row.from_month)
        ?.ids ?? "[]",
    );
  return rows.map((row) => ({
    period: periodRef(row),
    hits: row.hits,
    lockouts: row.lockouts,
    lockoutSeconds: row.lockout_seconds,
    span: { from: row.covers_from, to: row.covers_to },
    hitEvents: listOf(hitLists, row),
    lockoutEvents: listOf(lockoutLists, row),
  }));
}

/**
 * Loads the weekly windows' first readings at or above 75% and 90% (D-087), reusing the text
 * report's rows when it has read them from the same snapshot.
 * @param db - Open, migrated database.
 * @param observed - What the text report read, if it did.
 * @returns One entry per window and level, newest window first.
 */
function loadCrossings(db: Db, observed?: ObservedReport): WeeklyCrossing[] {
  // The same view and order as loadObserved, so the page and the text list the same rows.
  const rows =
    observed?.weeklyCrossings ??
    (db
      .prepare("SELECT * FROM obs_weekly_crossings ORDER BY reset_at_utc DESC, threshold")
      .all() as unknown as CrossingRow[]);
  return rows.map((r) => ({
    resetAtUtc: r.reset_at_utc,
    threshold: r.threshold,
    firstAtUtc: r.first_at_utc,
    usedPercentage: r.used_percentage,
    secondsBeforeReset: r.seconds_before_reset,
    events: [r.raw_line_id],
  }));
}

/**
 * Loads the readings captured after their window's reset, which no gauge column counts.
 * @param db - Open, migrated database.
 * @returns How many, and which.
 * @see D-024 for why a reading after its reset belongs to no window.
 */
function loadAfterReset(db: Db): AfterResetReadings {
  const row = db
    .prepare(
      // window_instances counts readings_after_reset as these rows grouped by window instance, so
      // counting them ungrouped gives the sum the text report prints, without the headroom view.
      `SELECT COUNT(*) AS count,
         json_group_array(r.raw_line_id ORDER BY ${CANONICAL}) AS ids
       FROM window_readings r
       JOIN raw_lines l ON l.id = r.raw_line_id
       WHERE r.after_reset = 1`,
    )
    .get() as unknown as AfterResetSqlRow;
  return { count: row.count, events: parseIds(row.ids) };
}

/**
 * Loads output tokens by model, each with its deduplicated requests.
 * @param db - Open, migrated database.
 * @returns Models by output tokens, largest first, ties by name as the text report orders them.
 * @see D-001 for deduplication, D-007 for per-request attribution.
 */
function loadModels(db: Db): ModelBar[] {
  const rows = db
    .prepare(
      `WITH members AS (
         -- obs_usage_events is the set obs_usage_by_model counts, so the IDs re-add to its numbers.
         SELECT e.model, json_group_array(e.raw_line_id ORDER BY ${CANONICAL}) AS request_ids
         FROM obs_usage_events e
         JOIN raw_lines l ON l.id = e.raw_line_id
         GROUP BY e.model
       )
       SELECT m.model, m.requests, m.output_tokens, COALESCE(x.request_ids, '[]') AS request_ids
       FROM obs_usage_by_model m
       LEFT JOIN members x ON x.model = m.model
       ORDER BY m.output_tokens DESC, m.model`,
    )
    .all() as unknown as ModelSqlRow[];
  return rows.map((row) => ({
    model: row.model,
    requests: row.requests,
    outputTokens: row.output_tokens,
    events: parseIds(row.request_ids),
  }));
}

/**
 * Loads output tokens by repository, each with its deduplicated requests (step G2.1).
 * @param db - Open, migrated database.
 * @returns Repositories by output tokens, largest first, ties by name, as the text report orders them.
 * @see D-010 and D-028 for attribution, D-001 for deduplication.
 */
function loadRepos(db: Db): RepoBar[] {
  const rows = db
    .prepare(
      `WITH members AS (
         -- obs_usage_events is the set obs_usage_by_repo counts, grouped the same way, so each
         -- list's IDs re-add to its row. explain by-repo matches on the same two columns.
         SELECT e.repository, e.repo_kind,
           json_group_array(e.raw_line_id ORDER BY ${CANONICAL}) AS request_ids
         FROM obs_usage_events e
         JOIN raw_lines l ON l.id = e.raw_line_id
         GROUP BY e.repository, e.repo_kind
       )
       SELECT r.repository, r.repo_kind, r.requests, r.output_tokens,
         COALESCE(x.request_ids, '[]') AS request_ids
       FROM obs_usage_by_repo r
       -- IS, not =: a request with no cwd has a NULL repository, and its group must still match.
       LEFT JOIN members x ON x.repository IS r.repository AND x.repo_kind = r.repo_kind
       ORDER BY r.output_tokens DESC, r.repository`,
    )
    .all() as unknown as RepoSqlRow[];
  return rows.map((row) => ({
    repository: row.repository,
    kind: row.repo_kind,
    requests: row.requests,
    outputTokens: row.output_tokens,
    events: parseIds(row.request_ids),
  }));
}

/**
 * Loads the burn rate of every open window, a projection, each with the reading it starts from
 * (step G2.1). Read by its own function from its own view, never mixed into observed rows
 * (principle 2).
 * @param db - Open, migrated database.
 * @param at - The page's time in Unix seconds: only windows still open at it are projected (D-083).
 * @returns Open windows in the text report's order: latest reset first, then by window.
 * @see D-026 for the premise, D-024 for what an open window is.
 */
function loadBurn(db: Db, at: number): BurnWindow[] {
  const rows = db
    .prepare(
      // The same join explain burn-rate uses for the reading behind each projection, and the same
      // filter renderProjected prints by (window_open = 1), so the page and the text report agree.
      `SELECT b.window, b.reset_at_utc, b.window_start_utc, b.last_used_percentage,
         b.last_reading_at_utc, b.limit_reached, b.projected_percentage_points_per_hour,
         b.projected_limit_at_utc, b.projected_limit_before_reset, b.covers_from, b.covers_to,
         h.last_reading_raw_line_id
       FROM proj_burn_rate b
       JOIN obs_window_headroom h ON h.window = b.window AND h.reset_at_utc = b.reset_at_utc
       -- Open at the page's time too: a window that has reset has nothing to project (D-083).
       WHERE b.window_open = 1 AND unixepoch(b.reset_at_utc, 'subsec') > :at
       ORDER BY b.reset_at_utc DESC, b.window`,
    )
    .all({ at }) as unknown as BurnSqlRow[];
  return rows.map((row) => ({
    window: row.window,
    resetAtUtc: row.reset_at_utc,
    windowStartUtc: row.window_start_utc,
    last: row.last_used_percentage,
    lastAtUtc: row.last_reading_at_utc,
    // NULL means no reading to judge by; nothing says the limit was reached, so it reads false.
    limitReached: row.limit_reached === 1,
    ratePerHour: row.projected_percentage_points_per_hour,
    projectedLimitAtUtc: row.projected_limit_at_utc,
    limitBeforeReset: row.projected_limit_before_reset === 1,
    span: { from: row.covers_from, to: row.covers_to },
    events: single(row.last_reading_raw_line_id),
  }));
}

/**
 * Loads observed tokens at API list price by month, a projection, each with its priced requests.
 * @param db - Open, migrated database.
 * @returns Months in order; empty with no request that has a timestamp.
 * @see D-005 (unpriced is never $0), D-007 (local months), D-027 (repricing is a labeled projection).
 */
function loadMonths(db: Db): MonthBar[] {
  const rows = db
    .prepare(
      `WITH members AS (
         -- The same month expression and filters as proj_api_list_price, split by the same
         -- unpriced_reason test as its counts, so each month's lists have exactly priced_requests
         -- and unpriced_requests IDs, and the priced list re-adds to its price.
         SELECT strftime('%Y-%m', e.timestamp_utc, 'localtime') AS month,
           json_group_array(e.raw_line_id ORDER BY ${CANONICAL})
             FILTER (WHERE e.unpriced_reason IS NULL) AS request_ids,
           json_group_array(e.raw_line_id ORDER BY ${CANONICAL})
             FILTER (WHERE e.unpriced_reason IS NOT NULL) AS unpriced_ids
         FROM request_costs e
         JOIN raw_lines l ON l.id = e.raw_line_id
         WHERE e.timestamp_utc IS NOT NULL
         GROUP BY month
       )
       SELECT p.month, p.api_list_price_usd, p.plan_name, p.plan_usd_per_month,
         p.priced_requests, p.unpriced_requests, p.covers_from, p.covers_to,
         COALESCE(x.request_ids, '[]') AS request_ids,
         COALESCE(x.unpriced_ids, '[]') AS unpriced_ids
       FROM proj_api_list_price p
       -- Both group the same rows by the same expression, so every month finds its lists; the
       -- outer join and COALESCE only keep a month's row should that ever stop holding.
       LEFT JOIN members x ON x.month = p.month
       ORDER BY p.month`,
    )
    .all() as unknown as MonthSqlRow[];
  return rows.map((row) => ({
    month: row.month,
    apiListPriceUsd: row.api_list_price_usd,
    planName: row.plan_name,
    planUsdPerMonth: row.plan_usd_per_month,
    pricedRequests: row.priced_requests,
    unpricedRequests: row.unpriced_requests,
    unpricedEvents: parseIds(row.unpriced_ids),
    span: { from: row.covers_from, to: row.covers_to },
    events: parseIds(row.request_ids),
  }));
}

/** Where every referenced event came from: the page's lookup table for the click panel. */
interface EventTable {
  /** Distinct source file paths, in canonical order of their first event. */
  readonly files: string[];
  /** Each event by raw line ID. */
  readonly events: Record<number, EventDetail>;
}

/**
 * Looks up the source file, line, and time of every given raw line.
 * @param db - Open, migrated database.
 * @param ids - Raw line IDs, duplicates allowed.
 * @returns The files, each path stored once, and each event pointing at its file by index.
 */
function loadEvents(db: Db, ids: readonly number[]): EventTable {
  const rows = db
    .prepare(
      `SELECT l.id, f.relative_path, l.line_number,
         -- A log line's time is its parsed timestamp. A spool line has no parsed line, so its time
         -- is the capture: where the reading was recorded, while the point on the chart is dated by
         -- the response it reports (D-045).
         CASE f.kind
           WHEN 'spool' THEN strftime('%Y-%m-%dT%H:%M:%fZ', s.captured_at_s, 'unixepoch')
           ELSE p.timestamp_utc
         END AS at_utc
       FROM raw_lines l
       JOIN source_files f ON f.id = l.source_file_id
       LEFT JOIN parsed_lines p ON p.raw_line_id = l.id
       LEFT JOIN status_readings s ON s.raw_line_id = l.id
       -- One JSON parameter carries any number of IDs, where a placeholder list would hit SQLite's limit.
       WHERE l.id IN (SELECT value FROM json_each(?))
       ORDER BY ${CANONICAL}`,
    )
    .all(JSON.stringify(ids)) as unknown as EventSqlRow[];
  const files: string[] = [];
  const fileIndex = new Map<string, number>();
  const events: Record<number, EventDetail> = {};
  for (const row of rows) {
    // relative_path, never root: the file must not carry machine-specific absolute paths (CLAUDE.md).
    let file = fileIndex.get(row.relative_path);
    if (file === undefined) {
      file = files.length;
      files.push(row.relative_path);
      fileIndex.set(row.relative_path, file);
    }
    events[row.id] = { file, line: row.line_number, atUtc: row.at_utc };
  }
  return { files, events };
}

/**
 * Loads the notes under the monthly amounts with the requests behind each count: the rate-reading
 * counts by the text report's own rule (`loadProjected`'s rateReadings query) and the lower-bound
 * count by `proj_api_list_price`'s (`is_lower_bound = 1` over dated requests).
 * @param db - Open, migrated database.
 * @returns The notes; empty lists and 0 when no request qualifies.
 * @see D-020 for rates verified after a request's date, D-005 for lower-bound pricing.
 */
function loadPriceNotes(db: Db): PriceNotes {
  const readings = db
    .prepare(
      `SELECT c.verified_on, COUNT(*) AS requests,
         json_group_array(c.raw_line_id ORDER BY ${CANONICAL}) AS ids
       FROM request_costs c
       JOIN raw_lines l ON l.id = c.raw_line_id
       WHERE c.timestamp_utc IS NOT NULL AND c.unpriced_reason IS NULL AND c.day_utc < c.verified_on
       GROUP BY c.verified_on
       ORDER BY c.verified_on`,
    )
    .all() as { verified_on: string; requests: number; ids: string }[];
  const lower = db
    .prepare(
      // Ungrouped, this always returns one row, with [] for no rows.
      `SELECT COUNT(*) AS requests, json_group_array(c.raw_line_id ORDER BY ${CANONICAL}) AS ids
       FROM request_costs c
       JOIN raw_lines l ON l.id = c.raw_line_id
       WHERE c.timestamp_utc IS NOT NULL AND c.is_lower_bound = 1`,
    )
    .get() as { requests: number; ids: string };
  return {
    rateReadings: readings.map((row) => ({
      verifiedOn: row.verified_on,
      pricedBeforeVerifiedRequests: row.requests,
      events: parseIds(row.ids),
    })),
    lowerBoundRequests: lower.requests,
    lowerBoundEvents: parseIds(lower.ids),
  };
}

/**
 * Loads everything the HTML report draws, from the same views as the text report.
 * @param db - Open, migrated database.
 * @param meta - The display zone and the production time.
 * @param loaded - What the text report already read from this database in the same transaction;
 *   its interruption totals are reused instead of computed again. Omitted, they're read here, with
 *   the same result.
 * @returns The report's data: observed charts, projected months, and every event they refer to.
 * @see D-070.
 */
export const loadHtmlData: LoadHtmlData = (
  db: Db,
  meta: HtmlMeta,
  loaded?: LoadedReport,
): HtmlReportData => {
  // The page's own time, in Unix seconds: "open" is as of it (D-083).
  const at = meta.generatedAt.getTime() / 1000;
  const windows = loadWindows(db, at);
  const gauge = windows.map(toGauge);
  const series = windows.map(toSeries);
  const interruptions = loadInterruptions(db, loaded?.observed);
  // Lockouts carry their plan period only once a plan has been entered, as the split does.
  const lockouts = loadLockouts(db, interruptions.byPlan.length > 0);
  const afterReset = loadAfterReset(db);
  const crossings = loadCrossings(db, loaded?.observed);
  const models = loadModels(db);
  const repos = loadRepos(db);
  // Projections are read by their own function from their own view, never mixed into the rows above.
  const burn = loadBurn(db, at);
  const months = loadMonths(db);
  const priceNotes = loadPriceNotes(db);
  const referenced = [
    ...gauge.flatMap((g) => [...g.peakEvents, ...g.lastEvents, ...g.hitEvents]),
    ...series.flatMap((s) => [...s.points.map((p) => p.event), ...s.hits.map((h) => h.event)]),
    ...lockouts.flatMap((bar) => [
      ...bar.events,
      ...bar.nextRequestEvents,
      ...bar.autoContinuationEvents,
    ]),
    // interruptions.events already holds every hit; the two sublists are listed anyway, so the
    // table can't miss one should either list ever reach beyond it.
    ...interruptions.events,
    ...interruptions.unknownResetEvents,
    ...interruptions.hitsInNoColumnEvents,
    ...interruptions.byPlan.flatMap((p) => [...p.hitEvents, ...p.lockoutEvents]),
    ...afterReset.events,
    ...crossings.flatMap((c) => c.events),
    ...models.flatMap((bar) => bar.events),
    ...repos.flatMap((bar) => bar.events),
    ...burn.flatMap((window) => window.events),
    ...months.flatMap((bar) => [...bar.events, ...bar.unpricedEvents]),
    ...priceNotes.rateReadings.flatMap((reading) => reading.events),
    ...priceNotes.lowerBoundEvents,
  ];
  const { files, events } = loadEvents(db, [...new Set(referenced)]);
  return {
    timeZone: meta.timeZone,
    lastIngestAt: lastIngestAt(db),
    generatedAtUtc: meta.generatedAt.toISOString(),
    coverage: loadCoverage(db),
    gauge,
    series,
    lockouts,
    interruptions,
    afterReset,
    crossings,
    models,
    repos,
    home: meta.home ?? "",
    // The user's own links, as the text report lists them (D-092).
    repositoryAliases: (loaded?.observed.repositoryAliases ?? listAliases(db)).map((a) => ({
      from: a.from,
      to: a.to,
    })),
    missingHookPath: meta.missingHookPath ?? null,
    burn,
    months,
    priceNotes,
    files,
    events,
  };
};
