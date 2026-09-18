/**
 * @file Loading the dated price table and syncing it into the database (docs/development.md P5.1, D-005, D-020).
 *
 * `prices.json` is the source of truth: committed, reviewed, and read from Anthropic's pricing page
 * on the date each row records. The loader validates every field strictly, because a wrong rate
 * silently mispriced every tool studied (D-005), and replaces the `prices` table on each ingest so a
 * correction takes effect without a migration.
 */
import { readFileSync } from "node:fs";

import type { Db } from "../db/database.js";

/** Rates for one pricing mode, USD per million tokens. */
export interface Rates {
  /** Base input tokens. */
  readonly input: number;
  /** Output tokens. */
  readonly output: number;
  /** 5-minute cache writes. */
  readonly cache_write_5m: number;
  /** 1-hour cache writes. */
  readonly cache_write_1h: number;
  /** Cache hits and refreshes. */
  readonly cache_read: number;
}

/** One row of the price table. */
export interface PriceRow extends Rates {
  /** Exact `message.model` string the row prices. */
  readonly model_id: string;
  /** UTC day the rate took effect, `YYYY-MM-DD`; `0000-01-01` means since release (D-020). */
  readonly effective_from: string;
  /** Fast mode rates, or null when fast mode isn't published for the model. */
  readonly fast: Rates | null;
  /** Largest total input priced at standard rates; null when the full context window is standard. */
  readonly standard_rate_max_input_tokens: number | null;
  /** Page the rates were read from. */
  readonly source_url: string;
  /** UTC day someone read that page, `YYYY-MM-DD`. */
  readonly verified_on: string;
}

/** A price table that fails validation. Nothing is written when this is raised. */
export class PriceTableError extends Error {
  /**
   * Creates a price table error.
   * @param message - Which row and field are invalid.
   */
  constructor(message: string) {
    super(message);
    this.name = "PriceTableError";
  }
}

/** Rate fields every rates object must have. */
const RATE_FIELDS = ["input", "output", "cache_write_5m", "cache_write_1h", "cache_read"] as const;

/** A `YYYY-MM-DD` date string. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates a rates object.
 * @param value - The candidate value.
 * @param where - Location for error messages.
 * @returns The rates.
 * @throws {PriceTableError} If any rate is missing, not a number, or negative.
 */
export function validateRates(value: unknown, where: string): Rates {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PriceTableError(`${where} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const field of RATE_FIELDS) {
    const rate = record[field];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
      throw new PriceTableError(`${where}.${field} must be a non-negative number`);
    }
  }
  return {
    input: record["input"] as number,
    output: record["output"] as number,
    cache_write_5m: record["cache_write_5m"] as number,
    cache_write_1h: record["cache_write_1h"] as number,
    cache_read: record["cache_read"] as number,
  };
}

/**
 * Validates a parsed price table document.
 * @param document - Parsed JSON with a `rows` array.
 * @returns Validated rows.
 * @throws {PriceTableError} If the document or any row is invalid, or a (model, effective_from)
 *   pair repeats.
 */
export function validatePriceTable(document: unknown): PriceRow[] {
  const rows = (document as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) {
    throw new PriceTableError("price table must have a rows array");
  }
  const seen = new Set<string>();
  return rows.map((row: unknown, index): PriceRow => {
    const where = `rows[${index}]`;
    const rates = validateRates(row, where);
    const record = row as Record<string, unknown>;
    /**
     * Reads a required non-empty string field of this row.
     * @param field - Field name.
     * @returns The string.
     * @throws {PriceTableError} If the field is missing, empty, or not a string.
     */
    const text = (field: string): string => {
      const value = record[field];
      if (typeof value !== "string" || value === "") {
        throw new PriceTableError(`${where}.${field} must be a non-empty string`);
      }
      return value;
    };
    const modelId = text("model_id");
    const effectiveFrom = text("effective_from");
    const verifiedOn = text("verified_on");
    if (!DAY.test(effectiveFrom) || !DAY.test(verifiedOn)) {
      throw new PriceTableError(`${where} dates must be YYYY-MM-DD`);
    }
    const key = `${modelId}@${effectiveFrom}`;
    // Two rows for the same model and day would make the rate in effect ambiguous.
    if (seen.has(key)) {
      throw new PriceTableError(`${where} repeats ${key}`);
    }
    seen.add(key);
    const max = record["standard_rate_max_input_tokens"];
    if (max !== null && (typeof max !== "number" || !Number.isInteger(max) || max <= 0)) {
      throw new PriceTableError(
        `${where}.standard_rate_max_input_tokens must be null or a positive integer`,
      );
    }
    return {
      model_id: modelId,
      effective_from: effectiveFrom,
      ...rates,
      fast: record["fast"] === null ? null : validateRates(record["fast"], `${where}.fast`),
      standard_rate_max_input_tokens: max,
      source_url: text("source_url"),
      verified_on: verifiedOn,
    };
  });
}

/**
 * Reads and validates the price table file.
 * @param path - Path to `prices.json`.
 * @returns Validated rows.
 * @throws {PriceTableError} If the file isn't valid JSON or fails validation.
 */
export function loadPriceTable(path: string): PriceRow[] {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PriceTableError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validatePriceTable(document);
}

/**
 * Replaces the database's price rows with the given table, in one transaction.
 * @param db - Open, migrated database.
 * @param rows - Validated rows.
 * @returns Number of rows written.
 */
export function syncPrices(db: Db, rows: readonly PriceRow[]): number {
  const insert = db.prepare(
    `INSERT INTO prices (model_id, effective_from, input_per_mtok, output_per_mtok,
       cache_write_5m_per_mtok, cache_write_1h_per_mtok, cache_read_per_mtok,
       fast_input_per_mtok, fast_output_per_mtok, fast_cache_write_5m_per_mtok,
       fast_cache_write_1h_per_mtok, fast_cache_read_per_mtok,
       standard_rate_max_input_tokens, source_url, verified_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    // The file is the whole truth: rows removed from it must disappear from the table too.
    db.prepare("DELETE FROM prices").run();
    for (const row of rows) {
      insert.run(
        row.model_id,
        row.effective_from,
        row.input,
        row.output,
        row.cache_write_5m,
        row.cache_write_1h,
        row.cache_read,
        row.fast?.input ?? null,
        row.fast?.output ?? null,
        row.fast?.cache_write_5m ?? null,
        row.fast?.cache_write_1h ?? null,
        row.fast?.cache_read ?? null,
        row.standard_rate_max_input_tokens,
        row.source_url,
        row.verified_on,
      );
    }
  })();
  return rows.length;
}
