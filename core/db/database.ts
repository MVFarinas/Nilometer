/**
 * @file Opening the SQLite database and applying numbered SQL migrations (docs/development.md P3.1).
 *
 * Implements README § Tech stack ("analysis logic lives in SQL") and D-093 (Node's built-in `node:sqlite`,
 * which replaced better-sqlite3 so an npm install needs no native module).
 * Schema is owned by numbered files in `core/schema/` (`001_name.sql`, `002_name.sql`, ...), never
 * by application code. Migrations run every time the database is opened, including for read-only
 * commands, so an older database is always brought up to date before it is queried. phuryn's
 * tool crashed reading an old schema because only its write path migrated (phuryn#153).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { DatabaseSync } from "node:sqlite";

import { ensurePrivateDir, ensurePrivateFile, tightenMode } from "../install/private-files.js";
import { refreshStoredViews } from "./stored-views.js";
import { transaction } from "./transaction.js";

/** A `node:sqlite` database handle. */
export type Db = DatabaseSync;

export { transaction };

/**
 * The newest migration this build was written for. Migrations are read from `core/schema` at run time,
 * but the code that keeps their tables right is compiled, so a clone pulled without `npm run build`
 * once ran migration 032 under code that never refreshed its tables (M15). A test keeps this equal to
 * the files in `core/schema`.
 */
export const BUILT_SCHEMA_VERSION = 32;

/** The schema files or the database are newer than this build. Raised before anything is applied. */
export class SchemaVersionError extends Error {
  /**
   * Creates the error.
   * @param message - Which side is newer, and what to do.
   */
  constructor(message: string) {
    super(message);
    this.name = "SchemaVersionError";
  }
}

/**
 * Views a BLOB read from the database as a Buffer, without copying it. node:sqlite returns blobs as
 * plain `Uint8Array`s, whose `toString("utf8")` doesn't decode: it joins the byte values with commas,
 * so a line read without this would parse as malformed instead of failing (D-093).
 * @param blob - A BLOB column's value.
 * @returns The same bytes as a Buffer.
 */
export function blobBytes(blob: Uint8Array): Buffer {
  return Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
}

/**
 * Reads one pragma's value.
 * @param db - An open database.
 * @param name - The pragma, e.g. `journal_mode`.
 * @returns The first column of its first row, or undefined when it returns none.
 */
export function pragmaValue(db: Db, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

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
    transaction(db, () => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, now().toISOString());
    });
    applied.push(migration.version);
  }
  return applied;
}

/**
 * Opens (creating if needed) the database and brings its schema up to date.
 * @param path - Database file path, or `:memory:` for tests.
 * @param migrationsDir - Directory of migration files.
 * @param builtVersion - The newest migration this build knows; injected by tests.
 * @returns An open database with WAL journaling, a busy timeout, foreign keys enforced, and its
 *   stored views up to date.
 * @throws {MigrationListError} If the migrations directory is misnumbered.
 * @throws {SchemaVersionError} If the schema files, or the database, are newer than this build.
 * @throws {Error} Whatever SQLite raises while opening or migrating.
 */
export function openDatabase(
  path: string,
  migrationsDir: string,
  builtVersion: number = BUILT_SCHEMA_VERSION,
): Db {
  const migrations = listMigrations(migrationsDir);
  const newest = migrations.at(-1)?.version ?? 0;
  // Before anything is created or applied: newer schema files under older code is how a pulled clone
  // without a build left migration 032's tables stale on every later ingest (M15).
  if (newest > builtVersion) {
    throw new SchemaVersionError(
      `this build of Nilometer knows migrations up to ${builtVersion}, but its schema folder holds ${newest}, so the compiled code is older than its schema files. In a clone, run npm run build after pulling`,
    );
  }
  if (path !== ":memory:") {
    ensurePrivateDir(dirname(path));
    // SQLite creates the -wal and -shm files with the database file's mode, so creating the file
    // owner-only first keeps all three private (D-043). An existing file is tightened, never loosened.
    ensurePrivateFile(path);
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      tightenMode(file);
    }
  }
  // The timeout is SQLite's busy timeout: it waits out short write locks instead of failing at once.
  const db = new DatabaseSync(path, { timeout: 5000 });
  // WAL lets the viewer read while an ingest writes.
  db.exec("PRAGMA journal_mode = WAL");
  // SQLite leaves foreign keys off unless asked, per connection. node:sqlite turns them on by default;
  // saying so here keeps the requirement visible rather than inherited.
  db.exec("PRAGMA foreign_keys = ON");
  const applied = schemaVersion(db);
  // A database a newer build migrated has tables this build doesn't know how to keep right.
  if (applied > builtVersion) {
    db.close();
    throw new SchemaVersionError(
      `this database was updated by a newer Nilometer (schema ${applied}), and this build knows schema ${builtVersion}. Update Nilometer, or in a clone run npm run build`,
    );
  }
  applyMigrations(db, migrations);
  // Stored views left stale by anything that wrote their inputs without refilling them are refilled
  // before anyone reads them; when nothing changed this is a 17 ms check (M15, D-096).
  if (hasStoredViews(db)) {
    refreshStoredViews(db);
  }
  return db;
}

/**
 * Whether the schema has the stored views (migration 032 on).
 * @param db - An open, migrated database.
 * @returns True when `requests_dedup_computed` exists.
 */
function hasStoredViews(db: Db): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'requests_dedup_computed'",
      )
      .get() !== undefined
  );
}
