/**
 * @file The Node.js version check that runs before any command (D-066).
 *
 * `better-sqlite3`'s prebuilt binary crashes on a Node.js older than the one this package is
 * built for: under Node 22 every command that opens the database exits 139 (a segfault) with no
 * message, while `--help` still works. That was observed on the development machine (D-057,
 * D-066). This module turns that into a sentence the user can act on. It imports nothing, so the
 * entry point can call it before loading any module that could load the native binary.
 */

/** The Node.js major version this package is built and tested on: `.nvmrc` and `engines`. */
export const SUPPORTED_NODE_MAJOR = 24;

/** Where the install guide lives, relative to the repository root. */
export const REQUIREMENTS_DOC = "docs/requirements.md";

/** What the entry point should do about the running Node.js version. */
export interface NodeVersionCheck {
  /**
   * `ok`: the supported major. `too_old`: stop, because the database would crash.
   * `newer`: run, with a warning, because it isn't tested. `unrecognized`: run, with a warning,
   * because the version string couldn't be read.
   */
  readonly status: "ok" | "too_old" | "newer" | "unrecognized";
  /** The line to print to stderr, or undefined when there is nothing to say. */
  readonly message: string | undefined;
}

/**
 * Decides whether a Node.js version can run Nilometer, and what to tell the user.
 *
 * Older majors stop: their crash was observed, and it happens mid-command with no explanation.
 * Newer majors only warn: Node 26 passed the whole test suite on 2026-09-24, but no CI job runs
 * one, so it isn't claimed as supported (D-066).
 * @param version - `process.versions.node`, such as `24.21.0` (no leading `v`).
 * @returns The status and the message to print, if any.
 * @example
 * checkNodeVersion("24.21.0").status; // "ok"
 * checkNodeVersion("22.11.0").status; // "too_old"
 */
export function checkNodeVersion(version: string): NodeVersionCheck {
  // `process.versions.node` has no "v"; tolerate one anyway so a caller passing
  // `process.version` gets the same answer.
  const match = /^v?(\d+)\.\d+\.\d+/.exec(version);
  if (match === null) {
    return {
      status: "unrecognized",
      message: `Nilometer couldn't read the Node.js version ("${version}"). It needs Node.js ${SUPPORTED_NODE_MAJOR}; see ${REQUIREMENTS_DOC} if a command fails.`,
    };
  }
  const major = Number(match[1]);
  if (major < SUPPORTED_NODE_MAJOR) {
    return {
      status: "too_old",
      message: `Nilometer needs Node.js ${SUPPORTED_NODE_MAJOR}, and this is Node.js ${version}. On an older version the database crashes as soon as it opens. Install Node.js ${SUPPORTED_NODE_MAJOR} (see ${REQUIREMENTS_DOC} in the Nilometer repository) and run the command again. Nothing was changed.`,
    };
  }
  if (major > SUPPORTED_NODE_MAJOR) {
    return {
      status: "newer",
      message: `Nilometer is tested on Node.js ${SUPPORTED_NODE_MAJOR}, and this is Node.js ${version}. Newer versions aren't tested; if a command fails, switch to Node.js ${SUPPORTED_NODE_MAJOR} (see ${REQUIREMENTS_DOC} in the Nilometer repository).`,
    };
  }
  return { status: "ok", message: undefined };
}
