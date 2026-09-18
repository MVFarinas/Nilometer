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
  readonly window_open: number;
  readonly covers_from: string | null;
  readonly covers_to: string | null;
}

/** One row of `obs_unattributed_usage`. */
export interface UnattributedRow {
  readonly window: string;
  readonly reset_at_utc: string;
  readonly readings: number;
  readonly pairs: number;
  readonly pairs_without_requests: number;
  readonly decreasing_pairs: number;
  readonly unattributed_percentage_points: number | null;
  readonly window_open: number;
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

/** Everything observed. */
export interface ObservedReport {
  readonly limitHits: LimitHits;
  readonly midTask: MidTask;
  readonly lockout: LockoutTime;
  readonly lockoutIntervals: readonly LockoutInterval[];
  readonly notResumed: NotResumed;
  readonly windows: readonly WindowRow[];
  readonly unattributed: readonly UnattributedRow[];
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

/** Everything projected. */
export interface ProjectedReport {
  readonly burnRate: readonly BurnRateRow[];
  readonly apiListPrice: readonly ApiListPriceRow[];
}

/** The views {@link loadObserved} reads. Only `obs_` views belong here. */
export const OBSERVED_VIEWS = [
  "obs_limit_hits",
  "obs_mid_task_interruptions",
  "obs_lockout_time",
  "obs_lockout_intervals",
  "obs_sessions_not_resumed",
  "obs_window_headroom",
  "obs_window_peak",
  "obs_unattributed_usage",
  "obs_usage_by_model",
  "obs_usage_by_repo",
] as const;

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
 * @returns The observed report.
 */
export function loadObserved(db: Db): ObservedReport {
  return {
    limitHits: observed<LimitHits>(db, "obs_limit_hits")[0] as LimitHits,
    midTask: observed<MidTask>(db, "obs_mid_task_interruptions")[0] as MidTask,
    lockout: observed<LockoutTime>(db, "obs_lockout_time")[0] as LockoutTime,
    lockoutIntervals: observed<LockoutInterval>(db, "obs_lockout_intervals", "interval_number"),
    notResumed: observed<NotResumed>(db, "obs_sessions_not_resumed")[0] as NotResumed,
    // Headroom and peak describe the same window instances, so they're joined in SQL to sit side by side.
    windows: db
      .prepare(
        `SELECT h.*, p.peak_used_percentage
         FROM obs_window_headroom h
         JOIN obs_window_peak p ON p.window = h.window AND p.reset_at_utc = h.reset_at_utc
         ORDER BY h.window_open DESC, h.reset_at_utc DESC, h.window`,
      )
      .all() as WindowRow[],
    unattributed: observed<UnattributedRow>(
      db,
      "obs_unattributed_usage",
      "window_open DESC, reset_at_utc DESC, window",
    ),
    byModel: observed<ModelRow>(db, "obs_usage_by_model", "output_tokens DESC, model"),
    byRepo: observed<RepoRow>(db, "obs_usage_by_repo", "output_tokens DESC, repository"),
  };
}

/**
 * Loads every projection.
 * @param db - Open, migrated database.
 * @returns The projected report.
 */
export function loadProjected(db: Db): ProjectedReport {
  return {
    burnRate: projected<BurnRateRow>(
      db,
      "proj_burn_rate",
      "window_open DESC, reset_at_utc DESC, window",
    ),
    apiListPrice: projected<ApiListPriceRow>(db, "proj_api_list_price", "month"),
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
