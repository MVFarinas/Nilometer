/**
 * @file Unit tests for core/db/database.ts.
 */
import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HAS_POSIX_MODES } from "../../../setup/platform.js";

import {
  type Migration,
  MigrationListError,
  applyMigrations,
  listMigrations,
  openDatabase,
  schemaVersion,
} from "../../../../core/db/database.js";

/**
 * Creates a migrations directory with the given files.
 * @param files - File name to SQL.
 * @returns The directory path.
 */
function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "aua-migrations-"));
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql);
  }
  return dir;
}

/** Two valid migrations used across tests. */
const TWO = {
  "001_first.sql": "-- first\nCREATE TABLE a (x INTEGER -- derived: test\n);",
  "002_second.sql": "-- second\nCREATE TABLE b (y INTEGER -- derived: test\n);",
};

/**
 * A fixed clock for applied_at.
 * @returns Always 2026-09-13T12:00:00Z.
 */
const NOW = (): Date => new Date("2026-09-13T12:00:00Z");

/**
 * Lists table names in a database.
 * @param db - Open database.
 * @returns Sorted user table names.
 */
function tables(db: ReturnType<typeof openDatabase>): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

describe("listMigrations", () => {
  it("returns migrations in version order and ignores non-SQL files", () => {
    const dir = migrationsDir({ ...TWO, "README.md": "notes" });
    expect(listMigrations(dir).map((m) => [m.version, m.name])).toEqual([
      [1, "001_first.sql"],
      [2, "002_second.sql"],
    ]);
  });

  it("returns an empty list for a directory with no migrations", () => {
    expect(listMigrations(migrationsDir({}))).toEqual([]);
  });

  it.each([
    ["a misnamed file", { "1_first.sql": "--" }, "doesn't match NNN_name.sql"],
    ["an uppercase name", { "001_First.sql": "--" }, "doesn't match NNN_name.sql"],
    ["a gap", { "001_a.sql": "--", "003_c.sql": "--" }, "without gaps or repeats"],
    ["a repeated version", { "001_a.sql": "--", "001_b.sql": "--" }, "without gaps or repeats"],
    ["not starting at 1", { "002_a.sql": "--" }, "without gaps or repeats"],
  ])("rejects %s", (_name, files, message) => {
    const dir = migrationsDir(files);
    expect(() => listMigrations(dir)).toThrow(MigrationListError);
    expect(() => listMigrations(dir)).toThrow(message);
  });

  it("names its error class", () => {
    expect(new MigrationListError("x").name).toBe("MigrationListError");
  });
});

describe("schemaVersion and applyMigrations", () => {
  it("reports version 0 for a new database", () => {
    const db = openDatabase(":memory:", migrationsDir({}));
    expect(schemaVersion(db)).toBe(0);
  });

  it("applies pending migrations in order and records them", () => {
    const db = openDatabase(":memory:", migrationsDir({}));
    const migrations = listMigrations(migrationsDir(TWO));
    expect(applyMigrations(db, migrations, NOW)).toEqual([1, 2]);
    expect(schemaVersion(db)).toBe(2);
    expect(db.prepare("SELECT version, name, applied_at FROM schema_migrations").all()).toEqual([
      { version: 1, name: "001_first.sql", applied_at: "2026-09-13T12:00:00.000Z" },
      { version: 2, name: "002_second.sql", applied_at: "2026-09-13T12:00:00.000Z" },
    ]);
  });

  it("is a no-op when re-run", () => {
    const db = openDatabase(":memory:", migrationsDir(TWO));
    expect(applyMigrations(db, listMigrations(migrationsDir(TWO)), NOW)).toEqual([]);
    expect(tables(db)).toEqual(["a", "b", "schema_migrations"]);
  });

  it("applies only migrations newer than the current version", () => {
    const db = openDatabase(":memory:", migrationsDir({ "001_first.sql": TWO["001_first.sql"] }));
    expect(applyMigrations(db, listMigrations(migrationsDir(TWO)), NOW)).toEqual([2]);
  });

  it("rolls a failing migration back completely and keeps earlier ones", () => {
    const db = openDatabase(":memory:", migrationsDir({}));
    const broken: Migration[] = [
      { version: 1, name: "001_first.sql", sql: TWO["001_first.sql"] },
      // Creates a table, then fails: the table must not survive.
      {
        version: 2,
        name: "002_broken.sql",
        sql: "CREATE TABLE half (z INTEGER); SELECT * FROM missing_table;",
      },
    ];
    expect(() => applyMigrations(db, broken, NOW)).toThrow(/no such table: missing_table/);
    expect(schemaVersion(db)).toBe(1);
    expect(tables(db)).toEqual(["a", "schema_migrations"]);
  });

  it("uses the real clock by default", () => {
    const db = openDatabase(":memory:", migrationsDir({}));
    applyMigrations(db, listMigrations(migrationsDir(TWO)));
    const row = db.prepare("SELECT applied_at FROM schema_migrations WHERE version = 1").get() as {
      applied_at: string;
    };
    expect(Date.parse(row.applied_at)).not.toBeNaN();
  });
});

describe("the shipped schema", () => {
  it("keeps the indexes the report's queries depend on (D-059)", () => {
    // These aren't decoration: without parsed_lines_request_time, counting the responses between
    // two readings scans the whole table once per pair, and reading one view took nine seconds.
    // A migration that drops or renames one of these must fail here rather than quietly slow
    // everything down, since nothing else in the suite measures time.
    const path = join(mkdtempSync(join(tmpdir(), "aua-db-schema-")), "usage.db");
    const db = openDatabase(
      path,
      join(dirname(fileURLToPath(import.meta.url)), "../../../../core/schema"),
    );
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
        .all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(indexes).toContain("parsed_lines_request_time");
    expect(indexes).toContain("parsed_lines_session_time");
    expect(indexes).toContain("requests_dedup_key");
    // Partial, so the planner can't reach for it in the window views, where it made them slower.
    const sql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'parsed_lines_request_time'")
        .get() as {
        sql: string;
      }
    ).sql;
    expect(sql).toMatch(/WHERE\s+class\s*=\s*'request'/);
    db.close();
  });
});

describe("openDatabase", () => {
  it("creates the file and parent directories, with WAL, busy timeout, and foreign keys", () => {
    const path = join(mkdtempSync(join(tmpdir(), "aua-db-")), "nested", "dir", "usage.db");
    const db = openDatabase(path, migrationsDir(TWO));
    expect(existsSync(path)).toBe(true);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it.skipIf(!HAS_POSIX_MODES)(
    "creates the database, its WAL and SHM files, and a new directory owner-only (D-043)",
    () => {
      const parent = mkdtempSync(join(tmpdir(), "aua-db-"));
      const path = join(parent, "private", "usage.db");
      const db = openDatabase(path, migrationsDir(TWO));
      db.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1);");
      expect(statSync(join(parent, "private")).mode & 0o777).toBe(0o700);
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
      db.close();
    },
  );

  it.skipIf(!HAS_POSIX_MODES)(
    "tightens an existing world-readable database and its WAL on open",
    () => {
      const path = join(mkdtempSync(join(tmpdir(), "aua-db-")), "usage.db");
      const db = openDatabase(path, migrationsDir(TWO));
      db.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1);");
      db.close();
      writeFileSync(`${path}-wal`, "");
      chmodSync(path, 0o644);
      chmodSync(`${path}-wal`, 0o644);
      openDatabase(path, migrationsDir(TWO)).close();
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it("migrates an existing older database when it is opened again, even just to read", () => {
    const path = join(mkdtempSync(join(tmpdir(), "aua-db-")), "usage.db");
    openDatabase(path, migrationsDir({ "001_first.sql": TWO["001_first.sql"] })).close();
    const reopened = openDatabase(path, migrationsDir(TWO));
    expect(schemaVersion(reopened)).toBe(2);
    reopened.close();
  });

  it("refuses to open with a misnumbered migrations directory, creating nothing", () => {
    const path = join(mkdtempSync(join(tmpdir(), "aua-db-")), "usage.db");
    expect(() => openDatabase(path, migrationsDir({ "002_a.sql": "--" }))).toThrow(
      MigrationListError,
    );
    expect(existsSync(path)).toBe(false);
  });
});
