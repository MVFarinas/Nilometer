/**
 * @file Decoding and validating status line spool lines (docs/development.md P4.7, D-008, D-018).
 *
 * The hook writes `{"captured_at_s":N,"hook_version":N,"payload_b64":"..."}` per turn without
 * looking inside the payload. Every check happens here, and every problem is recorded rather than
 * repaired (`statusline-collector` skill, "Ingesting the spool"): a malformed or interleaved line, a
 * payload that isn't base64 or isn't JSON, and window values out of range. Monitor clamps
 * percentages up to 101 down to 100; this module doesn't.
 */
import type { Db } from "../db/database.js";
import { type LogObject, isNumber, isObject, objectField } from "./classify.js";

/** Rate-limit windows the payload is documented to carry. */
export const KNOWN_WINDOWS = ["five_hour", "seven_day", "spend_limit"] as const;

/** Outcome of decoding one spool line. */
export type SpoolLineStatus =
  "ok" | "malformed_line" | "malformed_payload_encoding" | "malformed_payload";

/** A decoded spool line. */
export interface DecodedSpoolLine {
  /** Whether the line, its encoding, and its payload were all valid. */
  readonly status: SpoolLineStatus;
  /** `captured_at_s`, when the line itself parsed. */
  readonly capturedAtS: number | null;
  /** `hook_version`, when the line itself parsed. */
  readonly hookVersion: number | null;
  /** The decoded payload object, only when status is `ok`. */
  readonly payload: LogObject | null;
}

/** Strict base64: standard alphabet, correct padding, length a multiple of four. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decodes one spool line.
 * @param bytes - The raw spool line.
 * @returns The status and, as far as decoding got, the capture time, hook version, and payload.
 */
export function decodeSpoolLine(bytes: Buffer): DecodedSpoolLine {
  let line: unknown;
  try {
    line = JSON.parse(bytes.toString("utf8"));
  } catch {
    line = null;
  }
  // Lines from concurrent sessions can interleave (D-018); they fail here and are reported.
  if (
    !isObject(line) ||
    !isNumber(line["captured_at_s"]) ||
    !isNumber(line["hook_version"]) ||
    typeof line["payload_b64"] !== "string"
  ) {
    return { status: "malformed_line", capturedAtS: null, hookVersion: null, payload: null };
  }
  const header = { capturedAtS: line["captured_at_s"], hookVersion: line["hook_version"] };
  const encoded = line["payload_b64"];
  // Buffer.from(..., "base64") silently skips invalid characters, so validate first.
  if (!BASE64.test(encoded)) {
    return { status: "malformed_payload_encoding", ...header, payload: null };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    payload = null;
  }
  if (!isObject(payload)) {
    return { status: "malformed_payload", ...header, payload: null };
  }
  return { status: "ok", ...header, payload };
}

/** Why a window's values can't be used, or `valid`. */
export type WindowValidity =
  | "valid"
  | "invalid_percentage"
  | "invalid_epoch_in_percentage"
  | "invalid_resets_at"
  | "unknown_window";

/** One rate-limit window from a payload, as written, with its validity. */
export interface WindowReading {
  /** Window name, the key under `rate_limits`. */
  readonly window: string;
  /** `used_percentage` when it's a number, else null. */
  readonly usedPercentage: number | null;
  /** `resets_at` when it's a number, else null. */
  readonly resetsAt: number | null;
  /** `valid`, or the first problem found. */
  readonly validity: WindowValidity;
}

/** Epoch seconds below this are implausible for a reset time (2001-09-09). */
export const MIN_EPOCH_SECONDS = 1_000_000_000;

/** Epoch seconds at or above this are implausible for a reset time (2286-11-20). */
export const MAX_EPOCH_SECONDS = 10_000_000_000;

/**
 * Validates one window's values.
 * @param window - The window name.
 * @param value - The value under `rate_limits.<window>`.
 * @returns The values as written with a validity label.
 */
export function validateWindow(window: string, value: LogObject): WindowReading {
  const percentage = value["used_percentage"];
  const resets = value["resets_at"];
  const usedPercentage = isNumber(percentage) ? percentage : null;
  const resetsAt = isNumber(resets) ? resets : null;
  /**
   * Builds the reading with a validity label.
   * @param validity - The label.
   * @returns The window reading.
   */
  const reading = (validity: WindowValidity): WindowReading => ({
    window,
    usedPercentage,
    resetsAt,
    validity,
  });
  if (!(KNOWN_WINDOWS as readonly string[]).includes(window)) {
    return reading("unknown_window");
  }
  if (usedPercentage === null) {
    return reading("invalid_percentage");
  }
  // Claude Code bug #52326 (reported via Monitor): the reset epoch sometimes lands in the percentage.
  if (usedPercentage >= MIN_EPOCH_SECONDS) {
    return reading("invalid_epoch_in_percentage");
  }
  // A spend limit may legitimately exceed 100% once exceeded (statusline docs); plan windows can't.
  if (usedPercentage < 0 || (window !== "spend_limit" && usedPercentage > 100)) {
    return reading("invalid_percentage");
  }
  if (resetsAt === null || resetsAt < MIN_EPOCH_SECONDS || resetsAt >= MAX_EPOCH_SECONDS) {
    return reading("invalid_resets_at");
  }
  return reading("valid");
}

/** Everything one spool line derives to. */
export interface DerivedReading {
  /** Row for `status_readings`. */
  readonly reading: {
    readonly status: SpoolLineStatus;
    readonly capturedAtS: number | null;
    readonly hookVersion: number | null;
    readonly sessionId: string | null;
    readonly transcriptPath: string | null;
    readonly modelId: string | null;
    readonly ccVersion: string | null;
    readonly costTotalUsd: number | null;
    readonly hasRateLimits: boolean;
  };
  /** Rows for `rate_limit_windows`; empty when `rate_limits` is absent (never recorded as 0). */
  readonly windows: readonly WindowReading[];
}

/**
 * Returns a value when it's a string, else null.
 * @param value - Any parsed JSON value.
 * @returns The string or null.
 */
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Derives the reading and its windows from one spool line. Pure: no database access.
 * @param bytes - The raw spool line.
 * @returns The reading row and one window row per object-valued key under `rate_limits`.
 */
export function deriveSpoolLine(bytes: Buffer): DerivedReading {
  const decoded = decodeSpoolLine(bytes);
  const payload = decoded.payload ?? {};
  const rateLimits = objectField(payload, "rate_limits");
  const cost = objectField(payload, "cost")?.["total_cost_usd"];
  return {
    reading: {
      status: decoded.status,
      capturedAtS: decoded.capturedAtS,
      hookVersion: decoded.hookVersion,
      sessionId: stringOrNull(payload["session_id"]),
      transcriptPath: stringOrNull(payload["transcript_path"]),
      modelId: stringOrNull(objectField(payload, "model")?.["id"]),
      ccVersion: stringOrNull(payload["version"]),
      costTotalUsd: isNumber(cost) ? cost : null,
      hasRateLimits: rateLimits !== null,
    },
    // A missing window means it reset or isn't reported: no row, and no carried-forward value.
    windows:
      rateLimits === null
        ? []
        : Object.entries(rateLimits)
            .filter((entry): entry is [string, LogObject] => isObject(entry[1]))
            .map(([window, value]) => validateWindow(window, value)),
  };
}

/**
 * Derives and stores readings for every spool raw line that has none yet.
 * @param db - Open, migrated database.
 * @returns Number of spool lines derived.
 */
export function deriveNewSpoolLines(db: Db): number {
  const pending = db
    .prepare(
      `SELECT l.id, l.bytes FROM raw_lines l
       JOIN source_files f ON f.id = l.source_file_id AND f.kind = 'spool'
       LEFT JOIN status_readings s ON s.raw_line_id = l.id
       WHERE s.raw_line_id IS NULL ORDER BY l.id`,
    )
    .all() as { id: number; bytes: Buffer }[];
  const insertReading = db.prepare(
    "INSERT INTO status_readings (raw_line_id, status, captured_at_s, hook_version, session_id, transcript_path, model_id, cc_version, cost_total_usd, has_rate_limits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertWindow = db.prepare(
    "INSERT INTO rate_limit_windows (raw_line_id, window, used_percentage, resets_at, validity) VALUES (?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const { id, bytes } of pending) {
      const { reading: r, windows } = deriveSpoolLine(bytes);
      insertReading.run(
        id,
        r.status,
        r.capturedAtS,
        r.hookVersion,
        r.sessionId,
        r.transcriptPath,
        r.modelId,
        r.ccVersion,
        r.costTotalUsd,
        r.hasRateLimits ? 1 : 0,
      );
      for (const w of windows) {
        insertWindow.run(id, w.window, w.usedPercentage, w.resetsAt, w.validity);
      }
    }
  })();
  return pending.length;
}
