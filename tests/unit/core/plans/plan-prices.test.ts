/**
 * @file Unit tests for core/plans/plan-prices.ts (D-027).
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../../../../core/db/database.js";
import {
  MAX_PLAN_NAME_LENGTH,
  PlanPriceError,
  listPlanPrices,
  setPlanPrice,
  validatePlanPrice,
  withPlanDatabase,
} from "../../../../core/plans/plan-prices.js";

/** Repository root. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * A clock returning a fixed instant.
 * @param iso - The instant.
 * @returns The clock.
 */
function clock(iso: string): () => Date {
  return () => new Date(iso);
}

describe("validatePlanPrice", () => {
  it("accepts a month, a decimal price, and a trimmed name", () => {
    expect(validatePlanPrice("2026-09", " 17.50 ", "  Plan A ")).toEqual({
      month: "2026-09",
      planName: "Plan A",
      usdPerMonth: 17.5,
    });
    expect(validatePlanPrice("2026-12", 0, "Free")).toMatchObject({ usdPerMonth: 0 });
    expect(new PlanPriceError("m").name).toBe("PlanPriceError");
  });

  it.each([
    ["a month without a leading zero", "2026-9", "200", "Plan", "month must be YYYY-MM"],
    ["month 13", "2026-13", "200", "Plan", "month must be YYYY-MM"],
    ["month 00", "2026-00", "200", "Plan", "month must be YYYY-MM"],
    ["a negative price", "2026-09", "-1", "Plan", "price must be"],
    ["exponent notation", "2026-09", "1e3", "Plan", "price must be"],
    ["a currency symbol", "2026-09", "$200", "Plan", "price must be"],
    ["an empty price", "2026-09", "", "Plan", "price must be"],
    ["a blank name", "2026-09", "200", "   ", "plan name must be"],
    [
      "a name that's too long",
      "2026-09",
      "200",
      "x".repeat(MAX_PLAN_NAME_LENGTH + 1),
      "plan name must be",
    ],
  ])("rejects %s", (_name, month, usd, planName, message) => {
    expect(() => validatePlanPrice(month, usd, planName)).toThrow(message);
  });
});

describe("setPlanPrice and listPlanPrices", () => {
  it("adds months, replaces a re-entered month, and lists oldest first", () => {
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    expect(listPlanPrices(db)).toEqual([]);
    expect(
      setPlanPrice(
        db,
        { month: "2026-10", planName: "B", usdPerMonth: 200 },
        clock("2026-09-13T01:00:00Z"),
      ),
    ).toBeNull();
    expect(
      setPlanPrice(
        db,
        { month: "2026-08", planName: "A", usdPerMonth: 100 },
        clock("2026-09-13T02:00:00Z"),
      ),
    ).toBeNull();
    const replaced = setPlanPrice(
      db,
      { month: "2026-10", planName: "C", usdPerMonth: 120 },
      clock("2026-09-13T03:00:00Z"),
    );
    expect(replaced).toEqual({
      month: "2026-10",
      planName: "B",
      usdPerMonth: 200,
      enteredAt: "2026-09-13T01:00:00.000Z",
    });
    expect(listPlanPrices(db)).toEqual([
      { month: "2026-08", planName: "A", usdPerMonth: 100, enteredAt: "2026-09-13T02:00:00.000Z" },
      { month: "2026-10", planName: "C", usdPerMonth: 120, enteredAt: "2026-09-13T03:00:00.000Z" },
    ]);
  });

  it("is backed by constraints that reject a malformed month or negative price", () => {
    const db = openDatabase(":memory:", join(ROOT, "core/schema"));
    expect(() =>
      setPlanPrice(
        db,
        { month: "Sept", planName: "A", usdPerMonth: 1 },
        clock("2026-09-13T00:00:00Z"),
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      setPlanPrice(
        db,
        { month: "2026-09", planName: "A", usdPerMonth: -1 },
        clock("2026-09-13T00:00:00Z"),
      ),
    ).toThrow(/CHECK/);
  });
});

describe("withPlanDatabase", () => {
  it("creates the data directory, returns the result, and closes the database even on error", () => {
    const home = mkdtempSync(join(tmpdir(), "aua-plans-"));
    const options = {
      home,
      env: {},
      dataDirOverride: join(home, "data", "nested"),
      packageRoot: ROOT,
    };
    const { databasePath, result } = withPlanDatabase(options, (db) =>
      setPlanPrice(
        db,
        { month: "2026-09", planName: "A", usdPerMonth: 1 },
        clock("2026-09-13T00:00:00Z"),
      ),
    );
    expect(result).toBeNull();
    expect(databasePath).toBe(join(home, "data", "nested", "usage.db"));
    expect(existsSync(databasePath)).toBe(true);
    let captured: { open: boolean } | undefined;
    expect(() =>
      withPlanDatabase(options, (db) => {
        captured = db;
        throw new Error("inside");
      }),
    ).toThrow("inside");
    expect(captured?.open).toBe(false);
    expect(withPlanDatabase(options, listPlanPrices).result).toHaveLength(1);
  });

  it("uses the environment's data directory when no flag is given", () => {
    const home = mkdtempSync(join(tmpdir(), "aua-plans-"));
    const { databasePath } = withPlanDatabase(
      { home, env: { NILOMETER_HOME: join(home, "env-data") }, packageRoot: ROOT },
      listPlanPrices,
    );
    expect(databasePath).toBe(join(home, "env-data", "usage.db"));
  });
});
