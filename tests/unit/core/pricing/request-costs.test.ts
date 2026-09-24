/**
 * @file Tests for the request_costs view (docs/development.md P5.2, D-005, D-006, D-020).
 *
 * Every expected dollar amount was computed by hand from the fixture tokens and the rates on the
 * pricing page (read 2026-09-13), not by running the view. The arithmetic is written in each test as
 * tokens × USD per million tokens.
 */
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { type Db, openDatabase } from "../../../../core/db/database.js";
import { ensureDerived } from "../../../../core/ingest/derive.js";
import { ingestLogs } from "../../../../core/ingest/ingest.js";
import { type PriceRow, loadPriceTable, syncPrices } from "../../../../core/pricing/prices.js";
import { loadProjected } from "../../../../viewer/queries.js";
import { renderProjected } from "../../../../viewer/render.js";

/** Repository root. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** One row of the cost view, as read in these tests. */
interface CostRow {
  dedup_key: string;
  model: string;
  unpriced_reason: string | null;
  is_lower_bound: number;
  input_usd: number | null;
  output_usd: number | null;
  cache_read_usd: number | null;
  cache_write_5m_usd: number | null;
  cache_write_1h_usd: number | null;
  total_usd: number | null;
  verified_on: string | null;
  price_effective_from: string | null;
}

/**
 * A fixed clock.
 * @returns 2026-09-13T00:00:00Z.
 */
function now(): Date {
  return new Date("2026-09-13T00:00:00Z");
}

/**
 * Ingests log trees and synthetic lines into a fresh database with the committed prices.
 * @param caseIds - Fixture cases to include.
 * @param extraLines - Synthetic request lines written to one more session file.
 * @param prices - Price rows; defaults to the committed table.
 * @returns The database.
 */
function ingest(caseIds: string[], extraLines: object[] = [], prices?: PriceRow[]): Db {
  const root = mkdtempSync(join(tmpdir(), "aua-costs-"));
  mkdirSync(join(root, "projects", "-synthetic"), { recursive: true });
  for (const caseId of caseIds) {
    cpSync(join(ROOT, "fixtures", caseId, "projects"), join(root, "projects"), { recursive: true });
  }
  writeFileSync(
    join(root, "projects", "-synthetic", "x.jsonl"),
    extraLines.map((line) => `${JSON.stringify(line)}\n`).join(""),
  );
  const db = openDatabase(":memory:", join(ROOT, "core/schema"));
  ingestLogs(db, { roots: [root], mode: "incremental", now });
  ensureDerived(db);
  syncPrices(db, prices ?? loadPriceTable(join(ROOT, "core/pricing/prices.json")));
  return db;
}

/**
 * Builds a synthetic request line.
 * @param id - Message ID (also the session suffix).
 * @param model - Model ID.
 * @param usage - Usage fields merged over zero counts.
 * @param timestamp - Request timestamp.
 * @returns The line object.
 */
function line(
  id: string,
  model: string,
  usage: object,
  timestamp = "2026-09-01T12:00:00Z",
): object {
  return {
    type: "assistant",
    sessionId: "sx",
    timestamp,
    message: {
      id,
      model,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
        ...usage,
      },
    },
  };
}

/**
 * Reads one request's cost row by dedup key.
 * @param db - Database.
 * @param key - Dedup key.
 * @returns The row.
 */
function cost(db: Db, key: string): CostRow {
  return db.prepare("SELECT * FROM request_costs WHERE dedup_key = ?").get(key) as CostRow;
}

describe("request_costs: fixture costs computed by hand", () => {
  let db: Db;

  beforeEach(() => {
    db = ingest(["16-cache-write-forms", "06-mixed-models", "17-report-edges"]);
  });

  it("prices each token type of a split-cache request on Sonnet 5", () => {
    const row = cost(db, "s16/m/msg_16a");
    // 5 × $2 = 10, 10 × $10 = 100, 50 × $0.20 = 10, 300 × $2.50 = 750, 700 × $4 = 2800 (µ$).
    expect(row.input_usd).toBeCloseTo(0.00001, 12);
    expect(row.output_usd).toBeCloseTo(0.0001, 12);
    expect(row.cache_read_usd).toBeCloseTo(0.00001, 12);
    expect(row.cache_write_5m_usd).toBeCloseTo(0.00075, 12);
    expect(row.cache_write_1h_usd).toBeCloseTo(0.0028, 12);
    expect(row.total_usd).toBeCloseTo(0.00367, 12);
    expect(row).toMatchObject({
      unpriced_reason: null,
      is_lower_bound: 0,
      verified_on: "2026-09-13",
      price_effective_from: "0000-01-01",
    });
  });

  it("prices unsplit cache writes at the 5-minute rate and flags a lower bound", () => {
    const row = cost(db, "s16/m/msg_16b");
    // 6 × $2 = 12, 20 × $10 = 200, 60 × $0.20 = 12, 400 × $2.50 = 1000 → 1224 µ$.
    expect(row.cache_write_5m_usd).toBeCloseTo(0.001, 12);
    expect(row.cache_write_1h_usd).toBe(0);
    expect(row.total_usd).toBeCloseTo(0.001224, 12);
    expect(row.is_lower_bound).toBe(1);
  });

  it("prices each request at its own model's rates in a mixed-model session", () => {
    // Sonnet 5: 100 × $2 + 10 × $10 = 300 µ$. Opus 5: 200 × $5 + 50 × $25 = 2250 µ$.
    // Haiku 4.5 (dated ID): 20 × $1 + 5 × $5 = 45 µ$. Sonnet 5: 50 × $2 + 15 × $10 = 250 µ$.
    expect(cost(db, "s06/m/msg_06a").total_usd).toBeCloseTo(0.0003, 12);
    expect(cost(db, "s06/m/msg_06b").total_usd).toBeCloseTo(0.00225, 12);
    expect(cost(db, "s06/m/msg_06c").total_usd).toBeCloseTo(0.000045, 12);
    expect(cost(db, "s06/m/msg_06d").total_usd).toBeCloseTo(0.00025, 12);
  });

  it("leaves a request with an unparsed timestamp unpriced, never $0", () => {
    const row = cost(db, "s17/m/msg_17b");
    expect(row).toMatchObject({
      unpriced_reason: "unparsed_timestamp",
      total_usd: null,
      input_usd: null,
    });
    expect(db.prepare("SELECT unpriced_reason FROM unpriced_requests").all()).toEqual([
      { unpriced_reason: "unparsed_timestamp" },
    ]);
  });
});

describe("request_costs: rules without fixtures", () => {
  it("prices fast mode at fast rates, and leaves fast mode unpriced where no fast rate exists", () => {
    const db = ingest(
      [],
      [
        line("fast-opus", "claude-opus-5", {
          input_tokens: 1000,
          output_tokens: 100,
          cache_read_input_tokens: 500,
          speed: "fast",
        }),
        line("fast-sonnet", "claude-sonnet-5", { input_tokens: 1000, speed: "fast" }),
        line("standard-opus", "claude-opus-5", { input_tokens: 1000, speed: "standard" }),
      ],
    );
    // Fast Opus 5: 1000 × $10 + 100 × $50 + 500 × $1 = 15500 µ$.
    expect(cost(db, "sx/m/fast-opus").total_usd).toBeCloseTo(0.0155, 12);
    expect(cost(db, "sx/m/fast-sonnet")).toMatchObject({
      unpriced_reason: "fast_rate_unknown",
      total_usd: null,
    });
    // Standard Opus 5: 1000 × $5 = 5000 µ$.
    expect(cost(db, "sx/m/standard-opus").total_usd).toBeCloseTo(0.005, 12);
  });

  it("prices Opus 5.5 at its own rates, with its 0.05× cache read, at standard and fast speed", () => {
    // Rates read from the pricing page on 2026-09-24. Opus 5.5 cache reads are 0.05× input, not the
    // 0.1× of the rest of the Opus line, so pricing it as Opus 5 would overstate every cache read.
    const cacheWrites = { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 500 };
    const db = ingest(
      [],
      [
        line("opus55", "claude-opus-5-5", {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 10000,
          cache_creation: cacheWrites,
        }),
        line("opus55-fast", "claude-opus-5-5", {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 },
          speed: "fast",
        }),
      ],
    );
    // 1000 × $4 = 4000, 200 × $20 = 4000, 10000 × $0.20 = 2000, 400 × $5 = 2000, 500 × $8 = 4000
    // → 16000 µ$.
    const standard = cost(db, "sx/m/opus55");
    expect(standard.input_usd).toBeCloseTo(0.004, 12);
    expect(standard.output_usd).toBeCloseTo(0.004, 12);
    expect(standard.cache_read_usd).toBeCloseTo(0.002, 12);
    expect(standard.cache_write_5m_usd).toBeCloseTo(0.002, 12);
    expect(standard.cache_write_1h_usd).toBeCloseTo(0.004, 12);
    expect(standard).toMatchObject({ unpriced_reason: null, verified_on: "2026-09-24" });
    expect(standard.total_usd).toBeCloseTo(0.016, 12);
    // Fast: caching multipliers on the $8 fast input. 100 × $8 = 800, 50 × $40 = 2000,
    // 1000 × $0.40 = 400, 20 × $10 = 200, 10 × $16 = 160 → 3560 µ$.
    expect(cost(db, "sx/m/opus55-fast").total_usd).toBeCloseTo(0.00356, 12);
  });

  it("prices every older and limited-access model at its own rates, by alias and by snapshot ID", () => {
    // Rates read from the pricing page on 2026-09-24. Every request is 1000 input, 200 output,
    // 10000 cache read, 400 five-minute and 500 one-hour cache-write tokens, so each family's
    // expected cost below is tokens × USD per million tokens, summed by hand (µ$).
    const usage = {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 10000,
      cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 500 },
    };
    // Opus 4.5 ($5 / $25 / $6.25 / $10 / $0.50): 5000 + 5000 + 5000 + 2500 + 5000 = 22500.
    // Opus 4.1 and 4 ($15 / $75 / $18.75 / $30 / $1.50): 15000 + 15000 + 15000 + 7500 + 15000 = 67500.
    // Sonnet 4.5 and 4 ($3 / $15 / $3.75 / $6 / $0.30): 3000 + 3000 + 3000 + 1500 + 3000 = 13500.
    // Haiku 3.5 ($0.80 / $4 / $1 / $1.60 / $0.08): 800 + 800 + 800 + 400 + 800 = 3600.
    // Mythos 5 ($10 / $50 / $12.50 / $20 / $1): 10000 + 10000 + 10000 + 5000 + 10000 = 45000.
    // Mythos 5.1 (same, but cache reads $0.25): 10000 + 10000 + 2500 + 5000 + 10000 = 37500.
    const expected: [string, number][] = [
      ["claude-opus-4-5", 0.0225],
      ["claude-opus-4-5-20251101", 0.0225],
      ["claude-opus-4-1", 0.0675],
      ["claude-opus-4-1-20250805", 0.0675],
      ["claude-opus-4-0", 0.0675],
      ["claude-opus-4-20250514", 0.0675],
      ["claude-sonnet-4-5", 0.0135],
      ["claude-sonnet-4-5-20250929", 0.0135],
      ["claude-sonnet-4-0", 0.0135],
      ["claude-sonnet-4-20250514", 0.0135],
      ["claude-3-5-haiku-20241022", 0.0036],
      ["claude-mythos-5", 0.045],
      ["claude-mythos-5-1", 0.0375],
    ];
    const db = ingest(
      [],
      [
        ...expected.map(([model]) => line(`m-${model}`, model, usage)),
        // Above 200000 total input these models' rates are not verified, so it stays unpriced.
        line("long-sonnet", "claude-sonnet-4-5", { input_tokens: 250000 }),
      ],
    );
    // Compared in whole micro-dollars, all models at once, so one failure names every mismatch.
    const got = expected.map(([model]) => {
      const row = cost(db, `sx/m/m-${model}`);
      return [
        model,
        row.unpriced_reason,
        row.total_usd === null ? null : Math.round(row.total_usd * 1e6),
      ];
    });
    expect(got).toEqual(expected.map(([model, usd]) => [model, null, Math.round(usd * 1e6)]));
    expect(cost(db, "sx/m/long-sonnet").unpriced_reason).toBe("long_context_rate_unverified");
  });

  it("applies 1.1× to every token type for US-only inference", () => {
    const db = ingest(
      [],
      [
        line("us", "claude-sonnet-5", {
          input_tokens: 1000,
          output_tokens: 100,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
          inference_geo: "us",
        }),
        line("global", "claude-sonnet-5", { input_tokens: 1000, inference_geo: "global" }),
      ],
    );
    // (1000 × $2 + 100 × $10 + 1000 × $4) × 1.1 = 7000 × 1.1 = 7700 µ$.
    expect(cost(db, "sx/m/us").total_usd).toBeCloseTo(0.0077, 12);
    expect(cost(db, "sx/m/us").cache_write_1h_usd).toBeCloseTo(0.0044, 12);
    // Global: 1000 × $2 = 2000 µ$.
    expect(cost(db, "sx/m/global").total_usd).toBeCloseTo(0.002, 12);
  });

  it("leaves unknown models, non-standard service tiers, and unverified long context unpriced", () => {
    const db = ingest(
      [],
      [
        line("unknown", "claude-opus-9", { input_tokens: 10 }),
        line("prefix", "claude-opus-5-20990101", { input_tokens: 10 }),
        line("priority", "claude-sonnet-5", { input_tokens: 10, service_tier: "priority" }),
        line("long", "claude-haiku-4-5", { input_tokens: 150000, cache_read_input_tokens: 60000 }),
        line("edge", "claude-haiku-4-5", { input_tokens: 200000 }),
      ],
    );
    expect(cost(db, "sx/m/unknown").unpriced_reason).toBe("no_price_row");
    // Exact matching only: a longer ID that starts with a priced model is not that model.
    expect(cost(db, "sx/m/prefix").unpriced_reason).toBe("no_price_row");
    expect(cost(db, "sx/m/priority").unpriced_reason).toBe("service_tier_not_standard");
    // 150000 + 60000 = 210000 total input, above the 200000 standard-rate limit.
    expect(cost(db, "sx/m/long").unpriced_reason).toBe("long_context_rate_unverified");
    // Exactly at the limit is standard: 200000 × $1 = $0.20.
    expect(cost(db, "sx/m/edge").total_usd).toBeCloseTo(0.2, 12);
  });

  it("prices each request at the row in effect on its UTC day", () => {
    const base = {
      model_id: "claude-test",
      input: 1,
      output: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_read: 0,
      fast: null,
      standard_rate_max_input_tokens: null,
      source_url: "https://example.test/pricing",
      verified_on: "2026-09-13",
    };
    const db = ingest(
      [],
      [
        line("before", "claude-test", { input_tokens: 1_000_000 }, "2026-09-01T23:59:59Z"),
        line("on", "claude-test", { input_tokens: 1_000_000 }, "2026-09-02T00:00:00Z"),
        line("after", "claude-test", { input_tokens: 1_000_000 }, "2026-09-03T09:00:00+05:00"),
      ],
      [
        { ...base, effective_from: "0000-01-01" },
        { ...base, effective_from: "2026-09-02", input: 2 },
      ],
    );
    // 1,000,000 × $1 before the change; × $2 on and after 2026-09-02 (UTC day of each request).
    expect(cost(db, "sx/m/before")).toMatchObject({
      total_usd: 1,
      price_effective_from: "0000-01-01",
    });
    expect(cost(db, "sx/m/on")).toMatchObject({ total_usd: 2, price_effective_from: "2026-09-02" });
    expect(cost(db, "sx/m/after")).toMatchObject({
      total_usd: 2,
      price_effective_from: "2026-09-02",
    });
  });
});

describe("the note on requests dated before their rate was read", () => {
  it("prints each reading date beside its own count, never every count under the latest date", () => {
    const row = {
      effective_from: "0000-01-01",
      input: 1,
      output: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_read: 0,
      fast: null,
      standard_rate_max_input_tokens: null,
      source_url: "https://example.test/pricing",
    };
    const db = ingest(
      [],
      [
        line("a-early", "claude-a", { input_tokens: 10 }, "2026-09-01T12:00:00Z"),
        line("a-late", "claude-a", { input_tokens: 10 }, "2026-09-20T12:00:00Z"),
        line("b-early", "claude-b", { input_tokens: 10 }, "2026-09-10T12:00:00Z"),
        line("b-mid", "claude-b", { input_tokens: 10 }, "2026-09-20T12:00:00Z"),
        line("b-same-day", "claude-b", { input_tokens: 10 }, "2026-09-24T12:00:00Z"),
      ],
      [
        { ...row, model_id: "claude-a", verified_on: "2026-09-13" },
        { ...row, model_id: "claude-b", verified_on: "2026-09-24" },
      ],
    );
    // claude-a, read 2026-09-13: only 09-01 is before it → 1. claude-b, read 2026-09-24: 09-10 and
    // 09-20 are before it, and a request on the reading day itself is not → 2.
    const projected = loadProjected(db);
    expect(projected.rateReadings).toEqual([
      { verified_on: "2026-09-13", priced_before_verified_requests: 1 },
      { verified_on: "2026-09-24", priced_before_verified_requests: 2 },
    ]);
    const notes = renderProjected(projected, "UTC").filter((l) => l.includes("Rates were read"));
    expect(notes).toEqual([
      "  Rates were read from Anthropic's pricing page on 2026-09-13; 1 requests dated before that are priced at those rates.",
      "  Rates were read from Anthropic's pricing page on 2026-09-24; 2 requests dated before that are priced at those rates.",
    ]);
  });

  it("prints no note when every priced request is dated on or after its reading", () => {
    const db = ingest(
      [],
      [line("late", "claude-sonnet-5", { input_tokens: 10 }, "2026-09-20T12:00:00Z")],
    );
    expect(loadProjected(db).rateReadings).toEqual([]);
    expect(renderProjected(loadProjected(db), "UTC").join("\n")).not.toContain("Rates were read");
  });
});
