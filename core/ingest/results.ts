/**
 * @file Reading ingestion results in the fixture result shape (docs/development.md P4.5).
 *
 * The shape is the one fixtures/README.md defines for `expected.json`, so the fidelity suite can
 * compare the loader field by field with hand-computed answers and with the independent reference.
 * All counting, grouping, and ordering happens in SQL (README § Tech stack); this module only maps
 * rows to JSON.
 */
import type { Db } from "../db/database.js";

/** Token totals for a group of requests. */
export interface Totals {
  /** Number of requests in the group. */
  readonly requests: number;
  /** Sum of input tokens. */
  readonly input_tokens: number;
  /** Sum of output tokens. */
  readonly output_tokens: number;
  /** Sum of cache-read tokens. */
  readonly cache_read_tokens: number;
  /** Sum of 5-minute cache writes (null counts as 0). */
  readonly cache_write_5m_tokens: number;
  /** Sum of 1-hour cache writes (null counts as 0). */
  readonly cache_write_1h_tokens: number;
  /** Sum of unsplit cache writes (null counts as 0). */
  readonly cache_write_unsplit_tokens: number;
}

/** One deduplicated request, traceable to its source line. */
export interface RequestResult {
  readonly dedup_key: string | null;
  readonly file: string;
  readonly line: number;
  readonly session_id: string;
  readonly message_id: string | null;
  readonly request_id: string | null;
  readonly model: string;
  readonly timestamp: unknown;
  readonly is_sidechain: boolean;
  readonly cwd: string | null;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_5m_tokens: number | null;
  readonly cache_write_1h_tokens: number | null;
  readonly cache_write_unsplit_tokens: number | null;
}

/** One event line. */
export interface EventResult {
  readonly class: string;
  readonly session_id: string;
  readonly timestamp: unknown;
  readonly file: string;
  readonly line: number;
  readonly error: string | null;
  readonly api_error_status: number | null;
  readonly window: string | null;
  readonly reset_text: string | null;
}

/** The report section. */
export interface ReportResult {
  readonly lines: Record<string, number>;
  readonly malformed: { file: string; line: number }[];
  readonly ignored_types: Record<string, number>;
  readonly unkeyed_requests: number;
  readonly unknown_error_values: Record<string, number>;
  readonly missing_fields: { file: string; line: number; field: string }[];
  readonly unparsed_timestamps: { file: string; line: number; raw: unknown }[];
  readonly non_message_iterations: { file: string; line: number; type: string }[];
  readonly retry_rate_limits_present: number;
}

/** A complete result in the fixture shape. */
export interface IngestResult {
  readonly requests: RequestResult[];
  readonly totals_by_model: Record<string, Totals>;
  readonly totals_by_day_utc: Record<string, Record<string, Totals>>;
  readonly events: EventResult[];
  readonly report: ReportResult;
}

/** Every line class, so the report lists zero counts too. */
const CLASSES = [
  "malformed",
  "limit_hit",
  "api_error",
  "synthetic_other",
  "request",
  "retry_notice",
  "ignored_type",
] as const;

/** SQL selecting the seven total columns for a group; NULL cache writes count as 0. */
const TOTALS_COLUMNS = `
  COUNT(*) AS requests,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  COALESCE(SUM(cache_write_5m_tokens), 0) AS cache_write_5m_tokens,
  COALESCE(SUM(cache_write_1h_tokens), 0) AS cache_write_1h_tokens,
  COALESCE(SUM(cache_write_unsplit_tokens), 0) AS cache_write_unsplit_tokens`;

/** SQL joining a derived row to its source position. `x` must alias a table with raw_line_id. */
const POSITION_JOIN = `
  JOIN raw_lines l ON l.id = x.raw_line_id
  JOIN source_files f ON f.id = l.source_file_id`;

/** SQL ordering by (file, first run, line), the canonical order. */
const CANONICAL_ORDER = "ORDER BY f.root, f.relative_path, l.first_run_id, l.line_number";

/**
 * Parses a stored raw timestamp back to its JSON value.
 * @param text - JSON text, or null when the line had no timestamp.
 * @returns The original value; null when absent.
 */
export function rawTimestamp(text: string | null): unknown {
  return text === null ? null : JSON.parse(text);
}

/**
 * Removes the totals columns' group key and returns the totals object.
 * @param row - A row with the seven totals columns.
 * @returns Totals in the documented field order.
 */
export function toTotals(row: Totals): Totals {
  return {
    requests: row.requests,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_write_5m_tokens: row.cache_write_5m_tokens,
    cache_write_1h_tokens: row.cache_write_1h_tokens,
    cache_write_unsplit_tokens: row.cache_write_unsplit_tokens,
  };
}

/**
 * Reads the full result for everything ingested so far.
 * @param db - Open database with derived tables up to date.
 * @returns Requests, totals, events, and report in the fixture shape.
 */
export function readResult(db: Db): IngestResult {
  const requests = (
    db
      .prepare(
        "SELECT * FROM requests_dedup ORDER BY root, relative_path, first_run_id, line_number",
      )
      .all() as (Record<string, unknown> & { is_sidechain: number; timestamp_raw: string | null })[]
  ).map((row): RequestResult => ({
    dedup_key: row["dedup_key"] as string | null,
    file: row["relative_path"] as string,
    line: row["line_number"] as number,
    session_id: row["session_id"] as string,
    message_id: row["message_id"] as string | null,
    request_id: row["request_id"] as string | null,
    model: row["model"] as string,
    timestamp: rawTimestamp(row.timestamp_raw),
    is_sidechain: row.is_sidechain === 1,
    cwd: row["cwd"] as string | null,
    input_tokens: row["input_tokens"] as number,
    output_tokens: row["output_tokens"] as number,
    cache_read_tokens: row["cache_read_tokens"] as number,
    cache_write_5m_tokens: row["cache_write_5m_tokens"] as number | null,
    cache_write_1h_tokens: row["cache_write_1h_tokens"] as number | null,
    cache_write_unsplit_tokens: row["cache_write_unsplit_tokens"] as number | null,
  }));

  const totalsByModel: Record<string, Totals> = {};
  for (const row of db
    .prepare(`SELECT model, ${TOTALS_COLUMNS} FROM requests_dedup GROUP BY model ORDER BY model`)
    .all() as (Totals & { model: string })[]) {
    totalsByModel[row.model] = toTotals(row);
  }

  const totalsByDay: Record<string, Record<string, Totals>> = {};
  for (const row of db
    .prepare(
      `SELECT substr(timestamp_utc, 1, 10) AS day, model, ${TOTALS_COLUMNS}
       FROM requests_dedup WHERE timestamp_utc IS NOT NULL
       GROUP BY day, model ORDER BY day, model`,
    )
    .all() as (Totals & { day: string; model: string })[]) {
    (totalsByDay[row.day] ??= {})[row.model] = toTotals(row);
  }

  const events = (
    db
      .prepare(
        `SELECT x.class, p.session_id, p.timestamp_raw, f.relative_path, l.line_number,
                x.error, x.api_error_status, x.window, x.reset_text
         FROM events x JOIN parsed_lines p ON p.raw_line_id = x.raw_line_id ${POSITION_JOIN}
         ${CANONICAL_ORDER}`,
      )
      .all() as {
      class: string;
      session_id: string;
      timestamp_raw: string | null;
      relative_path: string;
      line_number: number;
      error: string | null;
      api_error_status: number | null;
      window: string | null;
      reset_text: string | null;
    }[]
  ).map((row): EventResult => ({
    class: row.class,
    session_id: row.session_id,
    timestamp: rawTimestamp(row.timestamp_raw),
    file: row.relative_path,
    line: row.line_number,
    error: row.error,
    api_error_status: row.api_error_status,
    window: row.window,
    reset_text: row.reset_text,
  }));

  return {
    requests,
    totals_by_model: totalsByModel,
    totals_by_day_utc: totalsByDay,
    events,
    report: readReport(db),
  };
}

/**
 * Reads the report section.
 * @param db - Open database with derived tables up to date.
 * @returns Line counts by class and every reported problem, in canonical order.
 */
export function readReport(db: Db): ReportResult {
  const lines: Record<string, number> = Object.fromEntries(CLASSES.map((name) => [name, 0]));
  for (const row of db
    .prepare("SELECT class, COUNT(*) AS n FROM parsed_lines GROUP BY class")
    .all() as { class: string; n: number }[]) {
    lines[row.class] = row.n;
  }

  const malformed = db
    .prepare(
      `SELECT f.relative_path AS file, l.line_number AS line
       FROM parsed_lines x ${POSITION_JOIN} WHERE x.class = 'malformed' ${CANONICAL_ORDER}`,
    )
    .all() as { file: string; line: number }[];

  const ignoredTypes: Record<string, number> = {};
  for (const row of db
    .prepare(
      `SELECT CASE WHEN subtype IS NULL THEN type ELSE type || '/' || subtype END AS label,
              COUNT(*) AS n
       FROM parsed_lines WHERE class = 'ignored_type' GROUP BY label ORDER BY label`,
    )
    .all() as { label: string; n: number }[]) {
    ignoredTypes[row.label] = row.n;
  }

  const unknownErrors: Record<string, number> = {};
  for (const row of db
    .prepare(
      `SELECT unknown_error_key AS label, COUNT(*) AS n FROM events
       WHERE unknown_error_key IS NOT NULL GROUP BY label ORDER BY label`,
    )
    .all() as { label: string; n: number }[]) {
    unknownErrors[row.label] = row.n;
  }

  /**
   * Lists one kind of line problem in canonical order.
   * @param problem - The problem code.
   * @returns File, line, and detail for each occurrence.
   */
  const problems = (problem: string): { file: string; line: number; detail: string }[] =>
    db
      .prepare(
        `SELECT f.relative_path AS file, l.line_number AS line, x.detail
         FROM line_problems x ${POSITION_JOIN} WHERE x.problem = ? ${CANONICAL_ORDER}, x.id`,
      )
      .all(problem) as { file: string; line: number; detail: string }[];

  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM requests WHERE dedup_key IS NULL) AS unkeyed,
              (SELECT COALESCE(SUM(retry_rate_limits_present), 0) FROM events) AS retry_rate_limits`,
    )
    .get() as { unkeyed: number; retry_rate_limits: number };

  return {
    lines,
    malformed,
    ignored_types: ignoredTypes,
    unkeyed_requests: counts.unkeyed,
    unknown_error_values: unknownErrors,
    missing_fields: problems("missing_field").map(({ file, line, detail }) => ({
      file,
      line,
      field: detail,
    })),
    unparsed_timestamps: problems("unparsed_timestamp").map(({ file, line, detail }) => ({
      file,
      line,
      raw: JSON.parse(detail) as unknown,
    })),
    non_message_iterations: problems("non_message_iteration").map(({ file, line, detail }) => ({
      file,
      line,
      type: detail,
    })),
    retry_rate_limits_present: counts.retry_rate_limits,
  };
}
