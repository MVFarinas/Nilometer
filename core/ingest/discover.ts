/**
 * @file Finding Claude Code session logs (docs/development.md P4.1, `ingest-session-logs` skill § 1).
 *
 * Roots follow ccusage's resolution so both tools read the same logs (D-011): an explicit
 * `CLAUDE_CONFIG_DIR` (comma-separated) wins; otherwise `$XDG_CONFIG_HOME/claude` and `~/.claude`.
 * Each root's `projects/` tree is walked with no depth limit, because subagent transcripts live
 * below session directories and a depth cap silently misses them (haasonsaas).
 */
import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { expandHome } from "../util/paths.js";

/** Environment variables that choose log roots. */
export interface RootEnv {
  /** Comma-separated Claude config directories; when set, the defaults aren't used. */
  readonly CLAUDE_CONFIG_DIR?: string | undefined;
  /** XDG config home; only an absolute value is used. */
  readonly XDG_CONFIG_HOME?: string | undefined;
}

/** `CLAUDE_CONFIG_DIR` is set but names no usable directory. Nothing is read when this is raised. */
export class DiscoveryError extends Error {
  /**
   * Creates a discovery error.
   * @param message - What is wrong.
   */
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/**
 * Reports whether a path is an existing directory.
 * @param path - Path to test.
 * @returns True for a directory; false if missing, not a directory, or unreadable.
 */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves the roots whose `projects/` directories hold session logs.
 * @param env - Relevant environment variables.
 * @param home - The user's home directory.
 * @param isDir - Directory test, injectable for tests.
 * @returns Roots in priority order, each containing a `projects/` directory; may be empty.
 * @throws {DiscoveryError} If `CLAUDE_CONFIG_DIR` is set and none of its entries has `projects/`.
 */
export function resolveRoots(
  env: RootEnv,
  home: string,
  isDir: (path: string) => boolean = isDirectory,
): string[] {
  const explicit = env.CLAUDE_CONFIG_DIR?.trim();
  if (explicit !== undefined && explicit !== "") {
    const entries = explicit
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "")
      .map((entry) => expandHome(entry, home));
    const roots = unique(entries.filter((root) => isDir(join(root, "projects"))));
    // An explicit setting that matches nothing is a mistake worth stopping for, not an empty report.
    if (roots.length === 0) {
      throw new DiscoveryError(
        `CLAUDE_CONFIG_DIR is set but none of its entries contains a projects/ directory: ${explicit}`,
      );
    }
    return roots;
  }
  const candidates: string[] = [];
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.startsWith("/")) {
    candidates.push(join(xdg, "claude"));
  }
  candidates.push(join(home, ".claude"));
  return unique(candidates.filter((root) => isDir(join(root, "projects"))));
}

/**
 * Removes repeated strings, keeping the first occurrence.
 * @param values - Values in priority order.
 * @returns The values without repeats, order preserved.
 */
export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Compares two strings by their UTF-8 bytes, the order fixtures/README.md defines for files.
 * @param a - First string.
 * @param b - Second string.
 * @returns Negative, zero, or positive, like `Array.prototype.sort` expects.
 */
export function compareBytes(a: string, b: string): number {
  // JavaScript's default string order is by UTF-16 code unit, which differs from byte order
  // for characters outside the Basic Multilingual Plane.
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Directory listing function, injectable so walking can be tested without special filesystems. */
export type ListDir = (path: string) => Dirent[];

/**
 * Lists every `.jsonl` file under a root's `projects/` directory.
 * @param root - A root from {@link resolveRoots}.
 * @param listDir - Directory listing; defaults to the real filesystem.
 * @returns Paths relative to the root (starting `projects/`), joined with `/` on every platform and
 *   sorted by UTF-8 bytes.
 */
export function discoverLogFiles(
  root: string,
  listDir: ListDir = (path) => readdirSync(path, { withFileTypes: true }),
): string[] {
  const found: string[] = [];
  /**
   * Walks one directory, collecting `.jsonl` files.
   * @param relative - Directory path relative to the root.
   */
  const walk = (relative: string): void => {
    for (const entry of listDir(join(root, relative))) {
      // "/" on every platform, so stored paths, fixtures, and explain's locations match on Windows (D-049).
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        // Symlinks are neither files nor directories to Dirent, so they're skipped: following
        // them could loop or read outside the root.
        found.push(child);
      }
    }
  };
  walk("projects");
  return found.sort(compareBytes);
}
