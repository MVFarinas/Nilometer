/**
 * @file `explain <metric>`: the events behind each number in the report (docs/development.md P7.2, README principle 4).
 *
 * Every metric maps to groups (one per number the report shows: a total, a window, a model, a
 * month), and each group lists its events with their source file, line, and byte offset. Each
 * measure is re-summed from the events and printed beside the value the report shows, so a
 * reader can check that the number really comes from these events. The events come from the
 * same `_events` views the metrics are built on; this module only lists and adds them.
 */
import type { Db } from "../core/db/database.js";
import { type ValueKind, formatInstant, formatNumber, printable } from "./format.js";
import type { PlanPeriodRow } from "./queries.js";
import {
  displayPath,
  planPeriodMonths,
  planPeriodName,
  repoKindName,
  windowName,
} from "./render.js";

/** One event behind a number. */
export interface ExplainEvent {
  /** When it happened (UTC), or null when unknown. */
  readonly at: string | null;
  /** What the event is, in words. */
  readonly description: string;
  /** Where it was read from: `path:line (byte N)`, or several joined by `, `. */
  readonly location: string;
  /** The event's contribution to each of the group's measures, in order. */
  readonly contributions: readonly (number | null)[];
}

/** A number the report shows, and what its events add up to. */
export interface Measure {
  /** What is measured. */
  readonly label: string;
  /** How to format it. */
  readonly kind: ValueKind;
  /** The value the report shows (from the metric view). */
  readonly reported: number | null;
  /**
   * When true, a sum with no non-null contribution is 0 rather than unknown, because the view
   * reports 0 there too (a COUNT or TOTAL, or unsplit cache writes when every request recorded
   * the split). Count measures always behave this way.
   */
  readonly nullIsZero?: boolean;
}

/** One number (or row of numbers) with its events. */
export interface ExplainGroup {
  /** Which number this is, e.g. `5-hour window resetting …` or a model name. */
  readonly title: string;
  /** The measures, aligned with each event's contributions. */
  readonly measures: readonly Measure[];
  /** Every event behind the measures. */
  readonly events: readonly ExplainEvent[];
}

/** Everything `explain` shows for one metric. */
export interface Explanation {
  /** The metric's command-line name. */
  readonly metric: MetricName;
  /** The metric's heading. */
  readonly title: string;
  /** Whether it's an observation or a projection. */
  readonly section: "observed" | "projected";
  /** The groups. */
  readonly groups: readonly ExplainGroup[];
}

/** A metric name `explain` doesn't know. */
export class UnknownMetricError extends Error {
  /**
   * Creates the error.
   * @param metric - The name given.
   */
  constructor(metric: string) {
    super(`Unknown metric "${metric}"; choose one of: ${METRIC_NAMES.join(", ")}`);
    this.name = "UnknownMetricError";
  }
}

/** A row with a source location. */
interface Located {
  readonly relative_path: string | null;
  readonly line_number: number | null;
  readonly byte_offset: number | null;
}

/** Joins a `raw_line_id` column (aliased `e`) to its file and position. */
const LOCATION_JOIN = `LEFT JOIN raw_lines l ON l.id = e.raw_line_id
  LEFT JOIN source_files f ON f.id = l.source_file_id`;

/** Location columns selected with {@link LOCATION_JOIN}. */
const LOCATION_COLUMNS = "f.relative_path, l.line_number, l.byte_offset";

/**
 * Formats a source location.
 * @param row - Row with location columns.
 * @returns `path:line (byte N)`, or `unknown location`.
 */
export function formatLocation(row: Located): string {
  return row.relative_path === null
    ? "unknown location"
    : `${row.relative_path}:${row.line_number} (byte ${row.byte_offset})`;
}

/**
 * Adds one measure's contributions.
 * @param group - The group.
 * @param index - Measure index.
 * @returns The sum; with no contributing event, 0 for counts and measures marked `nullIsZero`,
 *   otherwise null (unknown).
 */
export function resum(group: ExplainGroup, index: number): number | null {
  const values = group.events
    .map((event) => event.contributions[index])
    .filter((value): value is number => value !== null && value !== undefined);
  if (values.length === 0) {
    const measure = group.measures[index];
    return measure?.kind === "count" || measure?.nullIsZero === true ? 0 : null;
  }
  return values.reduce((sum, value) => sum + value, 0);
}

/** A limit-hit event row. */
interface HitRow extends Located {
  readonly hit_at_utc: string | null;
  readonly source: string;
  readonly window: string | null;
  readonly position: string;
  readonly session_id: string | null;
  /** Attachment lines the position looked past (D-076); 0 for the direct parent. */
  readonly attachments_passed: number;
}

/**
 * Describes a limit-hit event.
 * @param row - The event row.
 * @returns The event.
 */
function hitEvent(row: HitRow): ExplainEvent {
  const source = row.source === "session_log" ? "logged limit hit" : "status line reached 100%";
  const window = row.window === null ? "window unknown" : `${windowName(row.window)} window`;
  // The walk behind the position, so a reader can follow it to the line that decided it (D-076).
  const past =
    row.attachments_passed > 0
      ? `, past ${row.attachments_passed === 1 ? "1 attachment line" : `${row.attachments_passed} attachment lines`}`
      : "";
  return {
    at: row.hit_at_utc,
    description: `${source} | ${window} | position ${row.position.replace("_", " ")}${past} | session ${row.session_id ?? "unknown"}`,
    location: formatLocation(row),
    contributions: [1],
  };
}

/**
 * Reads one value from a single-row summary view.
 * @param db - Database.
 * @param sql - A query returning one row with column `v`.
 * @returns The value.
 */
function scalar(db: Db, sql: string): number | null {
  return (db.prepare(sql).get() as { v: number | null }).v;
}

/** Token measures shared by the model and repository explanations. */
const TOKEN_MEASURES = [
  ["requests", "Requests", "count"],
  ["input_tokens", "Input tokens", "tokens"],
  ["output_tokens", "Output tokens", "tokens"],
  ["cache_read_tokens", "Cache read tokens", "tokens"],
  ["cache_write_5m_tokens", "Cache write 5m tokens", "tokens"],
  ["cache_write_1h_tokens", "Cache write 1h tokens", "tokens"],
  ["cache_write_unsplit_tokens", "Cache write tokens, no duration", "tokens"],
] as const;

/** A usage event row. */
interface UsageRow extends Located {
  readonly timestamp_utc: string | null;
  readonly model: string;
  readonly session_id: string;
  readonly dedup_key: string | null;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_5m_tokens: number | null;
  readonly cache_write_1h_tokens: number | null;
  readonly cache_write_unsplit_tokens: number | null;
  /** The repository an alias moved the request from (D-092); absent or null when none. */
  readonly aliased_from?: string | null;
}

/**
 * Builds a token group from a summary row and its requests.
 * @param title - Group title.
 * @param summary - The summary view row.
 * @param requests - Its request events.
 * @returns The group.
 */
function tokenGroup(
  title: string,
  summary: Readonly<Record<string, number | null>>,
  requests: readonly UsageRow[],
): ExplainGroup {
  return {
    title,
    measures: TOKEN_MEASURES.map(([column, label, kind]) => ({
      label,
      kind,
      reported: summary[column] ?? null,
      ...(column === "cache_write_unsplit_tokens" ? { nullIsZero: true } : {}),
    })),
    events: requests.map((row) => ({
      at: row.timestamp_utc,
      // An aliased request says where it was before, so the user's alias is visible here (D-092).
      description: `request ${row.dedup_key ?? "without an ID"} | ${row.model}${
        row.aliased_from === undefined || row.aliased_from === null
          ? ""
          : ` | counted here by the alias from ${row.aliased_from}`
      }`,
      location: formatLocation(row),
      contributions: [
        1,
        row.input_tokens,
        row.output_tokens,
        row.cache_read_tokens,
        row.cache_write_5m_tokens,
        row.cache_write_1h_tokens,
        row.cache_write_unsplit_tokens,
      ],
    })),
  };
}

/** A reading row with its location. */
interface ReadingRow extends Located {
  readonly observed_at_utc: string;
  readonly captured_at_utc: string;
  readonly observed_via: string;
  readonly used_percentage: number;
  readonly session_id: string | null;
}

/**
 * Loads one status line reading as an event, for the window instance the group describes.
 * @param db - Database.
 * @param instance - The group's window instance and the raw line of the reading behind its value.
 * @param what - What the reading is to the group.
 * @returns The event list: one event, or none when there's no reading.
 */
function readingEvents(db: Db, instance: InstanceRow, what: string): ExplainEvent[] {
  if (instance.reading === null) {
    return [];
  }
  // One spool line carries both windows, so the raw line alone matches two rows; the window and
  // reset pick the one whose value the group reports (found on real data 2026-09-17).
  const row = db
    .prepare(
      `SELECT e.observed_at_utc, e.captured_at_utc, e.observed_via, e.used_percentage, e.session_id, ${LOCATION_COLUMNS}
       FROM window_readings e ${LOCATION_JOIN}
       WHERE e.raw_line_id = ? AND e.window = ? AND e.reset_at_utc = ?`,
    )
    .get(instance.reading, instance.window, instance.reset_at_utc) as unknown as ReadingRow;
  return [
    {
      at: row.observed_at_utc,
      // D-044: the value was observed at the session's last API response; the capture may be later.
      description: `${what}: ${formatNumber(row.used_percentage, "percent")} | session ${row.session_id ?? "unknown"} | ${
        row.observed_via === "last_request"
          ? `observed at the session's request before capture ${row.captured_at_utc}`
          : row.observed_via === "changed_capture"
            ? // D-086: the value changed after the session's last request, so it isn't that request's.
              "observed at capture (changed since the session's last request)"
            : "observed at capture (no request found in the logs)"
      }`,
      location: formatLocation(row),
      contributions: [row.used_percentage],
    },
  ];
}

/**
 * Lists a window's stale readings, which add nothing to its value (D-089): usage within a window
 * only rises, so a reading below an earlier one carries a number from before that reading.
 * @param db - Database.
 * @param instance - The window instance.
 * @returns One event per stale reading, contributing nothing, in time order.
 */
function staleEvents(db: Db, instance: InstanceRow): ExplainEvent[] {
  const rows = db
    .prepare(
      `SELECT e.observed_at_utc, e.used_percentage, e.session_id, ${LOCATION_COLUMNS}
       FROM window_readings e ${LOCATION_JOIN}
       WHERE e.window = ? AND e.reset_at_utc = ? AND e.after_reset = 0 AND e.stale = 1
       ORDER BY e.observed_at_s, e.raw_line_id`,
    )
    .all(instance.window, instance.reset_at_utc) as unknown as (Located & {
    observed_at_utc: string;
    used_percentage: number;
    session_id: string | null;
  })[];
  return rows.map((row) => ({
    at: row.observed_at_utc,
    description: `stale reading, not used: ${formatNumber(row.used_percentage, "percent")} | session ${row.session_id ?? "unknown"} | below an earlier reading in this window`,
    location: formatLocation(row),
    contributions: [null],
  }));
}

/** A window instance row with the reading that gives its value. */
interface InstanceRow {
  readonly window: string;
  readonly reset_at_utc: string;
  readonly value: number | null;
  readonly reading: number | null;
}

/** A window and its reset, identifying one window instance (D-024). */
interface WindowKey {
  readonly window: string;
  readonly reset_at_utc: string;
}

/**
 * Titles a window instance group.
 * @param key - Window and reset.
 * @returns E.g. `5-hour window resetting 2026-09-02T17:00:00.000Z`; the instant is shown in the
 *   display zone at render time.
 */
function instanceTitle(key: WindowKey): string {
  return `${windowName(key.window)} window resetting ${key.reset_at_utc}`;
}

/** Builders for every metric `explain` supports, keyed by command-line name. */
const BUILDERS = {
  "limit-hits": (db: Db): Explanation => ({
    metric: "limit-hits",
    title: "Rate-limit interruptions",
    section: "observed",
    groups: [
      {
        title: "All interruptions",
        measures: [
          {
            label: "Interruptions",
            kind: "count",
            reported: scalar(db, "SELECT hits AS v FROM obs_limit_hits"),
          },
        ],
        events: (
          db
            .prepare(
              `SELECT e.*, ${LOCATION_COLUMNS} FROM obs_limit_hits_events e ${LOCATION_JOIN} ORDER BY e.hit_at_utc, e.raw_line_id`,
            )
            .all() as unknown as HitRow[]
        ).map(hitEvent),
      },
    ],
  }),
  "mid-task": (db: Db): Explanation => ({
    metric: "mid-task",
    title: "Mid-task interruptions",
    section: "observed",
    groups: [
      {
        title: "Interruptions answering a tool result",
        measures: [
          {
            label: "Mid-task interruptions",
            kind: "count",
            reported: scalar(db, "SELECT mid_task AS v FROM obs_mid_task_interruptions"),
          },
        ],
        events: (
          db
            .prepare(
              `SELECT e.*, ${LOCATION_COLUMNS} FROM obs_mid_task_interruptions_events e ${LOCATION_JOIN} ORDER BY e.hit_at_utc, e.raw_line_id`,
            )
            .all() as unknown as HitRow[]
        ).map(hitEvent),
      },
    ],
  }),
  lockout: (db: Db): Explanation => {
    const intervals = db
      .prepare("SELECT * FROM obs_lockout_intervals ORDER BY interval_number")
      .all() as {
      interval_number: number;
      locked_from_utc: string;
      locked_until_utc: string;
      hits: number;
      lockout_seconds: number;
    }[];
    const hits = db.prepare(
      `SELECT ${LOCATION_COLUMNS} FROM obs_lockout_interval_hits e ${LOCATION_JOIN}
       WHERE e.interval_number = ? ORDER BY e.start_utc, e.raw_line_id`,
    );
    return {
      metric: "lockout",
      title: "Elapsed lockout time",
      section: "observed",
      groups: [
        {
          title: "Lockouts (first limit hit to the window's reset, overlapping lockouts merged)",
          measures: [
            {
              label: "Elapsed lockout time",
              kind: "duration",
              reported: scalar(db, "SELECT lockout_seconds AS v FROM obs_lockout_time"),
              // The view totals intervals with TOTAL, which is 0 when there are none.
              nullIsZero: true,
            },
          ],
          events: intervals.map((interval) => ({
            at: interval.locked_from_utc,
            description: `locked until ${interval.locked_until_utc} | ${interval.hits === 1 ? "1 hit" : `${interval.hits} hits`}`,
            location: (hits.all(interval.interval_number) as unknown as Located[])
              .map(formatLocation)
              .join(", "),
            contributions: [interval.lockout_seconds],
          })),
        },
        {
          // D-077: the logged markers behind each lockout's "resumed by Claude Code".
          title: "Sessions Claude Code resumed by itself after a reset (logged auto-continuation)",
          measures: [
            {
              label: "Resumed by Claude Code",
              kind: "count",
              reported: scalar(
                db,
                "SELECT TOTAL(auto_continuations) AS v FROM obs_lockout_intervals",
              ),
            },
          ],
          events: (
            db
              .prepare(
                `SELECT e.*, ${LOCATION_COLUMNS} FROM obs_auto_continuation_events e ${LOCATION_JOIN}
                 ORDER BY e.continued_at_utc, e.raw_line_id`,
              )
              .all() as unknown as (Located & {
              continued_at_utc: string;
              session_id: string;
              seconds_after_reset: number;
              locked_until_utc: string;
            })[]
          ).map((row) => ({
            at: row.continued_at_utc,
            description: `auto-continuation | ${formatNumber(row.seconds_after_reset, "duration")} after the reset at ${row.locked_until_utc} | session ${row.session_id}`,
            location: formatLocation(row),
            contributions: [1],
          })),
        },
      ],
    };
  },
  "by-plan": (db: Db): Explanation => {
    // The same rows, in the same order, as the report's per-plan table (D-075).
    const periods = db
      .prepare(
        `SELECT * FROM obs_interruptions_by_plan
         ORDER BY CASE period_kind WHEN 'none' THEN 0 WHEN 'plan' THEN 1 ELSE 2 END, from_month`,
      )
      .all() as unknown as PlanPeriodRow[];
    // Each period's hits: obs_limit_hits_events' own rows, so every hit reads as limit-hits lists it.
    const hits = db.prepare(
      `SELECT e.*, ${LOCATION_COLUMNS} FROM obs_limit_hits_events e
       JOIN obs_limit_hits_by_plan_events b ON b.raw_line_id = e.raw_line_id ${LOCATION_JOIN}
       WHERE b.period_kind = ? AND b.from_month IS ? ORDER BY e.hit_at_utc, e.raw_line_id`,
    );
    const intervals = db.prepare(
      `SELECT * FROM obs_lockout_by_plan_events
       WHERE period_kind = ? AND from_month IS ? ORDER BY interval_number`,
    );
    const intervalHits = db.prepare(
      `SELECT ${LOCATION_COLUMNS} FROM obs_lockout_interval_hits e ${LOCATION_JOIN}
       WHERE e.interval_number = ? ORDER BY e.start_utc, e.raw_line_id`,
    );
    return {
      metric: "by-plan",
      title: "Interruptions by plan period",
      section: "observed",
      groups: periods.flatMap((period) => {
        const name = `${planPeriodName(period)} (${planPeriodMonths(period)})`;
        return [
          {
            title: `${name}: limit hits`,
            measures: [{ label: "Limit hits", kind: "count" as const, reported: period.hits }],
            events: (hits.all(period.period_kind, period.from_month) as unknown as HitRow[]).map(
              hitEvent,
            ),
          },
          {
            title: `${name}: elapsed lockout time`,
            measures: [
              {
                label: "Elapsed lockout time",
                kind: "duration" as const,
                reported: period.lockout_seconds,
                // TOTAL in the view: 0 for a period with no lockout.
                nullIsZero: true,
              },
            ],
            events: (
              intervals.all(period.period_kind, period.from_month) as {
                interval_number: number;
                locked_from_utc: string;
                locked_until_utc: string;
                hits: number;
                lockout_seconds: number;
              }[]
            ).map((interval) => ({
              at: interval.locked_from_utc,
              description: `locked until ${interval.locked_until_utc} | ${interval.hits === 1 ? "1 hit" : `${interval.hits} hits`}`,
              location: (intervalHits.all(interval.interval_number) as unknown as Located[])
                .map(formatLocation)
                .join(", "),
              contributions: [interval.lockout_seconds],
            })),
          },
        ];
      }),
    };
  },
  "not-resumed": (db: Db): Explanation => ({
    metric: "not-resumed",
    title: "Sessions with no further request after a limit hit",
    section: "observed",
    groups: [
      {
        title: "Sessions, at their last limit hit",
        measures: [
          {
            label: "Sessions not resumed",
            kind: "count",
            reported: scalar(db, "SELECT sessions_not_resumed AS v FROM obs_sessions_not_resumed"),
          },
        ],
        events: (
          db
            .prepare(
              `SELECT e.session_id, e.last_hit_at_utc, e.reset_at_utc, ${LOCATION_COLUMNS}
               FROM (SELECT *, last_hit_raw_line_id AS raw_line_id FROM obs_sessions_not_resumed_events) e ${LOCATION_JOIN}
               ORDER BY e.last_hit_at_utc`,
            )
            .all() as unknown as (Located & {
            session_id: string;
            last_hit_at_utc: string;
            reset_at_utc: string | null;
          })[]
        ).map((row) => ({
          at: row.last_hit_at_utc,
          description: `session ${row.session_id} | reset ${row.reset_at_utc ?? "unknown"} | no later request in the session`,
          location: formatLocation(row),
          contributions: [1],
        })),
      },
    ],
  }),
  headroom: (db: Db): Explanation => ({
    metric: "headroom",
    title: "Last observed usage before each window's reset",
    section: "observed",
    groups: (
      db
        .prepare(
          `SELECT window, reset_at_utc, last_used_percentage AS value, last_reading_raw_line_id AS reading
           FROM obs_window_headroom ORDER BY reset_at_utc, window`,
        )
        .all() as unknown as InstanceRow[]
    ).map((row) => ({
      title: instanceTitle(row),
      measures: [
        { label: "Last observed usage (lower bound)", kind: "percent", reported: row.value },
      ],
      events: [...readingEvents(db, row, "last reading before the reset"), ...staleEvents(db, row)],
    })),
  }),
  peak: (db: Db): Explanation => ({
    metric: "peak",
    title: "Peak usage per window",
    section: "observed",
    groups: (
      db
        .prepare(
          `SELECT window, reset_at_utc, peak_used_percentage AS value, peak_reading_raw_line_id AS reading
           FROM obs_window_peak ORDER BY reset_at_utc, window`,
        )
        .all() as unknown as InstanceRow[]
    ).map((row) => ({
      title: instanceTitle(row),
      measures: [{ label: "Peak usage", kind: "percent", reported: row.value }],
      events: readingEvents(db, row, "highest reading"),
    })),
  }),
  // D-087 (step G3.2): each weekly window's first reading at or above 75% and 90%.
  crossings: (db: Db): Explanation => ({
    metric: "crossings",
    title: "Weekly windows at 75% and 90%",
    section: "observed",
    groups: (
      db
        .prepare(
          `SELECT window, reset_at_utc, threshold, seconds_before_reset,
             used_percentage AS value, raw_line_id AS reading
           FROM obs_weekly_crossings ORDER BY reset_at_utc, threshold`,
        )
        .all() as unknown as (InstanceRow & { threshold: number; seconds_before_reset: number })[]
    ).map((row) => ({
      title: `${instanceTitle(row)}: first reading at or above ${String(row.threshold)}%, ${formatNumber(row.seconds_before_reset, "duration")} before the reset`,
      measures: [{ label: "Usage at that reading", kind: "percent", reported: row.value }],
      events: readingEvents(db, row, `first reading at or above ${String(row.threshold)}%`),
    })),
  }),
  unattributed: (db: Db): Explanation => {
    const pairs = db.prepare(
      `SELECT e.*, ${LOCATION_COLUMNS} FROM obs_unattributed_usage_events e ${LOCATION_JOIN}
       WHERE e.window = ? AND e.reset_at_utc = ? ORDER BY e.observed_at_utc, e.raw_line_id`,
    );
    return {
      metric: "unattributed",
      title: "Usage rise with no Claude Code request between readings",
      section: "observed",
      groups: (
        db
          .prepare(
            "SELECT window, reset_at_utc, unattributed_percentage_points AS value, readings FROM obs_unattributed_usage ORDER BY reset_at_utc, window",
          )
          .all() as unknown as (InstanceRow & { readings: number })[]
      ).map((row) => ({
        title: instanceTitle(row),
        measures: [
          {
            label: "Rise with no request (lower bound)",
            kind: "percentage_points",
            reported: row.value,
            // As in the view (D-025): with two or more readings, no qualifying pair means 0; with fewer, unknown.
            nullIsZero: row.readings >= 2,
          },
        ],
        events: (
          pairs.all(row.window, row.reset_at_utc) as unknown as (Located & {
            previous_observed_at_utc: string;
            observed_at_utc: string;
            change_percentage_points: number;
          })[]
        ).map((pair) => ({
          at: pair.observed_at_utc,
          description: `rise of ${formatNumber(pair.change_percentage_points, "percentage_points")} since the observation at ${pair.previous_observed_at_utc}, no Claude Code request in between`,
          location: formatLocation(pair),
          contributions: [pair.change_percentage_points],
        })),
      })),
    };
  },
  "by-model": (db: Db): Explanation => {
    const requests = db.prepare(
      `SELECT e.*, ${LOCATION_COLUMNS} FROM obs_usage_events e ${LOCATION_JOIN}
       WHERE e.model = ? ORDER BY e.timestamp_utc, e.raw_line_id`,
    );
    return {
      metric: "by-model",
      title: "Claude Code tokens by model",
      section: "observed",
      groups: (
        db
          .prepare("SELECT * FROM obs_usage_by_model ORDER BY output_tokens DESC, model")
          .all() as Record<string, number | null>[]
      ).map((summary) => {
        const model = summary["model"] as unknown as string;
        return tokenGroup(model, summary, requests.all(model) as unknown as UsageRow[]);
      }),
    };
  },
  "by-repo": (db: Db): Explanation => {
    const requests = db.prepare(
      `SELECT e.*, ${LOCATION_COLUMNS} FROM obs_usage_events e ${LOCATION_JOIN}
       WHERE e.repository IS ? AND e.repo_kind = ? ORDER BY e.timestamp_utc, e.raw_line_id`,
    );
    return {
      metric: "by-repo",
      title: "Claude Code tokens by repository",
      section: "observed",
      groups: (
        db
          .prepare("SELECT * FROM obs_usage_by_repo ORDER BY output_tokens DESC, repository")
          .all() as Record<string, number | null>[]
      ).map((summary) => {
        const repository = summary["repository"] as unknown as string | null;
        const kind = summary["repo_kind"] as unknown as string;
        return tokenGroup(
          `${repository ?? "unknown (no working directory)"} | ${repoKindName(kind)}`,
          summary,
          requests.all(repository, kind) as unknown as UsageRow[],
        );
      }),
    };
  },
  "burn-rate": (db: Db): Explanation => ({
    metric: "burn-rate",
    title: "Burn rate",
    section: "projected",
    groups: (
      db
        .prepare(
          `SELECT b.window, b.reset_at_utc, b.last_used_percentage AS value, h.last_reading_raw_line_id AS reading
           FROM proj_burn_rate b
           JOIN obs_window_headroom h ON h.window = b.window AND h.reset_at_utc = b.reset_at_utc
           ORDER BY b.reset_at_utc, b.window`,
        )
        .all() as unknown as InstanceRow[]
    ).map((row) => ({
      title: `${instanceTitle(row)}: projected from this reading, with the window's usage at 0% when it began`,
      measures: [
        {
          label: "Last observed usage the projection starts from",
          kind: "percent",
          reported: row.value,
        },
      ],
      events: readingEvents(db, row, "last reading before the reset"),
    })),
  }),
  "api-list-price": (db: Db): Explanation => {
    const requests = db.prepare(
      `SELECT e.dedup_key, e.model, e.timestamp_utc, e.total_usd, e.unpriced_reason, ${LOCATION_COLUMNS}
       FROM request_costs e ${LOCATION_JOIN}
       WHERE strftime('%Y-%m', e.timestamp_utc, 'localtime') = ? ORDER BY e.timestamp_utc, e.raw_line_id`,
    );
    return {
      metric: "api-list-price",
      title: "Observed tokens at API list price, by month",
      section: "projected",
      groups: (
        db
          .prepare(
            "SELECT month, api_list_price_usd, priced_requests, unpriced_requests FROM proj_api_list_price ORDER BY month",
          )
          .all() as {
          month: string;
          api_list_price_usd: number | null;
          priced_requests: number;
          unpriced_requests: number;
        }[]
      ).map((month) => ({
        title: month.month,
        measures: [
          { label: "At API list price", kind: "usd", reported: month.api_list_price_usd },
          {
            label: "Priced requests",
            kind: "count",
            reported: month.priced_requests,
            nullIsZero: true,
          },
          {
            label: "Unpriced requests",
            kind: "count",
            reported: month.unpriced_requests,
            nullIsZero: true,
          },
        ],
        events: (
          requests.all(month.month) as unknown as (Located & {
            dedup_key: string | null;
            model: string;
            timestamp_utc: string;
            total_usd: number | null;
            unpriced_reason: string | null;
          })[]
        ).map((row) => ({
          at: row.timestamp_utc,
          description: `request ${row.dedup_key ?? "without an ID"} | ${row.model} | ${
            row.unpriced_reason === null
              ? formatNumber(row.total_usd, "usd")
              : `unpriced (${row.unpriced_reason.replaceAll("_", " ")})`
          }`,
          location: formatLocation(row),
          contributions: [
            row.total_usd,
            row.unpriced_reason === null ? 1 : 0,
            row.unpriced_reason === null ? 0 : 1,
          ],
        })),
      })),
    };
  },
} as const;

/** A metric name `explain` accepts. */
export type MetricName = keyof typeof BUILDERS;

/** Every metric name, in report order. */
export const METRIC_NAMES = Object.keys(BUILDERS) as MetricName[];

/**
 * Builds the explanation for a metric.
 * @param db - Open, migrated database.
 * @param metric - A name from {@link METRIC_NAMES}.
 * @returns The explanation.
 * @throws {UnknownMetricError} If the name isn't one of {@link METRIC_NAMES}.
 */
export function explain(db: Db, metric: string): Explanation {
  if (!Object.hasOwn(BUILDERS, metric)) {
    throw new UnknownMetricError(metric);
  }
  return BUILDERS[metric as MetricName](db);
}

/**
 * Renders an explanation.
 * @param explanation - From {@link explain}.
 * @param timeZone - Display zone.
 * @param home - Home directory to show as `~`.
 * @param limit - Most events listed per group; `Infinity` lists all. Re-sums always use every event.
 * @returns Lines.
 */
export function renderExplanation(
  explanation: Explanation,
  timeZone: string,
  home: string,
  limit: number,
): string[] {
  const section =
    explanation.section === "observed" ? "observed" : "projected: an estimate, not an observation";
  const lines = [`Explain: ${explanation.title} (${section})`, `Times are in ${timeZone}.`];
  if (explanation.groups.length === 0) {
    lines.push("", "No data for this metric yet.");
  }
  for (const group of explanation.groups) {
    // Group titles may carry UTC instants; show them in the display zone.
    const title = group.title.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (iso) =>
      formatInstant(iso, timeZone),
    );
    // Titles, descriptions, and locations carry repository paths, model names, session IDs, and
    // file names from the logs, so escape control characters before printing them (D-050).
    lines.push("", printable(displayPath(title, home)));
    group.measures.forEach((measure, index) => {
      const fromEvents = resum(group, index);
      const agrees =
        measure.reported === null || fromEvents === null
          ? measure.reported === fromEvents
          : Math.abs(measure.reported - fromEvents) <=
            1e-9 * Math.max(1, Math.abs(measure.reported));
      lines.push(
        `  ${measure.label}: report shows ${formatNumber(measure.reported, measure.kind)} | from the ${group.events.length === 1 ? "event" : `${formatNumber(group.events.length, "count")} events`} below: ${formatNumber(fromEvents, measure.kind)}${agrees ? "" : " | these don't match"}`,
      );
    });
    for (const event of group.events.slice(0, limit)) {
      lines.push(
        `    ${formatInstant(event.at, timeZone)}  ${printable(event.description)}  ${printable(event.location)}`,
      );
    }
    if (group.events.length > limit) {
      lines.push(
        `    ${formatNumber(group.events.length - limit, "count")} more events not listed; --all lists every event`,
      );
    }
  }
  return lines;
}
