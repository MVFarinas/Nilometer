/**
 * @file Scrubbing a line for another machine to read (D-103, step G7.1).
 *
 * A machine's export carries its log and spool lines with every field the classifier and the views
 * read, and nothing else: no prompt, response, tool input or output, file path or working directory.
 * Every other machine then reads the export with the same reader and classifier as its own logs, so
 * every view treats an imported line exactly as it treats a local one. The test of this file's
 * allowlist is that views built from scrubbed lines equal views built from the full lines, apart from
 * the columns it removes on purpose (`cwd`, `git_branch`, `transcript_path`).
 */
import { createHash } from "node:crypto";

import { type LogObject, isObject, parseLine } from "../ingest/classify.js";
import { decodeSpoolLine } from "../ingest/spool.js";

/** Top-level log fields kept as written: identity, time, structure, and the event fields D-004 to D-080 read. */
const LOG_FIELDS = [
  "type",
  "subtype",
  "sessionId",
  "timestamp",
  "version",
  "isSidechain",
  "uuid",
  "parentUuid",
  "isMeta",
  "isApiErrorMessage",
  "apiErrorStatus",
  "requestId",
  "originalModel",
  "fallbackModel",
  "apiRefusalCategory",
] as const;

/**
 * Copies the named own keys of an object, skipping those it doesn't have.
 * @param source - The object.
 * @param keys - Keys to keep.
 * @returns A new object holding only those keys.
 */
function pick(source: LogObject, keys: readonly string[]): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) {
      kept[key] = source[key];
    }
  }
  return kept;
}

/**
 * Keeps a field that should be an object to only the given keys. A value of another type is kept as
 * written when it isn't a string, so a malformed field is still reported as one on the other machine,
 * and replaced by an empty string when it is, so no text travels.
 * @param value - The field's value.
 * @param keys - Keys to keep when it's an object.
 * @returns The scrubbed value.
 */
function pickObject(value: unknown, keys: readonly string[]): unknown {
  if (isObject(value)) {
    return pick(value, keys);
  }
  return typeof value === "string" ? "" : value;
}

/**
 * Reduces message content to its shape: block types only, never text. A string becomes an empty
 * string, which the classifier still reads as a prompt (D-021).
 * @param content - `message.content` as written.
 * @returns Its shape.
 */
function contentShape(content: unknown): unknown {
  if (typeof content === "string") {
    return "";
  }
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((block) => (isObject(block) ? pick(block, ["type"]) : null));
}

/**
 * Scrubs one parsed session-log line.
 *
 * Kept: {@link LOG_FIELDS}; `message.id`, `message.model` and `message.usage` (token counts, speed,
 * tier and region; no text); content block types; `origin.kind`; `attachment.type` and
 * `attachment.commandMode` (D-076); `quotaLimits`' two fields (D-067); a retry notice's status,
 * `rateLimits` presence and `isNetworkDown` (D-019). An API error line's own text is kept in full: it's
 * Claude Code's notice ("You've hit your session limit · resets 6:10am"), the only place a limit
 * hit's window and reset are written in older logs (D-004).
 * @param line - The parsed line.
 * @returns The scrubbed line.
 */
export function scrubLogLine(line: LogObject): Record<string, unknown> {
  const kept = pick(line, LOG_FIELDS);
  if (Object.hasOwn(line, "error")) {
    const error = line["error"];
    // A retry notice's error is an object; its formatted text stays behind, only whether rate
    // limits were present travels (retry_rate_limits_present).
    kept["error"] = isObject(error)
      ? {
          ...pick(error, ["status", "isNetworkDown"]),
          ...(Object.hasOwn(error, "rateLimits")
            ? { rateLimits: error["rateLimits"] === null ? null : {} }
            : {}),
        }
      : error;
  }
  if (Object.hasOwn(line, "quotaLimits")) {
    kept["quotaLimits"] = pickObject(line["quotaLimits"], ["rateLimitType", "resetsAt"]);
  }
  if (Object.hasOwn(line, "origin")) {
    kept["origin"] = pickObject(line["origin"], ["kind"]);
  }
  if (Object.hasOwn(line, "attachment")) {
    kept["attachment"] = pickObject(line["attachment"], ["type", "commandMode"]);
  }
  const message = line["message"];
  if (isObject(message)) {
    const scrubbed = pick(message, ["id", "model", "usage"]);
    if (Object.hasOwn(message, "content")) {
      // Claude Code's own error notice keeps its text; anything a person or a model wrote doesn't.
      scrubbed["content"] =
        line["isApiErrorMessage"] === true ? message["content"] : contentShape(message["content"]);
    }
    kept["message"] = scrubbed;
  } else if (Object.hasOwn(line, "message")) {
    kept["message"] = typeof message === "string" ? "" : message;
  }
  return kept;
}

/** Status line payload fields kept: the session, model, version, cost cross-check, and the windows. */
const PAYLOAD_FIELDS = ["session_id", "version", "rate_limits"] as const;

/**
 * Scrubs one spool line: the hook's header as written, and a payload holding only what
 * `status_readings` and `rate_limit_windows` read, without `transcript_path`, `cwd` or `workspace`.
 * @param bytes - The spool line's bytes.
 * @returns The scrubbed line, or null for a line the hook didn't write whole (interleaved, or a bad
 *   payload): those are reported on their own machine and aren't sent on.
 */
export function scrubSpoolLine(bytes: Buffer): Record<string, unknown> | null {
  const decoded = decodeSpoolLine(bytes);
  if (decoded.status !== "ok" || decoded.payload === null) {
    return null;
  }
  const payload = decoded.payload;
  const kept = pick(payload, PAYLOAD_FIELDS);
  if (Object.hasOwn(payload, "model")) {
    kept["model"] = pickObject(payload["model"], ["id"]);
  }
  if (Object.hasOwn(payload, "cost")) {
    kept["cost"] = pickObject(payload["cost"], ["total_cost_usd"]);
  }
  return {
    captured_at_s: decoded.capturedAtS,
    hook_version: decoded.hookVersion,
    payload_b64: Buffer.from(JSON.stringify(kept), "utf8").toString("base64"),
  };
}

/**
 * The field carrying a line's identity on the machine that exported it: a hash of its source file's
 * path and its bytes ({@link lineOrigin}). Two lines that differ only in what the scrub removes (two
 * retry notices with different text, say) would otherwise become identical, and a reader stores
 * identical lines in one file once; the origin keeps them apart, as they are on their own machine. It
 * also doesn't change when the exporting database is rebuilt, so a line written again is recognised
 * and stored once (machine_lines).
 */
export const EXPORT_LINE_FIELD = "nilometerLine";

/**
 * A line's identity for the export: its file and its content, as the reader stores it locally
 * (UNIQUE source file and content hash). The path is hashed, so it doesn't travel.
 * @param relativePath - The line's source file, relative to its root.
 * @param contentHash - `raw_lines.content_hash`.
 * @returns 32 lowercase hex characters.
 */
export function lineOrigin(relativePath: string, contentHash: string): string {
  return createHash("sha256")
    .update(`${relativePath}\n${contentHash}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * Scrubs one stored line of either kind.
 * @param kind - `log` or `spool`.
 * @param bytes - The line's bytes.
 * @param origin - The line's identity, from {@link lineOrigin}.
 * @returns The scrubbed line as one line of JSON, or null when the line isn't sent on (malformed).
 */
export function scrubLine(kind: "log" | "spool", bytes: Buffer, origin: string): string | null {
  const scrubbed = kind === "spool" ? scrubSpoolLine(bytes) : scrubParsed(parseLine(bytes));
  // A malformed line is reported where it was written; there is nothing to scrub it to.
  return scrubbed === null ? null : JSON.stringify({ ...scrubbed, [EXPORT_LINE_FIELD]: origin });
}

/**
 * Scrubs a parsed log line, passing a parse failure through.
 * @param parsed - The parsed line, or null if it wasn't a JSON object.
 * @returns The scrubbed line, or null.
 */
function scrubParsed(parsed: LogObject | null): Record<string, unknown> | null {
  return parsed === null ? null : scrubLogLine(parsed);
}
