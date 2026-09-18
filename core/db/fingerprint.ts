/**
 * @file Content fingerprints of database tables (docs/development.md P3.3, audit check A8).
 *
 * Proves re-runnability (D-002, `verify-against-ccusage` skill, check 4): fingerprint the derived
 * tables, ingest again, and the fingerprints must be byte-identical. A fingerprint depends only on
 * table contents, never on physical row order, so two databases holding the same rows agree even if
 * the rows were inserted in a different order.
 */
import { createHash } from "node:crypto";

import type { Db } from "./database.js";

/** A table name that doesn't exist. Nothing is hashed when this is raised. */
export class UnknownTableError extends Error {
  /**
   * Creates an unknown-table error.
   * @param table - The name that wasn't found.
   */
  constructor(table: string) {
    super(`no such table: ${table}`);
    this.name = "UnknownTableError";
  }
}

/**
 * Serializes one SQLite value unambiguously.
 * @param value - A value as better-sqlite3 returns it.
 * @returns A JSON-safe value. Blobs become `{"blob": "<hex>"}` so they can never collide with text,
 *   and bigints become `{"int": "<decimal>"}` so large integers keep full precision.
 */
export function canonicalValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return { blob: value.toString("hex") };
  }
  if (typeof value === "bigint") {
    return { int: value.toString() };
  }
  return value;
}

/**
 * Computes a SHA-256 fingerprint for each named table.
 * @param db - An open database.
 * @param tableNames - Tables to fingerprint.
 * @returns Lowercase hex digests keyed by table name.
 * @throws {UnknownTableError} If any table doesn't exist.
 */
export function fingerprintTables(db: Db, tableNames: readonly string[]): Record<string, string> {
  const existing = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((row) => row.name),
  );
  // Check every name before hashing any, so a typo can't produce a partial result.
  for (const table of tableNames) {
    if (!existing.has(table)) {
      throw new UnknownTableError(table);
    }
  }
  const result: Record<string, string> = {};
  for (const table of tableNames) {
    // The name was validated against sqlite_master above; quoting guards unusual characters.
    const rows = db
      .prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`)
      .raw()
      .all() as unknown[][];
    // Sort serialized rows so the digest ignores physical order but not content.
    const serialized = rows.map((row) => JSON.stringify(row.map(canonicalValue))).sort();
    const hash = createHash("sha256");
    for (const row of serialized) {
      hash.update(row);
      // A separator makes row boundaries part of the digest: ["ab"] and ["a","b"] differ.
      hash.update("\n");
    }
    result[table] = hash.digest("hex");
  }
  return result;
}
