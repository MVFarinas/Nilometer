/**
 * @file Attributing working directories to repositories through git (docs/development.md P4.6, D-010, D-028).
 *
 * A repository is identified by git's common directory, not by the working directory's name. A
 * worktree is a different directory but the same repository, and a subdirectory is not a separate
 * project. ccusage (encoded directory names) and phuryn (last two path segments) both split one
 * repository into several.
 *
 * Resolution depends on the filesystem today, not only on the logs, so results are cached in the
 * `repositories` table, outside the tables that must rebuild identically from raw lines. Because the
 * filesystem changes (folders are renamed and deleted), every run re-checks whether each cached
 * directory and its repository root still exist, and resolves again only when that changed (D-028).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";

import type { Db } from "../db/database.js";

/** How a missing working directory got its repository (D-028). */
export type MissingVia = "last_known" | "parent" | "none";

/** How one working directory resolved. */
export type RepoResolution =
  | { readonly kind: "repo"; readonly repoRoot: string }
  | { readonly kind: "not_git" }
  | {
      readonly kind: "missing";
      /** Last-known or nearest existing parent's repository root, or null when neither applies. */
      readonly repoRoot: string | null;
      /** Where `repoRoot` came from; `none` exactly when it's null. */
      readonly via: MissingVia;
    };

/**
 * Runs git with the given arguments. Injected so tests can count calls.
 * @param args - Arguments after `git`.
 * @returns Exit code and trimmed stdout.
 */
export type GitRunner = (args: readonly string[]) => { exitCode: number; stdout: string };

/**
 * Runs the real git binary.
 * @param args - Arguments after `git`.
 * @returns Exit code (127 if git can't start) and trimmed stdout.
 */
export function runGit(args: readonly string[]): { exitCode: number; stdout: string } {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return { exitCode: result.status ?? 127, stdout: (result.stdout ?? "").trim() };
}

/**
 * Asks git for the repository containing an existing directory.
 * @param dir - An existing directory.
 * @param git - Git runner.
 * @returns The repository root, or null when git finds no repository.
 */
export function gitRoot(dir: string, git: GitRunner): string | null {
  // --path-format=absolute (git 2.31+) avoids resolving a relative ".git" against the wrong base.
  const result = git(["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (result.exitCode !== 0 || result.stdout === "") {
    return null;
  }
  // A normal repository's common dir is <root>/.git, shared by every worktree. A bare repository's
  // common dir is the repository itself.
  const common = result.stdout;
  return basename(common) === ".git" ? dirname(common) : common;
}

/**
 * Resolves a working directory to its repository.
 * @param cwd - A working directory recorded in a log line.
 * @param lastKnownRoot - The repository root git gave while the directory still existed, if any.
 * @param git - Git runner.
 * @param exists - Existence check, injectable for tests.
 * @returns For an existing directory, git's repository root or `not_git`. For a missing one
 *   (D-028): the last-known root if given; otherwise the repository containing its nearest
 *   existing parent folder; otherwise no root.
 */
export function resolveRepo(
  cwd: string,
  lastKnownRoot: string | null = null,
  git: GitRunner = runGit,
  exists: (path: string) => boolean = existsSync,
): RepoResolution {
  if (exists(cwd)) {
    const root = gitRoot(cwd, git);
    return root === null ? { kind: "not_git" } : { kind: "repo", repoRoot: root };
  }
  // Git verified this root while the directory existed; that outranks any lookup from a parent.
  if (lastKnownRoot !== null) {
    return { kind: "missing", repoRoot: lastKnownRoot, via: "last_known" };
  }
  let parent = dirname(cwd);
  // dirname of the filesystem root is the root itself, so the walk always ends.
  while (!exists(parent) && dirname(parent) !== parent) {
    parent = dirname(parent);
  }
  const root = exists(parent) ? gitRoot(parent, git) : null;
  return root === null
    ? { kind: "missing", repoRoot: null, via: "none" }
    : { kind: "missing", repoRoot: root, via: "parent" };
}

/** A cached resolution, as stored in `repositories`. */
interface CachedRow {
  /** `cwd` column. */
  readonly cwd: string;
  /** `kind` column. */
  readonly kind: RepoResolution["kind"];
  /** `repo_root` column. */
  readonly repo_root: string | null;
  /** `root_exists` column. */
  readonly root_exists: number | null;
  /** `resolved_via` column. */
  readonly resolved_via: string;
}

/**
 * Reports whether a cached row no longer matches the filesystem (D-028).
 * @param row - The cached row.
 * @param exists - Existence check.
 * @returns True when the directory appeared or disappeared, or its root's existence changed.
 */
export function isStale(row: CachedRow, exists: (path: string) => boolean): boolean {
  if (exists(row.cwd) !== (row.kind !== "missing")) {
    return true;
  }
  return row.repo_root !== null && exists(row.repo_root) !== (row.root_exists === 1);
}

/**
 * Resolves working directories seen in log lines that have no cached resolution, and resolves
 * again any cached one the filesystem no longer matches.
 * @param db - Open, migrated database with derived tables up to date.
 * @param now - Clock for `resolved_at`.
 * @param resolve - Resolution function, given the last-known root; defaults to {@link resolveRepo}.
 * @param exists - Existence check for re-validation and `root_exists`, injectable for tests.
 * @returns Number of working directories resolved by this call (new plus re-resolved).
 */
export function resolveRepositories(
  db: Db,
  now: () => Date,
  resolve: (cwd: string, lastKnownRoot: string | null) => RepoResolution = (cwd, lastKnownRoot) =>
    resolveRepo(cwd, lastKnownRoot),
  exists: (path: string) => boolean = existsSync,
): number {
  const pending = db
    .prepare(
      `SELECT DISTINCT p.cwd FROM parsed_lines p
       LEFT JOIN repositories r ON r.cwd = p.cwd
       WHERE p.cwd IS NOT NULL AND r.cwd IS NULL
       ORDER BY p.cwd`,
    )
    .all() as { cwd: string }[];
  const stale = (
    db
      .prepare(
        "SELECT cwd, kind, repo_root, root_exists, resolved_via FROM repositories ORDER BY cwd",
      )
      .all() as CachedRow[]
  ).filter((row) => isStale(row, exists));
  const upsert = db.prepare(
    `INSERT INTO repositories (cwd, kind, repo_root, root_exists, resolved_via, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (cwd) DO UPDATE SET kind = excluded.kind, repo_root = excluded.repo_root,
       root_exists = excluded.root_exists, resolved_via = excluded.resolved_via,
       resolved_at = excluded.resolved_at`,
  );
  /**
   * Resolves one directory and stores the result.
   * @param cwd - The working directory.
   * @param lastKnownRoot - Its last git-verified root, if any.
   */
  const store = (cwd: string, lastKnownRoot: string | null): void => {
    const resolution = resolve(cwd, lastKnownRoot);
    const root = resolution.kind === "not_git" ? null : resolution.repoRoot;
    upsert.run(
      cwd,
      resolution.kind,
      root,
      root === null ? null : exists(root) ? 1 : 0,
      resolution.kind === "missing" ? resolution.via : "git",
      now().toISOString(),
    );
  };
  db.transaction(() => {
    for (const { cwd } of pending) {
      store(cwd, null);
    }
    for (const row of stale) {
      // A root counts as last known only if git gave it: directly, or carried from an earlier git answer.
      const verified = row.resolved_via === "git" || row.resolved_via === "last_known";
      store(row.cwd, verified ? row.repo_root : null);
    }
  })();
  return pending.length + stale.length;
}
