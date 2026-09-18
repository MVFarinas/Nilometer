/**
 * @file Opening the SQLite database and applying numbered SQL migrations (docs/development.md P3.1).
 *
 * Implements README § Tech stack ("analysis logic lives in SQL") and D-014 (better-sqlite3).
 * Schema is owned by numbered files in `core/schema/` (`001_name.sql`, `002_name.sql`, ...), never
 * by application code. Migrations run every time the database is opened, including for read-only
 * commands, so an older database is always brought up to date before it is queried. phuryn's
 * tool crashed reading an old schema because only its write path migrated (phuryn#153).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import { ensurePrivateDir, ensurePrivateFile, tightenMode } from "../install/private-files.js";

/** A better-sqlite3 database handle. */
export type Db = Database.Database;

/** One migration file. */
export interface Migration {
  /** Version number from the file name's numeric prefix. */
  readonly version: number;
  /** File name, e.g. `001_ingestion.sql`. */
  readonly name: string;
  /** The SQL to execute. */
  readonly sql: string;
}

/** A migrations directory that is misnumbered. Nothing has been applied when this is raised. */
export class MigrationListError extends Error {
  /**
   * Creates a migration list error.
   * @param message - What is wrong with the directory.
   */
  constructor(message: string) {
    super(message);
    this.name = "MigrationListError";
  }
}

/** Pattern every migration file name must match: a zero-padded number, underscore, name, `.sql`. */
export const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;

/**
 * Reads and orders the migration files in a directory.
 * @param dir - Directory containing `NNN_name.sql` files.
 * @returns Migrations in version order, starting at 1 with no gaps.
 * @throws {MigrationListError} If a `.sql` file is misnamed, a version repeats, or versions have gaps.
 */
export function listMigrations(dir: string): Migration[] {
  const migrations: Migration[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".sql")) {
      continue;
    }
    const match = MIGRATION_FILE.exec(name);
    // A misnamed file would silently never run, which is worse than refusing to start.
    if (match === null) {
      throw new MigrationListError(`migration file ${name} doesn't match NNN_name.sql`);
    }
    migrations.push({
      version: Number(match[1]),
      name,
      sql: readFileSync(join(dir, name), "utf8"),
    });
  }
  migrations.forEach((migration, index) => {
    // Versions must be exactly 1..N: a duplicate or a gap means a lost or conflicting file.
    if (migration.version !== index + 1) {
      throw new MigrationListError(
        `migration versions must run 1..N without gaps or repeats; found ${migration.name} at position ${index + 1}`,
      );
    }
  });
  return migrations;
}

/** SQL creating the table that records applied migrations. */
const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`;

/**
 * Returns the highest applied migration version.
 * @param db - An open database.
 * @returns 0 for a new database, otherwise the last applied version.
 */
export function schemaVersion(db: Db): number {
  db.exec(MIGRATIONS_TABLE);
  const row = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as {
    version: number;
  };
  return row.version;
}

/**
 * Applies every migration newer than the database's current version, each in its own transaction.
 * @param db - An open database.
 * @param migrations - Migrations from {@link listMigrations}.
 * @param now - Clock for `applied_at`, injected for tests.
 * @returns The versions applied by this call, in order; empty when already up to date.
 * @throws {Error} Whatever SQLite raises for a failing migration. That migration is rolled back
 *   completely, and earlier migrations from the same call stay applied.
 */
export function applyMigrations(
  db: Db,
  migrations: readonly Migration[],
  now: () => Date = () => new Date(),
): number[] {
  const current = schemaVersion(db);
  const record = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  const applied: number[] = [];
  for (const migration of migrations.filter((m) => m.version > current)) {
    // A transaction per migration: a failure leaves the schema at the last complete version.
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, now().toISOString());
    })();
    applied.push(migration.version);
  }
  return applied;
}

/**
 * Opens (creating if needed) the database and brings its schema up to date.
 * @param path - Database file path, or `:memory:` for tests.
 * @param migrationsDir - Directory of migration files.
 * @returns An open database with WAL journaling, a busy timeout, and foreign keys enforced.
 * @throws {MigrationListError} If the migrations directory is misnumbered.
 * @throws {Error} Whatever SQLite raises while opening or migrating.
 */
export function openDatabase(path: string, migrationsDir: string): Db {
  const migrations = listMigrations(migrationsDir);
  if (path !== ":memory:") {
    ensurePrivateDir(dirname(path));
    // SQLite creates the -wal and -shm files with the database file's mode, so creating the file
    // owner-only first keeps all three private (D-043). An existing file is tightened, never loosened.
    ensurePrivateFile(path);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      tightenMode(file);
    }
  }
  const db = new Database(path);
  // WAL lets the viewer read while an ingest writes; the busy timeout waits out short write locks.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  // SQLite leaves foreign keys off unless asked, per connection.
  db.pragma("foreign_keys = ON");
  applyMigrations(db, migrations);
  return db;
}
