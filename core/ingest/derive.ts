/**
 * @file Filling the derived tables from raw lines (docs/development.md P4.4, D-002).
 *
 * Each raw line derives independently of every other line, so new lines can be derived as they
 * arrive, and a full rebuild produces the same rows. Cross-line logic (dedup winners, totals) lives
 * in SQL views over these tables.
 */
import type { Db } from "../db/database.js";
import {
  type EventFields,
  type LineClass,
  type LineLinks,
  type RequestFields,
  classifyLine,
  extractEvent,
  extractLinks,
  extractRequest,
  identityString,
  parseLine,
  parseTimestamp,
} from "./classify.js";
import { resolveResetTime } from "./reset-time.js";
import { deriveNewSpoolLines } from "./spool.js";

/**
 * Version of the derivation rules. Bump it whenever classify.ts or this file changes what a raw line
 * derives to; the next open rebuilds every derived row.
 */
export const PARSER_VERSION = "5";

/** Everything one raw line derives to. */
export interface DerivedLine {
  /** Parsed envelope fields for `parsed_lines`. */
  readonly parsed: {
    readonly lineClass: LineClass;
    readonly sessionId: string | null;
    readonly type: string | null;
    readonly subtype: string | null;
    readonly timestampRaw: string | null;
    readonly timestampUtc: string | null;
    readonly cwd: string | null;
    readonly gitBranch: string | null;
    readonly ccVersion: string | null;
    readonly isSidechain: boolean;
  };
  /** Conversation links (D-021, D-022). */
  readonly links: LineLinks;
  /** Request fields when the line is a request. */
  readonly request: RequestFields | null;
  /** Event fields when the line is an event. */
  readonly event: EventFields | null;
  /** For limit hits: the reset text resolved against the hit's timestamp (D-023), else null. */
  readonly resetAtUtc: string | null;
  /** Problems to report: `[problem, detail]` pairs. */
  readonly problems: readonly (readonly [string, string])[];
}

/** Classes that produce an event row. */
const EVENT_CLASSES: ReadonlySet<LineClass> = new Set([
  "limit_hit",
  "api_error",
  "synthetic_other",
  "retry_notice",
]);

/** Links of a line that didn't parse. */
const NO_LINKS: LineLinks = {
  uuid: null,
  parentUuid: null,
  originKind: null,
  userContent: null,
  isMeta: false,
};

/**
 * Returns a value when it's a string, else null.
 * @param value - Any parsed JSON value.
 * @returns The string or null.
 */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Derives every row one raw line produces. Pure: no database access.
 * @param bytes - The raw line's exact bytes.
 * @returns Parsed fields, optional request and event fields, and problems.
 */
export function deriveLine(bytes: Buffer): DerivedLine {
  const line = parseLine(bytes);
  const lineClass = classifyLine(line);
  if (line === null) {
    return {
      parsed: {
        lineClass,
        sessionId: null,
        type: null,
        subtype: null,
        timestampRaw: null,
        timestampUtc: null,
        cwd: null,
        gitBranch: null,
        ccVersion: null,
        isSidechain: false,
      },
      links: NO_LINKS,
      request: null,
      event: null,
      resetAtUtc: null,
      problems: [],
    };
  }
  const timestamp = parseTimestamp(line["timestamp"]);
  const problems: [string, string][] = [];
  let request: RequestFields | null = null;
  if (lineClass === "request") {
    request = extractRequest(line);
    for (const field of request.missingFields) {
      problems.push(["missing_field", field]);
    }
    // The raw value is kept as JSON text so a number, null, or absent timestamp stays distinguishable.
    if (timestamp === null) {
      problems.push(["unparsed_timestamp", JSON.stringify(line["timestamp"] ?? null)]);
    }
    for (const type of request.nonMessageIterations) {
      problems.push(["non_message_iteration", type]);
    }
  }
  const event = EVENT_CLASSES.has(lineClass) ? extractEvent(line, lineClass) : null;
  // Only limit hits carry reset text, so every other event resolves to null here.
  const textResetAtUtc = resolveResetTime(event?.resetText ?? null, timestamp?.utc ?? null);
  if (event !== null) {
    problems.push(...quotaProblems(event, textResetAtUtc));
  }
  return {
    parsed: {
      lineClass,
      sessionId: identityString(line["sessionId"]),
      type: identityString(line["type"]),
      subtype: stringOrNull(line["subtype"]),
      timestampRaw: line["timestamp"] === undefined ? null : JSON.stringify(line["timestamp"]),
      timestampUtc: timestamp?.utc ?? null,
      cwd: stringOrNull(line["cwd"]),
      gitBranch: stringOrNull(line["gitBranch"]),
      ccVersion: stringOrNull(line["version"]),
      isSidechain: line["isSidechain"] === true,
    },
    links: extractLinks(line),
    request,
    event,
    resetAtUtc: textResetAtUtc,
    problems,
  };
}

/**
 * Lists what's wrong with a limit hit's `quotaLimits` (D-067): unusable members, and a window or
 * reset that disagrees with the message text. Nothing is corrected here; the views prefer the
 * structured fields, and these problems say where the two sources differed.
 * @param event - The line's event fields.
 * @param textResetAtUtc - The reset text resolved against the hit's timestamp, or null.
 * @returns `[problem, detail]` pairs; empty for lines that aren't limit hits.
 */
export function quotaProblems(
  event: EventFields,
  textResetAtUtc: string | null,
): [string, string][] {
  const problems: [string, string][] = event.quota.unusable.map((field) => [
    "unusable_quota_field",
    field,
  ]);
  const quotaWindow = event.quota.window;
  if (quotaWindow !== null && event.window !== null && quotaWindow !== event.window) {
    problems.push(["quota_window_disagrees", `quotaLimits=${quotaWindow} text=${event.window}`]);
  }
  const quotaReset = event.quota.resetsAtUtc;
  // Reset text has minute precision, so only a gap of a minute or more is a disagreement.
  if (
    quotaReset !== null &&
    textResetAtUtc !== null &&
    Math.abs(Date.parse(quotaReset) - Date.parse(textResetAtUtc)) >= 60_000
  ) {
    problems.push(["quota_reset_disagrees", `quotaLimits=${quotaReset} text=${textResetAtUtc}`]);
  }
  return problems;
}

/**
 * Derives and stores rows for every session-log raw line that has none yet. Spool lines are
 * derived by `deriveNewSpoolLines` instead.
 * @param db - Open, migrated database.
 * @returns Number of log lines derived.
 */
export function deriveNewLines(db: Db): number {
  const pending = db
    .prepare(
      `SELECT l.id, l.bytes FROM raw_lines l
       JOIN source_files f ON f.id = l.source_file_id AND f.kind = 'log'
       LEFT JOIN parsed_lines p ON p.raw_line_id = l.id
       WHERE p.raw_line_id IS NULL ORDER BY l.id`,
    )
    .all() as { id: number; bytes: Buffer }[];
  const insertParsed = db.prepare(
    "INSERT INTO parsed_lines (raw_line_id, class, session_id, type, subtype, timestamp_raw, timestamp_utc, cwd, git_branch, cc_version, is_sidechain, uuid, parent_uuid, origin_kind, user_content, is_meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertRequest = db.prepare(
    "INSERT INTO requests (raw_line_id, dedup_key, message_id, request_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_write_unsplit_tokens, speed, service_tier, inference_geo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertEvent = db.prepare(
    "INSERT INTO events (raw_line_id, class, error, api_error_status, window, reset_text, unknown_error_key, retry_rate_limits_present, reset_at_utc, quota_window, quota_resets_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertProblem = db.prepare(
    "INSERT INTO line_problems (raw_line_id, problem, detail) VALUES (?, ?, ?)",
  );
  db.transaction(() => {
    for (const { id, bytes } of pending) {
      const derived = deriveLine(bytes);
      const p = derived.parsed;
      insertParsed.run(
        id,
        p.lineClass,
        p.sessionId,
        p.type,
        p.subtype,
        p.timestampRaw,
        p.timestampUtc,
        p.cwd,
        p.gitBranch,
        p.ccVersion,
        p.isSidechain ? 1 : 0,
        derived.links.uuid,
        derived.links.parentUuid,
        derived.links.originKind,
        derived.links.userContent,
        derived.links.isMeta ? 1 : 0,
      );
      const r = derived.request;
      if (r !== null) {
        insertRequest.run(
          id,
          r.dedupKey,
          r.messageId,
          r.requestId,
          r.model,
          r.inputTokens,
          r.outputTokens,
          r.cacheReadTokens,
          r.cacheWrite5mTokens,
          r.cacheWrite1hTokens,
          r.cacheWriteUnsplitTokens,
          r.speed,
          r.serviceTier,
          r.inferenceGeo,
        );
      }
      const e = derived.event;
      if (e !== null) {
        insertEvent.run(
          id,
          p.lineClass,
          e.error,
          e.apiErrorStatus,
          e.window,
          e.resetText,
          e.unknownErrorKey,
          e.retryRateLimitsPresent ? 1 : 0,
          derived.resetAtUtc,
          e.quota.window,
          e.quota.resetsAtUtc,
        );
      }
      for (const [problem, detail] of derived.problems) {
        insertProblem.run(id, problem, detail);
      }
    }
  })();
  return pending.length;
}

/** Derived tables, in the order they're cleared (children before parents). */
export const DERIVED_TABLES = [
  "line_problems",
  "events",
  "requests",
  "parsed_lines",
  "rate_limit_windows",
  "status_readings",
] as const;

/**
 * Deletes every derived row and derives again from raw lines, recording the parser version.
 * @param db - Open, migrated database.
 * @returns Number of raw lines derived (log and spool).
 */
export function rebuildDerived(db: Db): number {
  return db.transaction(() => {
    for (const table of DERIVED_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    const count = deriveNewLines(db) + deriveNewSpoolLines(db);
    db.prepare(
      "INSERT INTO derive_meta (key, value) VALUES ('parser_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).run(PARSER_VERSION);
    return count;
  })();
}

/**
 * Brings derived tables up to date: a full rebuild if the parser version changed, otherwise only
 * the raw lines not yet derived.
 * @param db - Open, migrated database.
 * @returns Number of raw lines derived and whether a rebuild happened.
 */
export function ensureDerived(db: Db): { derived: number; rebuilt: boolean } {
  const row = db.prepare("SELECT value FROM derive_meta WHERE key = 'parser_version'").get() as
    { value: string } | undefined;
  if (row?.value !== PARSER_VERSION) {
    return { derived: rebuildDerived(db), rebuilt: true };
  }
  return { derived: deriveNewLines(db) + deriveNewSpoolLines(db), rebuilt: false };
}
