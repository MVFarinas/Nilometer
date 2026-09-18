/**
 * @file Classifying raw log lines and extracting their fields (docs/development.md P4.4).
 *
 * Implements the rules in fixtures/README.md, which restate D-001 (dedup key), D-004 (limit hits
 * from structured fields), D-007 (per-request timestamps), and D-019 (retry notices), plus the
 * conversation links D-021 and D-022 read (not part of expected.json). Every function
 * here is pure: bytes or a parsed object in, plain values out. Nothing touches the database, so the
 * rules can be tested line by line, and the fidelity suite compares their combined output with an
 * independent Python implementation of the same spec.
 */

/** A parsed log line: a JSON object with unknown fields. */
export type LogObject = Readonly<Record<string, unknown>>;

/** The seven line classes, in the order they are tested. */
export const LINE_CLASSES = [
  "malformed",
  "limit_hit",
  "api_error",
  "synthetic_other",
  "request",
  "retry_notice",
  "ignored_type",
] as const;

/** One line class. */
export type LineClass = (typeof LINE_CLASSES)[number];

/** Label used wherever a required string is absent or not a string. */
export const MISSING = "<missing>";

/**
 * Parses a raw line as a JSON object.
 * @param bytes - The exact line bytes.
 * @returns The object, or null when the line isn't valid JSON or isn't an object (arrays and
 *   primitives included). An empty line is invalid JSON, so it's null too.
 */
export function parseLine(bytes: Buffer): LogObject | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  return isObject(value) ? value : null;
}

/**
 * Reports whether a value is a plain JSON object.
 * @param value - Any parsed JSON value.
 * @returns True for objects; false for arrays, null, and primitives.
 */
export function isObject(value: unknown): value is LogObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a nested object field.
 * @param container - The value to read from.
 * @param key - Field name.
 * @returns The field if it's an object, else null.
 */
export function objectField(container: unknown, key: string): LogObject | null {
  if (!isObject(container)) {
    return null;
  }
  const value = container[key];
  return isObject(value) ? value : null;
}

/**
 * Reports whether a value is a JSON number. Booleans, strings, and null are not numbers here.
 * @param value - Any parsed JSON value.
 * @returns True only for numbers.
 */
export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/**
 * Returns a string field, or the missing label when it's absent or not a string.
 * @param value - Any parsed JSON value.
 * @returns The string itself, or {@link MISSING}.
 */
export function identityString(value: unknown): string {
  return typeof value === "string" ? value : MISSING;
}

/**
 * Returns a string, or null when the value isn't a non-empty string.
 * @param value - Any parsed JSON value.
 * @returns The string, or null for absent, empty, or non-string values.
 */
export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Classifies one line. The first matching rule wins (fixtures/README.md, Classification).
 * @param line - The parsed object, or null for a line that didn't parse.
 * @returns The line's class.
 */
export function classifyLine(line: LogObject | null): LineClass {
  if (line === null) {
    return "malformed";
  }
  // Error lines are tested before the request test: synthetic error lines carry a zero usage
  // object and would otherwise look like requests (D-004).
  if (line["isApiErrorMessage"] === true) {
    return line["error"] === "rate_limit" ? "limit_hit" : "api_error";
  }
  const message = objectField(line, "message");
  if (message?.["model"] === "<synthetic>") {
    return "synthetic_other";
  }
  if (line["type"] === "assistant" && objectField(message, "usage") !== null) {
    return "request";
  }
  if (line["type"] === "system" && line["subtype"] === "api_error") {
    return "retry_notice";
  }
  return "ignored_type";
}

/**
 * Builds the D-001 dedup key for a request line.
 * @param line - A request line.
 * @returns `"<session>/m/<message.id>"`, else `"<session>/r/<requestId>"`, else null (unkeyed).
 */
export function dedupKey(line: LogObject): string | null {
  const session = identityString(line["sessionId"]);
  const messageId = nonEmptyString(objectField(line, "message")?.["id"]);
  if (messageId !== null) {
    return `${session}/m/${messageId}`;
  }
  const requestId = nonEmptyString(line["requestId"]);
  // No invented key when both IDs are missing: the line passes through and gets reported.
  return requestId === null ? null : `${session}/r/${requestId}`;
}

/** Token counts and identifiers of one request line. */
export interface RequestFields {
  /** D-001 key, or null when unkeyed. */
  readonly dedupKey: string | null;
  /** `message.id` when it's a string, else null. */
  readonly messageId: string | null;
  /** `requestId` when it's a string, else null. */
  readonly requestId: string | null;
  /** `message.model`, or the missing label. */
  readonly model: string;
  /** `usage.input_tokens`, 0 when not a number. */
  readonly inputTokens: number;
  /** `usage.output_tokens`, 0 when not a number. */
  readonly outputTokens: number;
  /** `usage.cache_read_input_tokens`, 0 when not a number. */
  readonly cacheReadTokens: number;
  /** 5-minute cache writes when the split object exists, else null. */
  readonly cacheWrite5mTokens: number | null;
  /** 1-hour cache writes when the split object exists, else null. */
  readonly cacheWrite1hTokens: number | null;
  /** `cache_creation_input_tokens` when the split object is absent, else null. */
  readonly cacheWriteUnsplitTokens: number | null;
  /** `usage.speed` when it's a string, else null. */
  readonly speed: string | null;
  /** `usage.service_tier` when it's a string, else null. */
  readonly serviceTier: string | null;
  /** `usage.inference_geo` when it's a string, else null (`"us"` costs 1.1×, D-020). */
  readonly inferenceGeo: string | null;
  /** Reported token fields that were missing or non-numeric, by log field name. */
  readonly missingFields: readonly string[];
  /** `type` of each `usage.iterations[]` entry whose type isn't `"message"`. */
  readonly nonMessageIterations: readonly string[];
}

/** The three token fields whose absence is reported, with their log names. */
const REPORTED_TOKEN_FIELDS = [
  ["inputTokens", "input_tokens"],
  ["outputTokens", "output_tokens"],
  ["cacheReadTokens", "cache_read_input_tokens"],
] as const;

/**
 * Extracts request fields from a request line.
 * @param line - A line classified as `request`.
 * @returns The fields, with missing numbers defaulted and listed.
 */
export function extractRequest(line: LogObject): RequestFields {
  const message = objectField(line, "message");
  const usage = objectField(message, "usage") ?? {};
  const missingFields: string[] = [];
  const counts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  for (const [key, logName] of REPORTED_TOKEN_FIELDS) {
    const value = usage[logName];
    if (isNumber(value)) {
      counts[key] = value;
    } else {
      missingFields.push(logName);
    }
  }
  const split = objectField(usage, "cache_creation");
  /**
   * Reads a cache-write count, defaulting silently to 0 (only the three token fields are reported).
   * @param value - The raw value.
   * @returns The number, or 0.
   */
  const cacheCount = (value: unknown): number => (isNumber(value) ? value : 0);
  const iterations = Array.isArray(usage["iterations"]) ? (usage["iterations"] as unknown[]) : [];
  return {
    dedupKey: dedupKey(line),
    messageId: typeof message?.["id"] === "string" ? message["id"] : null,
    requestId: typeof line["requestId"] === "string" ? line["requestId"] : null,
    model: identityString(message?.["model"]),
    ...counts,
    // The split object decides the form: split fields, or one unsplit total from older logs.
    cacheWrite5mTokens: split === null ? null : cacheCount(split["ephemeral_5m_input_tokens"]),
    cacheWrite1hTokens: split === null ? null : cacheCount(split["ephemeral_1h_input_tokens"]),
    cacheWriteUnsplitTokens:
      split === null ? cacheCount(usage["cache_creation_input_tokens"]) : null,
    speed: typeof usage["speed"] === "string" ? usage["speed"] : null,
    serviceTier: typeof usage["service_tier"] === "string" ? usage["service_tier"] : null,
    inferenceGeo: typeof usage["inference_geo"] === "string" ? usage["inference_geo"] : null,
    missingFields,
    nonMessageIterations: iterations
      .filter((iteration) => isObject(iteration) && iteration["type"] !== "message")
      .map((iteration) => identityString((iteration as LogObject)["type"])),
  };
}

/** A timestamp that parsed. */
export interface ParsedTimestamp {
  /** The instant in UTC, `YYYY-MM-DDTHH:MM:SS.sssZ` (fractions beyond milliseconds truncated). */
  readonly utc: string;
  /** The UTC calendar day, `YYYY-MM-DD`. */
  readonly day: string;
}

/** Strict ISO-8601 pattern from fixtures/README.md: seconds required, uppercase Z or ±HH:MM. */
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Parses a timestamp strictly.
 * @param raw - The raw `timestamp` value.
 * @returns The UTC instant and day, or null when the value isn't a string in the required format
 *   with every part in range (a real date, hour 00–23, minute and second 00–59, offset hour 00–23,
 *   offset minute 00–59).
 * @example
 * parseTimestamp("2026-09-02T01:30:00.000+02:00"); // { utc: "2026-09-01T23:30:00.000Z", day: "2026-09-01" }
 */
export function parseTimestamp(raw: unknown): ParsedTimestamp | null {
  if (typeof raw !== "string") {
    return null;
  }
  const match = TIMESTAMP.exec(raw);
  if (match === null) {
    return null;
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const fraction = match[7] ?? "";
  const sign = match[9] === "-" ? -1 : 1;
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return null;
  }
  // Date.UTC silently rolls over invalid dates (Feb 30 → Mar 2); reading the parts back catches that.
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day
  ) {
    return null;
  }
  // Milliseconds from the first three fraction digits; finer precision is kept in the raw string.
  const millis = Number(fraction.padEnd(3, "0").slice(0, 3));
  const utcMs = local.getTime() + millis - sign * (offsetHour * 60 + offsetMinute) * 60_000;
  const utc = new Date(utcMs).toISOString();
  return { utc, day: utc.slice(0, 10) };
}

/**
 * Joins a message's text the way fixtures/README.md defines it.
 * @param line - Any parsed line.
 * @returns Concatenated `content[].text` strings for list content, the string itself for string
 *   content, otherwise an empty string.
 */
export function messageText(line: LogObject): string {
  const content = objectField(line, "message")?.["content"];
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => (isObject(part) && typeof part["text"] === "string" ? part["text"] : ""))
    .join("");
}

/** Window and reset time parsed from a limit message. */
export interface LimitText {
  /** `five_hour`, `seven_day`, or null when the text doesn't say. */
  readonly window: "five_hour" | "seven_day" | null;
  /** Text after the first `resets `, trimmed; null when absent or empty. */
  readonly resetText: string | null;
}

/**
 * Parses a limit message's window and reset time. Matching ignores case.
 * @param text - The message text.
 * @returns The window (session and 5-hour wording checked before weekly) and the reset text.
 * @example
 * parseLimitText("You've hit your session limit · resets 6:10am (UTC)");
 * // { window: "five_hour", resetText: "6:10am (UTC)" }
 */
export function parseLimitText(text: string): LimitText {
  const lower = text.toLowerCase();
  const window =
    lower.includes("session limit") || lower.includes("5-hour limit")
      ? "five_hour"
      : lower.includes("weekly limit")
        ? "seven_day"
        : null;
  const at = lower.indexOf("resets ");
  const reset = at === -1 ? "" : text.slice(at + "resets ".length).trim();
  return { window, resetText: reset === "" ? null : reset };
}

/** Fields of one event line (limit hit, API error, other synthetic line, or retry notice). */
export interface EventFields {
  /** Top-level `error` when it's a string, else null. */
  readonly error: string | null;
  /** `apiErrorStatus`, else (retry notices only) `error.status`, when numeric; else null. */
  readonly apiErrorStatus: number | null;
  /** Limit window, for limit hits only. */
  readonly window: LimitText["window"];
  /** Reset text, for limit hits only. */
  readonly resetText: string | null;
  /** Report label for an API error's unrecognized or missing `error`; null otherwise. */
  readonly unknownErrorKey: string | null;
  /** For retry notices: whether `error.rateLimits` is present and not null. */
  readonly retryRateLimitsPresent: boolean;
}

/**
 * Extracts event fields from a line of an event class.
 * @param line - The parsed line.
 * @param lineClass - Its class: `limit_hit`, `api_error`, `synthetic_other`, or `retry_notice`.
 * @returns The event fields.
 */
export function extractEvent(line: LogObject, lineClass: LineClass): EventFields {
  const errorObject = objectField(line, "error");
  const status = isNumber(line["apiErrorStatus"])
    ? line["apiErrorStatus"]
    : lineClass === "retry_notice" && isNumber(errorObject?.["status"])
      ? errorObject["status"]
      : null;
  const limit =
    lineClass === "limit_hit"
      ? parseLimitText(messageText(line))
      : { window: null, resetText: null };
  const error = typeof line["error"] === "string" ? line["error"] : null;
  return {
    error,
    apiErrorStatus: status,
    window: limit.window,
    resetText: limit.resetText,
    unknownErrorKey:
      lineClass === "api_error" && error !== "server_error" ? (error ?? MISSING) : null,
    retryRateLimitsPresent:
      lineClass === "retry_notice" &&
      errorObject !== null &&
      Object.hasOwn(errorObject, "rateLimits") &&
      errorObject["rateLimits"] !== null,
  };
}

/** How a line sits in its conversation, for interruption metrics (D-021, D-022). */
export interface LineLinks {
  /** `uuid` when it's a non-empty string, else null. */
  readonly uuid: string | null;
  /** `parentUuid` when it's a non-empty string, else null: the message this line answers. */
  readonly parentUuid: string | null;
  /** `origin.kind` when it's a string, else null (e.g. `human`, `task-notification`). */
  readonly originKind: string | null;
  /**
   * For `type: "user"` lines: `tool_result` when `message.content` is a list holding a block of
   * that type, `prompt` for string content or any other list; null for other lines or content.
   */
  readonly userContent: "tool_result" | "prompt" | null;
  /** `isMeta === true`. */
  readonly isMeta: boolean;
}

/**
 * Extracts a line's conversation links.
 * @param line - Any parsed line.
 * @returns The links; absent or mistyped fields are null (or false for `isMeta`).
 */
export function extractLinks(line: LogObject): LineLinks {
  const content = objectField(line, "message")?.["content"];
  let userContent: LineLinks["userContent"] = null;
  if (line["type"] === "user") {
    if (typeof content === "string") {
      userContent = "prompt";
    } else if (Array.isArray(content)) {
      userContent = content.some((block) => isObject(block) && block["type"] === "tool_result")
        ? "tool_result"
        : "prompt";
    }
  }
  const originKind = objectField(line, "origin")?.["kind"];
  return {
    uuid: nonEmptyString(line["uuid"]),
    parentUuid: nonEmptyString(line["parentUuid"]),
    originKind: typeof originKind === "string" ? originKind : null,
    userContent,
    isMeta: line["isMeta"] === true,
  };
}

/**
 * Builds the ignored-type label for a line.
 * @param line - A line classified as `ignored_type`.
 * @returns `type`, or `type/subtype` when `subtype` is a string; a missing type is {@link MISSING}.
 */
export function ignoredTypeKey(line: LogObject): string {
  const type = identityString(line["type"]);
  return typeof line["subtype"] === "string" ? `${type}/${line["subtype"]}` : type;
}
