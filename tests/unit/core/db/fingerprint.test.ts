/**
 * @file Unit tests for core/db/fingerprint.ts.
 */
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  UnknownTableError,
  canonicalValue,
  fingerprintTables,
} from "../../../../core/db/fingerprint.js";

/**
 * Creates an in-memory database with one table holding the given rows, inserted in order.
 * @param rows - Rows of (id, text, blob).
 * @returns The database.
 */
function dbWith(rows: [number, string | null, Buffer | null][]): Database.Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT, data BLOB)");
  const insert = db.prepare("INSERT INTO t VALUES (?, ?, ?)");
  rows.forEach((row) => insert.run(...row));
  return db;
}

describe("canonicalValue", () => {
  it("wraps blobs and bigints and passes other values through", () => {
    expect(canonicalValue(Buffer.from([0xab, 0x01]))).toEqual({ blob: "ab01" });
    expect(canonicalValue(12345678901234567890n)).toEqual({ int: "12345678901234567890" });
    expect(canonicalValue("text")).toBe("text");
    expect(canonicalValue(4.5)).toBe(4.5);
    expect(canonicalValue(null)).toBeNull();
  });
});

describe("fingerprintTables", () => {
  const rows: [number, string | null, Buffer | null][] = [
    [1, "a", Buffer.from("x")],
    [2, null, null],
  ];

  it("gives the same digest for identical rows inserted in a different order", () => {
    const forward = fingerprintTables(dbWith(rows), ["t"]);
    const backward = fingerprintTables(dbWith([...rows].reverse()), ["t"]);
    expect(forward).toEqual(backward);
  });

  it("ignores physical order in a table without a primary key, where rows come back in insert order", () => {
    // Without INTEGER PRIMARY KEY, SELECT * returns hidden-rowid order, i.e. insertion order, so this
    // is the case that actually needs the sort. (With explicit ids, SQLite already orders by key.)
    /**
     * Fingerprints a key-less table filled in the given order.
     * @param labels - Labels to insert, in insertion order.
     * @returns The table's fingerprint.
     */
    const build = (labels: string[]): Record<string, string> => {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE u (label TEXT, n INTEGER)");
      const insert = db.prepare("INSERT INTO u VALUES (?, 1)");
      labels.forEach((label) => insert.run(label));
      return fingerprintTables(db, ["u"]);
    };
    expect(build(["b", "a", "c"])).toEqual(build(["a", "b", "c"]));
  });

  it("changes when any single cell changes", () => {
    const base = fingerprintTables(dbWith(rows), ["t"]);
    const changed = fingerprintTables(dbWith([[1, "b", Buffer.from("x")], rows[1]!]), ["t"]);
    expect(changed["t"]).not.toBe(base["t"]);
  });

  it("distinguishes a blob from text with the same characters", () => {
    const asBlob = fingerprintTables(dbWith([[1, null, Buffer.from("ab")]]), ["t"]);
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT, data BLOB)");
    db.prepare("INSERT INTO t VALUES (1, NULL, 'ab')").run();
    expect(fingerprintTables(db, ["t"])["t"]).not.toBe(asBlob["t"]);
  });

  it("gives an empty table the SHA-256 of empty input", () => {
    expect(fingerprintTables(dbWith([]), ["t"])).toEqual({
      t: createHash("sha256").digest("hex"),
    });
  });

  it("fingerprints several tables, including one with a quote in its name", () => {
    const db = dbWith(rows);
    db.exec('CREATE TABLE "odd""name" (x INTEGER)');
    const result = fingerprintTables(db, ["t", 'odd"name']);
    expect(Object.keys(result)).toEqual(["t", 'odd"name']);
  });

  it("is stable across a database file closed and reopened", () => {
    const path = join(mkdtempSync(join(tmpdir(), "aua-fp-")), "x.db");
    const first = new Database(path);
    first.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT, data BLOB)");
    first.prepare("INSERT INTO t VALUES (1, 'a', x'00ff')").run();
    const before = fingerprintTables(first, ["t"]);
    first.close();
    expect(fingerprintTables(new Database(path), ["t"])).toEqual(before);
  });

  it("throws for an unknown table before hashing anything", () => {
    expect(() => fingerprintTables(dbWith(rows), ["t", "missing"])).toThrow(UnknownTableError);
    expect(() => fingerprintTables(dbWith(rows), ["missing"])).toThrow("no such table: missing");
    expect(new UnknownTableError("x").name).toBe("UnknownTableError");
  });
});
