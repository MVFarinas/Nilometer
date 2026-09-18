/**
 * @file Shared builders for metric view tests: synthetic log lines, spooled status line readings,
 * and a real ingest into an in-memory database. Every line is synthetic (CLAUDE.md).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Db, openDatabase } from "../../../../core/db/database.js";
import { ensureDerived } from "../../../../core/ingest/derive.js";
import { SPOOL_FILE, ingestLogs } from "../../../../core/ingest/ingest.js";
import { loadPriceTable, syncPrices } from "../../../../core/pricing/prices.js";

/** Repository root. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Log files to write: path under `projects/` → lines. */
export type LogFiles = Record<string, object[]>;

/** One status line reading to spool. */
export interface Reading {
  /** Capture time, ISO-8601 UTC. */
  readonly at: string;
  /** Payload session_id. */
  readonly session: string;
  /** Window name. */
  readonly window: string;
  /** used_percentage. */
  readonly used: number;
  /** resets_at, ISO-8601 UTC (converted to epoch seconds). */
  readonly resets: string;
  /** Other windows in the same payload. Real payloads carry both windows in one spool line. */
  readonly more?: readonly Omit<Reading, "at" | "session" | "more">[];
}

/**
 * A fixed clock.
 * @returns 2026-09-13T00:00:00Z.
 */
export function now(): Date {
  return new Date("2026-09-13T00:00:00Z");
}

/**
 * Converts an ISO-8601 instant to epoch seconds.
 * @param iso - The instant.
 * @returns Whole seconds.
 */
export function epoch(iso: string): number {
  return Date.parse(iso) / 1000;
}

/**
 * Ingests log files and spooled readings into a fresh database, with the committed price table.
 * @param files - Log files.
 * @param readings - Status line readings.
 * @returns The database with derived tables filled.
 */
export function ingest(files: LogFiles, readings: readonly Reading[] = []): Db {
  const root = mkdtempSync(join(tmpdir(), "aua-interruptions-"));
  mkdirSync(join(root, "projects"));
  for (const [path, lines] of Object.entries(files)) {
    mkdirSync(dirname(join(root, "projects", path)), { recursive: true });
    writeFileSync(
      join(root, "projects", path),
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
  }
  const spoolDir = join(root, "data");
  mkdirSync(spoolDir);
  writeFileSync(
    join(spoolDir, SPOOL_FILE),
    readings
      .map((r) => {
        const payload = {
          session_id: r.session,
          rate_limits: Object.fromEntries(
            [r, ...(r.more ?? [])].map((w) => [
              w.window,
              { used_percentage: w.used, resets_at: epoch(w.resets) },
            ]),
          ),
        };
        const spooled = {
          captured_at_s: epoch(r.at),
          hook_version: 1,
          payload_b64: Buffer.from(JSON.stringify(payload)).toString("base64"),
        };
        return `${JSON.stringify(spooled)}\n`;
      })
      .join(""),
  );
  const db = openDatabase(":memory:", join(ROOT, "core/schema"));
  ingestLogs(db, { roots: [root], mode: "incremental", now, spoolDir });
  ensureDerived(db);
  syncPrices(db, loadPriceTable(join(ROOT, "core/pricing/prices.json")));
  return db;
}

/**
 * A user line.
 * @param session - sessionId.
 * @param uuid - uuid.
 * @param parent - parentUuid, or null.
 * @param timestamp - timestamp.
 * @param extra - Fields merged over the line (content, isMeta, origin).
 * @returns The line.
 */
export function user(
  session: string,
  uuid: string,
  parent: string | null,
  timestamp: string,
  extra: object = {},
): object {
  return {
    type: "user",
    sessionId: session,
    uuid,
    parentUuid: parent,
    timestamp,
    origin: { kind: "human" },
    message: { role: "user", content: [{ type: "text", text: "synthetic prompt" }] },
    ...extra,
  };
}

/**
 * A tool result line.
 * @param session - sessionId.
 * @param uuid - uuid.
 * @param parent - parentUuid.
 * @param timestamp - timestamp.
 * @returns The line.
 */
export function toolResult(
  session: string,
  uuid: string,
  parent: string,
  timestamp: string,
): object {
  return {
    type: "user",
    sessionId: session,
    uuid,
    parentUuid: parent,
    timestamp,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
  };
}

/**
 * An assistant request line.
 * @param session - sessionId.
 * @param uuid - uuid (also the message id).
 * @param parent - parentUuid.
 * @param timestamp - timestamp, or null to omit it.
 * @param options - Model, working directory, and usage fields merged over the defaults.
 * @returns The line.
 */
export function request(
  session: string,
  uuid: string,
  parent: string | null,
  timestamp: string | null,
  options: RequestOptions = {},
): object {
  return {
    type: "assistant",
    sessionId: session,
    uuid,
    parentUuid: parent,
    ...(timestamp === null ? {} : { timestamp }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    message: {
      id: `msg-${uuid}`,
      model: options.model ?? "claude-sonnet-5",
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, ...options.usage },
    },
  };
}

/** Overrides for {@link request}. */
export interface RequestOptions {
  /** message.model; defaults to claude-sonnet-5. */
  readonly model?: string;
  /** Top-level cwd; omitted by default. */
  readonly cwd?: string;
  /** Usage fields merged over 1 input, 1 output, 0 cache read. */
  readonly usage?: object;
}

/**
 * A synthetic limit-hit line.
 * @param session - sessionId.
 * @param uuid - uuid, or null to omit it.
 * @param parent - parentUuid, or null.
 * @param timestamp - timestamp, or null to omit it.
 * @param text - Message text.
 * @returns The line.
 */
export function hit(
  session: string,
  uuid: string | null,
  parent: string | null,
  timestamp: string | null,
  text: string,
): object {
  return {
    type: "assistant",
    sessionId: session,
    ...(uuid === null ? {} : { uuid }),
    parentUuid: parent,
    ...(timestamp === null ? {} : { timestamp }),
    isApiErrorMessage: true,
    error: "rate_limit",
    apiErrorStatus: 429,
    message: {
      model: "<synthetic>",
      content: [{ type: "text", text }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  };
}

/**
 * Reads every row of a view.
 * @param db - Database.
 * @param view - View name.
 * @param order - ORDER BY clause.
 * @returns The rows.
 */
export function rows(db: Db, view: string, order = "1"): Record<string, unknown>[] {
  return db.prepare(`SELECT * FROM ${view} ORDER BY ${order}`).all() as Record<string, unknown>[];
}

/**
 * Reads a summary view's single row.
 * @param db - Database.
 * @param view - View name.
 * @returns The row.
 */
export function summary(db: Db, view: string): Record<string, unknown> {
  return db.prepare(`SELECT * FROM ${view}`).get() as Record<string, unknown>;
}
