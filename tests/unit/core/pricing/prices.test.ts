/**
 * @file Unit tests for core/pricing/prices.ts (docs/development.md P5.1).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../../../../core/db/database.js";
import {
  type PriceRow,
  PriceTableError,
  loadPriceTable,
  syncPrices,
  validatePriceTable,
  validateRates,
} from "../../../../core/pricing/prices.js";

/** Repository root. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** A valid row used as the base for invalid variants. */
const ROW = {
  model_id: "claude-sonnet-5",
  effective_from: "0000-01-01",
  input: 2,
  output: 10,
  cache_write_5m: 2.5,
  cache_write_1h: 4,
  cache_read: 0.2,
  fast: null,
  standard_rate_max_input_tokens: null,
  source_url: "https://platform.claude.com/docs/en/about-claude/pricing",
  verified_on: "2026-09-13",
};

/**
 * Runs validation expecting a PriceTableError.
 * @param document - The document to validate.
 * @returns The error message.
 * @throws {Error} When validation unexpectedly succeeds.
 */
function failure(document: unknown): string {
  try {
    validatePriceTable(document);
  } catch (error) {
    expect(error).toBeInstanceOf(PriceTableError);
    return (error as Error).message;
  }
  throw new Error("expected validation to fail");
}

describe("validateRates", () => {
  it("returns exactly the five rates", () => {
    expect(validateRates({ ...ROW, extra: 1 }, "x")).toEqual({
      input: 2,
      output: 10,
      cache_write_5m: 2.5,
      cache_write_1h: 4,
      cache_read: 0.2,
    });
  });

  it.each([
    ["a non-object", 5, "x must be an object"],
    ["an array", [], "x must be an object"],
    [
      "a missing rate",
      { ...ROW, cache_read: undefined },
      "x.cache_read must be a non-negative number",
    ],
    ["a negative rate", { ...ROW, input: -1 }, "x.input must be a non-negative number"],
    ["a string rate", { ...ROW, output: "10" }, "x.output must be a non-negative number"],
  ])("rejects %s", (_name, value, message) => {
    expect(() => validateRates(value, "x")).toThrow(message);
  });
});

describe("validatePriceTable", () => {
  it("accepts valid rows, including fast rates and a long-context limit", () => {
    const fast = { input: 10, output: 50, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 1 };
    const rows = validatePriceTable({
      rows: [
        ROW,
        { ...ROW, model_id: "claude-opus-5", fast, standard_rate_max_input_tokens: 200000 },
      ],
    });
    expect(rows[1]).toMatchObject({ fast, standard_rate_max_input_tokens: 200000 });
    expect(new PriceTableError("m").name).toBe("PriceTableError");
  });

  it.each([
    ["no rows array", {}, "price table must have a rows array"],
    ["a null document", null, "price table must have a rows array"],
    [
      "an empty model",
      { rows: [{ ...ROW, model_id: "" }] },
      "rows[0].model_id must be a non-empty string",
    ],
    [
      "a bad date",
      { rows: [{ ...ROW, effective_from: "2026-9-1" }] },
      "rows[0] dates must be YYYY-MM-DD",
    ],
    [
      "a bad verified date",
      { rows: [{ ...ROW, verified_on: "today" }] },
      "rows[0] dates must be YYYY-MM-DD",
    ],
    [
      "a repeated model and date",
      { rows: [ROW, ROW] },
      "rows[1] repeats claude-sonnet-5@0000-01-01",
    ],
    [
      "a non-integer limit",
      { rows: [{ ...ROW, standard_rate_max_input_tokens: 1.5 }] },
      "must be null or a positive integer",
    ],
    [
      "a zero limit",
      { rows: [{ ...ROW, standard_rate_max_input_tokens: 0 }] },
      "must be null or a positive integer",
    ],
    [
      "invalid fast rates",
      { rows: [{ ...ROW, fast: { input: 1 } }] },
      "rows[0].fast.output must be a non-negative number",
    ],
    [
      "a missing source",
      { rows: [{ ...ROW, source_url: undefined }] },
      "rows[0].source_url must be a non-empty string",
    ],
  ])("rejects %s", (_name, document, message) => {
    expect(failure(document)).toContain(message);
  });
});

describe("loadPriceTable", () => {
  it("loads the committed price table: every row sourced and verified", () => {
    const rows = loadPriceTable(join(ROOT, "core/pricing/prices.json"));
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      expect(row.source_url).toBe("https://platform.claude.com/docs/en/about-claude/pricing");
      expect(row.verified_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(rows.map((row) => row.model_id)).toEqual(
      expect.arrayContaining([
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-haiku-4-5-20251001",
      ]),
    );
  });

  it("rejects a file that isn't JSON", () => {
    const path = join(mkdtempSync(join(tmpdir(), "aua-prices-")), "prices.json");
    writeFileSync(path, "{ nope");
    expect(() => loadPriceTable(path)).toThrow(PriceTableError);
    expect(() => loadPriceTable(path)).toThrow("is not valid JSON");
  });
});

describe("syncPrices", () => {
  it("replaces the table with the file's rows, including removals", () => {
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    const fast = { input: 10, output: 50, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 1 };
    const rows: PriceRow[] = [ROW, { ...ROW, model_id: "claude-opus-5", fast }];
    expect(syncPrices(db, rows)).toBe(2);
    expect(syncPrices(db, [ROW])).toBe(1);
    expect(
      db.prepare("SELECT model_id, fast_input_per_mtok, cache_read_per_mtok FROM prices").all(),
    ).toEqual([
      { model_id: "claude-sonnet-5", fast_input_per_mtok: null, cache_read_per_mtok: 0.2 },
    ]);
  });
});
