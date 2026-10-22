/**
 * @file Repository aliases the user enters, so a renamed or moved project counts as one (D-092).
 *
 * Nothing in the logs links a repository's old path to its new one (D-028). The user enters the
 * link with `nilometer alias set <old> <new>`; `request_repositories` then counts the old path's
 * requests under the new one and keeps the old path beside each, so every number still traces back.
 * Like plan prices, these rows are user data: rebuilds never touch them.
 */
import { isAbsolute, posix, win32 } from "node:path";

import { type Db, transaction } from "../db/database.js";

/** An alias entry. */
export interface AliasEntry {
  /** A repository path exactly as requests were attributed to it (the old name or place). */
  readonly from: string;
  /** The repository path its requests count under. */
  readonly to: string;
}

/** A stored alias. */
export interface AliasRow extends AliasEntry {
  /** ISO-8601 UTC time the row was written. */
  readonly enteredAt: string;
}

/** An alias that can't be stored or removed; its message says why. */
export class RepositoryAliasError extends Error {
  /**
   * Creates the error.
   * @param message - What's wrong.
   */
  constructor(message: string) {
    super(message);
    this.name = "RepositoryAliasError";
  }
}

/**
 * Turns a path the user typed into the form repositories are stored in: `~/` expanded against the
 * home directory, and no trailing separator. A Windows path keeps its drive letter (D-049).
 * @param path - The path as typed.
 * @param home - The home directory, for `~/`.
 * @returns The path, ready to compare with stored repositories.
 * @throws {RepositoryAliasError} If it isn't absolute after `~/` is expanded.
 */
export function normalizeRepositoryPath(path: string, home: string): string {
  const typed = path.trim();
  const expanded = typed === "~" || typed.startsWith("~/") ? home + typed.slice(1) : typed;
  if (!isAbsolute(expanded) && !win32.isAbsolute(expanded) && !posix.isAbsolute(expanded)) {
    throw new RepositoryAliasError(`a repository path must be absolute, got "${typed}"`);
  }
  // A trailing separator would never match a stored repository; the root itself keeps its own.
  return expanded.length > 1 ? expanded.replace(/[\\/]+$/, "") : expanded;
}

/**
 * Validates an entry from user input.
 * @param from - The old path, as typed.
 * @param to - The new path, as typed.
 * @param home - The home directory, for `~/`.
 * @returns Both paths normalized.
 * @throws {RepositoryAliasError} If either isn't absolute, or both are the same path.
 */
export function validateAlias(from: string, to: string, home: string): AliasEntry {
  const entry = {
    from: normalizeRepositoryPath(from, home),
    to: normalizeRepositoryPath(to, home),
  };
  if (entry.from === entry.to) {
    throw new RepositoryAliasError(`an alias joins two different paths; both are ${entry.from}`);
  }
  return entry;
}

/**
 * Stores an alias, replacing any for the same old path.
 * @param db - Open, migrated database.
 * @param entry - A validated entry.
 * @param now - Clock for `entered_at`.
 * @returns The alias it replaced, or null when the old path had none.
 * @throws {RepositoryAliasError} If no request is attributed to the old path, or the alias would
 *   chain: its new path is another alias's old one, or its old path is another alias's new one.
 */
export function setAlias(db: Db, entry: AliasEntry, now: () => Date): AliasRow | null {
  return transaction(db, () => {
    // Attributed before any alias: the path a request had, whether or not an alias moved it since.
    const recorded = db
      .prepare(
        "SELECT 1 FROM request_repositories WHERE COALESCE(aliased_from, repository) = ? LIMIT 1",
      )
      .get(entry.from);
    if (recorded === undefined) {
      throw new RepositoryAliasError(
        `no Claude Code request is recorded under ${entry.from}; nilometer report --json lists each repository's full path`,
      );
    }
    // One step only: a chain or a loop would make "counts under" depend on the order rows are read.
    const chained = db
      .prepare(
        `SELECT from_repository, to_repository FROM repository_aliases
         WHERE (from_repository = :to) OR (to_repository = :from AND from_repository <> :from)
         LIMIT 1`,
      )
      .get({ from: entry.from, to: entry.to }) as
      { from_repository: string; to_repository: string } | undefined;
    if (chained !== undefined) {
      throw new RepositoryAliasError(
        `aliases go one step: ${chained.from_repository} already counts under ${chained.to_repository}`,
      );
    }
    const previous = readRow(db, entry.from);
    db.prepare(
      `INSERT INTO repository_aliases (from_repository, to_repository, entered_at) VALUES (?, ?, ?)
       ON CONFLICT (from_repository) DO UPDATE SET
         to_repository = excluded.to_repository, entered_at = excluded.entered_at`,
    ).run(entry.from, entry.to, now().toISOString());
    return previous;
  });
}

/**
 * Removes the alias for an old path.
 * @param db - Open, migrated database.
 * @param from - The old path, normalized.
 * @returns The alias removed.
 * @throws {RepositoryAliasError} If there's no alias for it.
 */
export function removeAlias(db: Db, from: string): AliasRow {
  const previous = readRow(db, from);
  if (previous === null) {
    throw new RepositoryAliasError(`there's no alias for ${from}`);
  }
  db.prepare("DELETE FROM repository_aliases WHERE from_repository = ?").run(from);
  return previous;
}

/**
 * Lists every alias, by old path.
 * @param db - Open, migrated database.
 * @returns The rows.
 */
export function listAliases(db: Db): AliasRow[] {
  return (
    db
      .prepare(
        "SELECT from_repository, to_repository, entered_at FROM repository_aliases ORDER BY from_repository",
      )
      .all() as unknown as StoredRow[]
  ).map(toRow);
}

/** A `repository_aliases` row as SQLite returns it. */
interface StoredRow {
  /** `from_repository` column. */
  readonly from_repository: string;
  /** `to_repository` column. */
  readonly to_repository: string;
  /** `entered_at` column. */
  readonly entered_at: string;
}

/**
 * Reads the alias for one old path.
 * @param db - Open, migrated database.
 * @param from - The old path.
 * @returns The row, or null when there is none.
 */
function readRow(db: Db, from: string): AliasRow | null {
  const row = db
    .prepare(
      "SELECT from_repository, to_repository, entered_at FROM repository_aliases WHERE from_repository = ?",
    )
    .get(from) as StoredRow | undefined;
  return row === undefined ? null : toRow(row);
}

/**
 * Converts a stored row.
 * @param row - The row as SQLite returns it.
 * @returns The alias.
 */
function toRow(row: StoredRow): AliasRow {
  return { from: row.from_repository, to: row.to_repository, enteredAt: row.entered_at };
}
