/**
 * @file Where the tool keeps its data and where the hook script lives.
 *
 * Implements docs/development.md P1.3 and the `statusline-collector` skill ("Spool path: under the tool's data
 * directory, never inside `~/.claude`"). The data directory holds the spool, the hook's error log,
 * and the install record; later phases add the database there.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { expandHome } from "../util/paths.js";

/** Environment variables that affect the data directory. */
export interface DataDirEnv {
  /** Explicit data directory for this tool. May start with `~`. */
  readonly NILOMETER_HOME?: string | undefined;
  /** XDG base directory for user data. */
  readonly XDG_DATA_HOME?: string | undefined;
}

/** Inputs to {@link resolveDataDir}. */
export interface DataDirOptions {
  /** The user's home directory. */
  readonly home: string;
  /** Relevant environment variables. */
  readonly env: DataDirEnv;
  /** Explicit `--data-dir` flag; wins over the environment. May start with `~`. */
  readonly override?: string | undefined;
}

/** Directory name used under the XDG data home. */
export const DATA_DIR_NAME = "nilometer";

/**
 * Resolves the tool's data directory.
 *
 * Order: `--data-dir`, then `$NILOMETER_HOME`, then `$XDG_DATA_HOME/nilometer`,
 * then `~/.local/share/nilometer`. XDG's default is used on macOS too, so every platform
 * has one documented location instead of a per-OS guess.
 * @param options - Home directory, environment, and flag override.
 * @returns An absolute data directory path (it may not exist yet).
 */
export function resolveDataDir(options: DataDirOptions): string {
  const explicit = [options.override, options.env.NILOMETER_HOME].find(
    (value): value is string => value !== undefined && value !== "",
  );
  if (explicit !== undefined) {
    // Always absolute (D-050): `init` writes this path into the status line command, and the hook
    // resolves a relative one against whatever project Claude Code runs in. A folder committed to a
    // repository could then supply the wrapped command the hook executes.
    return resolve(expandHome(explicit, options.home));
  }
  const xdg = options.env.XDG_DATA_HOME;
  // XDG says relative values are invalid and must be ignored.
  if (xdg !== undefined && xdg.startsWith("/")) {
    return join(xdg, DATA_DIR_NAME);
  }
  return join(options.home, ".local", "share", DATA_DIR_NAME);
}

/** Path of the hook script relative to the package root. */
export const HOOK_RELATIVE_PATH = join("hooks", "statusline.sh");

/**
 * The hook's name inside the data directory, where `init` installs a copy of it (D-056).
 *
 * The status line command has to name a path that nothing moves. A path inside the package moves
 * whenever the package does: a global npm install lives under the Node version in use, so upgrading
 * Node leaves the command pointing at a file that no longer exists, and readings stop with no
 * error. The data directory is chosen by the user and never moves on its own.
 */
export const INSTALLED_HOOK_FILE = "statusline.sh";

/**
 * Finds the package root by walking up from a directory until `hooks/statusline.sh` and
 * `package.json` both exist.
 *
 * Works whether code runs from source (`core/install/`) or from the build (`dist/core/install/`),
 * because the build doesn't copy the shell script.
 * @param startDir - Directory to start from, usually this module's own directory.
 * @param exists - File existence check, injectable for tests.
 * @returns The package root directory.
 * @throws {Error} If no ancestor contains both files.
 */
export function findPackageRoot(
  startDir: string,
  exists: (path: string) => boolean = existsSync,
): string {
  let current = startDir;
  for (;;) {
    if (exists(join(current, "package.json")) && exists(join(current, HOOK_RELATIVE_PATH))) {
      return current;
    }
    const parent = dirname(current);
    // dirname of the filesystem root is the root itself: nowhere left to look.
    if (parent === current) {
      throw new Error(`could not find ${HOOK_RELATIVE_PATH} above ${startDir}`);
    }
    current = parent;
  }
}
