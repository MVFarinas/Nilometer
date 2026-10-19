/**
 * @file Loading the report's rows from the metric views (docs/development.md P7.1).
 *
 * Observations and projections are read by separate functions from separate view lists, and come
 * back as separate objects, so no rendering code can place a projection among observations
 * (README principle 2). `tests/unit/viewer/queries.test.ts` checks that {@link OBSERVED_VIEWS}
 * holds only `obs_` views and {@link PROJECTED_VIEWS} only `proj_` views. The SQL here only selects
 * whole views: every computation stays in the views themselves.
 */
import type { Db } from "../core/db/database.js";

/** `obs_limit_hits`. */
export interface LimitHits {
  readonly hits: number;
  readonly logged_hits: number;
  readonly status_line_only_hits: number;
  readonly five_hour_hits: number;
  readonly seven_day_hits: number;
  readonly unknown_window_hits: number;
  readonly covers_from: string | null;
  readonly covers_to: string | null;
  readonly status_line_covers_from: string | null;
  readonly status_line_covers_to: string | null;
}

/** `obs_mid_task_interruptions`. */
export interface MidTask {
  readonly mid_task: number;
  readonly turn_start: number;
  readonly position_unknown: number;
  readonly covers_from: string | null;
  readonly covers_to: string | null;
}

/** `obs_lockout_time`. */
export interface LockoutTime {
  readonly intervals: number;
  readonly lockout_seconds: number;
  readonly hits_with_known_reset: number;
  readonly hits_with_unknown_reset: number;
  readonly covers_from: string | null;
  readonly covers_to: string | null;
}

/** One row of `obs_lockout_intervals`. */
export interface LockoutInterval {
  readonly interval_number: number;
  readonly locked_from_utc: string;
  readonly locked_until_utc: string;
  readonly hits: number;
  readonly lockout_seconds: number;
  readonly next_request_at_utc: string | null;
  readonly reset_to_next_request_seconds: number | null;
  readonly reset_after_coverage: number | null;
  /** Sessions Claude Code resumed by itself after the reset, as logged (D-077); 0 when none. */
  readonly auto_continuations: number;
  /** Seconds from the reset to the first of those; null when none. */
  readonly first_auto_continuation_seconds: number | null;
}

/** `obs_sessions_not_resumed`. */
export interface NotResumed {
  readonly sessions_with_hits: number;
  readonly sessions_not_resumed: number;
  readonly reset_after_coverage: number;
  readonly reset_unknown: number;
  readonly covers_from: string | null;
  readonly covers_to: string | null;
}

/** One row of `obs_window_headroom` joined with its `obs_window_peak` row. */
export interface WindowRow {
  readonly window: string;
  readonly reset_at_utc: string;
  readonly last_used_percentage: number | null;
  readonly last_reading_at_utc: string | null;
  readonly peak_used_percentage: number | null;
  readonly readings: number;
  readonly readings_after_reset: number;
  /** 1 while the window hadn't reset as of the last status line reading (the view's own rule). */
  readonly window_open: number;
  /**
   * 1 while it hasn't reset as of the report's own time either (D-083): a window whose reset has
   * passed isn't open, whatever was or wasn't read after it. Without a report time, as `window_open`.
   */
  readonly open_at_report: number;
  readonly covers_from: string | null;
  readonly covers_to: string | null;
}

/** Token columns shared by the usage views. */
export interface TokenColumns {
  readonly requests: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_5m_tokens: number | null;
  readonly cache_write_1h_tokens: number | null;
  readonly cache_write_unsplit_tokens: number | null;
  readonly requests_without_timestamp: number;
  readonly covers_from: string | null;
  readonly covers_to: string | null;
}

/** One row of `obs_usage_by_model`. */
export interface ModelRow extends TokenColumns {
  readonly model: string;
  readonly unkeyed_requests: number;
}

/** One row of `obs_usage_by_repo`. */
export interface RepoRow extends TokenColumns {
  readonly repository: string | null;
  readonly repo_kind: string;
}

/** One row of `obs_interruptions_by_plan` (D-075). */
export interface PlanPeriodRow {
  /** `plan` inside an entered plan's months, `none` before the first, `unknown` for hits with no time. */
  readonly period_kind: "plan" | "none" | "unknown";
  /** First local month the plan applies; null for `none` and `unknown`. */
  readonly from_month: string | null;
  /** Last local month it applies; null while it still applies. */
  readonly to_month: string | null;
  /** The next entry's month (exclusive); for `none`, the first plan's month, or null with none entered. */
  readonly until_month: string | null;
  /** The plan's name as entered; null for `none` and `unknown`. */
  readonly plan_name: string | null;
  readonly hits: number;
  readonly five_hour_hits: number;
  readonly seven_day_hits: number;
  readonly unknown_window_hits: number;
  readonly lockouts: number;
  readonly lockout_seconds: number;
  readonly covers_from: string | null;
  readonly covers_to: string | null;
}

/** One row of `obs_weekly_crossings` (D-087): a weekly window's first reading at or above a level. */
export interface CrossingRow {
  readonly window: string;
  readonly reset_at_utc: string;
  /** 75 or 90. */
  readonly threshold: number;
  /** When the first reading at or above the level was observed. */
  readonly first_at_utc: string;
  readonly used_percentage: number;
  /** From that reading to the window's reset. */
  readonly seconds_before_reset: number;
  /** The reading's raw line, for `explain`. */
  readonly raw_line_id: number;
}

/** Everything observed. */
export interface ObservedReport {
  readonly limitHits: LimitHits;
  readonly midTask: MidTask;
  readonly lockout: LockoutTime;
  readonly lockoutIntervals: readonly LockoutInterval[];
  /** Hits, lockouts, and elapsed lockout time per plan period (D-075, step G2.2). */
  readonly interruptionsByPlan: readonly PlanPeriodRow[];
  readonly notResumed: NotResumed;
  readonly windows: readonly WindowRow[];
  /** Weekly windows' first readings at or above 75% and 90%, newest window first (D-087, step G3.2). */
  readonly weeklyCrossings: readonly CrossingRow[];
  readonly byModel: readonly ModelRow[];
  readonly byRepo: readonly RepoRow[];
}

/** One row of `proj_burn_rate`. */
export interface BurnRateRow {
  readonly window: string;
  readonly reset_at_utc: string;
  readonly window_start_utc: string;
  readonly last_used_percentage: number | null;
  readonly last_reading_at_utc: string | null;
  readonly window_open: number;
  /** As {@link WindowRow.open_at_report}: open at the report's time too (D-083). */
  readonly open_at_report: number;
  readonly limit_reached: number | null;
  readonly projected_percentage_points_per_hour: number | null;
  readonly projected_limit_at_utc: string | null;
  readonly projected_limit_before_reset: number | null;
  readonly covers_from: string | null;
  readonly covers_to: string | null;
}

/** One row of `proj_api_list_price`. */
export interface ApiListPriceRow {
  readonly month: string;
  readonly requests: number;
  readonly priced_requests: number;
  readonly unpriced_requests: number;
  readonly lower_bound_requests: number;
  readonly priced_before_verified_requests: number;
  readonly verified_on: string | null;
  readonly api_list_price_usd: number | null;
  readonly plan_name: string | null;
  readonly plan_usd_per_month: number | null;
  readonly covers_from: string;
  readonly covers_to: string;
}

/** Priced requests dated before the day their rate was read, for one reading date. */
export interface RateReadingRow {
  readonly verified_on: string;
  readonly priced_before_verified_requests: number;
}

/** Everything projected. */
export interface ProjectedReport {
  readonly burnRate: readonly BurnRateRow[];
  readonly apiListPrice: readonly ApiListPriceRow[];
  readonly rateReadings: readonly RateReadingRow[];
}

/** The views {@link loadObserved} reads. Only `obs_` views belong here. */
export const OBSERVED_VIEWS = [
  "obs_limit_hits",
  "obs_mid_task_interruptions",
  "obs_lockout_time",
  "obs_lockout_intervals",
  "obs_interruptions_by_plan",
  "obs_sessions_not_resumed",
  "obs_window_headroom",
  "obs_window_peak",
  "obs_weekly_crossings",
  "obs_usage_by_model",
  "obs_usage_by_repo",
] as const;

/**
 * Metric views the report no longer shows, kept so `nilometer explain` can still list their
 * events. Unattributed usage was zero in every one of Phase 8's 49 windows, since each fresh
 * reading follows a request in its own session (D-044); D-079 took it off the screen, and the
 * view stays to show that it is always zero.
 */
export const EXPLAIN_ONLY_VIEWS = ["obs_unattributed_usage"] as const;

/** The views {@link loadProjected} reads. Only `proj_` views belong here. */
export const PROJECTED_VIEWS = ["proj_burn_rate", "proj_api_list_price"] as const;

/**
 * Reads every row of one observed view.
 * @param db - Open, migrated database.
 * @param view - A name from {@link OBSERVED_VIEWS}.
 * @param order - ORDER BY clause.
 * @returns The rows.
 */
function observed<T>(db: Db, view: (typeof OBSERVED_VIEWS)[number], order = "1"): T[] {
  return db.prepare(`SELECT * FROM ${view} ORDER BY ${order}`).all() as T[];
}

/**
 * Reads every row of one projected view.
 * @param db - Open, migrated database.
 * @param view - A name from {@link PROJECTED_VIEWS}.
 * @param order - ORDER BY clause.
 * @returns The rows.
 */
function projected<T>(db: Db, view: (typeof PROJECTED_VIEWS)[number], order: string): T[] {
  return db.prepare(`SELECT * FROM ${view} ORDER BY ${order}`).all() as T[];
}

/**
 * Loads every observed metric.
 * @param db - Open, migrated database.
 * @param reportedAt - The report's time: a window is open only until its reset, as of it (D-083).
 *   Omitted, open is as of the last status line reading, as the views define it.
 * @returns The observed report.
 */
export function loadObserved(db: Db, reportedAt?: Date): ObservedReport {
  // The report's own time, in Unix seconds, for "open" (D-083); null keeps the view's rule.
  const at = reportedAt === undefined ? null : reportedAt.getTime() / 1000;
  return {
    limitHits: observed<LimitHits>(db, "obs_limit_hits")[0] as LimitHits,
    midTask: observed<MidTask>(db, "obs_mid_task_interruptions")[0] as MidTask,
    lockout: observed<LockoutTime>(db, "obs_lockout_time")[0] as LockoutTime,
    lockoutIntervals: observed<LockoutInterval>(db, "obs_lockout_intervals", "interval_number"),
    // Before the first plan, then plans in order, then hits with no time (D-075).
    interruptionsByPlan: observed<PlanPeriodRow>(
      db,
      "obs_interruptions_by_plan",
      "CASE period_kind WHEN 'none' THEN 0 WHEN 'plan' THEN 1 ELSE 2 END, from_month",
    ),
    notResumed: observed<NotResumed>(db, "obs_sessions_not_resumed")[0] as NotResumed,
    // Headroom and peak describe the same window instances, so they're joined in SQL to sit side by side.
    windows: db
      .prepare(
        `SELECT h.*, p.peak_used_percentage,
           -- Open only until its reset, as of the report's time (D-083).
           (h.window_open = 1 AND (:at IS NULL OR unixepoch(h.reset_at_utc, 'subsec') > :at))
             AS open_at_report
         FROM obs_window_headroom h
         JOIN obs_window_peak p ON p.window = h.window AND p.reset_at_utc = h.reset_at_utc
         ORDER BY open_at_report DESC, h.reset_at_utc DESC, h.window`,
      )
      .all({ at }) as WindowRow[],
    // Newest window first, as the windows table lists them; within one, the lower level first.
    weeklyCrossings: observed<CrossingRow>(
      db,
      "obs_weekly_crossings",
      "reset_at_utc DESC, threshold",
    ),
    byModel: observed<ModelRow>(db, "obs_usage_by_model", "output_tokens DESC, model"),
    byRepo: observed<RepoRow>(db, "obs_usage_by_repo", "output_tokens DESC, repository"),
  };
}

/**
 * Loads every projection.
 * @param db - Open, migrated database.
 * @param reportedAt - The report's time, as for {@link loadObserved}: burn rate projects windows open at it.
 * @returns The projected report.
 */
export function loadProjected(db: Db, reportedAt?: Date): ProjectedReport {
  // The report's own time, as loadObserved takes it (D-083).
  const at = reportedAt === undefined ? null : reportedAt.getTime() / 1000;
  return {
    // A projection for a window that has already reset would project into the past (D-083).
    burnRate: db
      .prepare(
        `SELECT *,
           (window_open = 1 AND (:at IS NULL OR unixepoch(reset_at_utc, 'subsec') > :at))
             AS open_at_report
         FROM proj_burn_rate
         ORDER BY open_at_report DESC, reset_at_utc DESC, window`,
      )
      .all({ at }) as BurnRateRow[],
    apiListPrice: projected<ApiListPriceRow>(db, "proj_api_list_price", "month"),
    // Grouped by reading date so each count stays beside its own date. The month view's
    // verified_on is the latest date in the month, which isn't the date its count refers to once
    // price rows were read on different days.
    rateReadings: db
      .prepare(
        `SELECT verified_on, COUNT(*) AS priced_before_verified_requests
         FROM request_costs
         WHERE timestamp_utc IS NOT NULL AND unpriced_reason IS NULL AND day_utc < verified_on
         GROUP BY verified_on
         ORDER BY verified_on`,
      )
      .all() as RateReadingRow[],
  };
}

/**
 * Reads when the last ingest finished.
 * @param db - Open, migrated database.
 * @returns ISO-8601 UTC, or null before any completed ingest.
 */
export function lastIngestAt(db: Db): string | null {
  return (
    db.prepare("SELECT MAX(finished_at) AS at FROM ingest_runs").get() as { at: string | null }
  ).at;
}
