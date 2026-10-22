/**
 * @file The Node.js version check that runs before any command (D-066).
 *
 * The database is Node's built-in `node:sqlite` (D-093). On a Node.js older than 24 it's missing
 * (Node 22.11 throws on import without a flag) or experimental (Node 22.23 prints a warning on
 * every run), and the suite isn't run there. Before D-093 the reason was harsher: better-sqlite3's
 * binary segfaulted under Node 22 (D-057, D-066). This module turns that into a sentence the user
 * can act on. It imports nothing, so the entry point can call it before loading `node:sqlite`.
 */

/** The oldest Node.js major Nilometer runs on: `.nvmrc` (the development version) and `engines`. */
export const SUPPORTED_NODE_MAJOR = 24;

/**
 * The majors the test suite runs on in CI: the long-term support lines from the minimum on (D-094).
 * An odd major between them is short-lived and isn't run.
 */
export const TESTED_NODE_MAJORS: readonly number[] = [24, 26];

/** The tested majors as words, e.g. "24 or 26". */
const TESTED_TEXT = TESTED_NODE_MAJORS.join(" or ");

/** Where the install guide lives, relative to the repository root. */
export const REQUIREMENTS_DOC = "docs/requirements.md";

/** What the entry point should do about the running Node.js version. */
export interface NodeVersionCheck {
  /**
   * `ok`: a tested major. `too_old`: stop, because the database isn't there or is experimental.
   * `untested`: run, with a warning, because no CI job runs it. `unrecognized`: run, with a warning,
   * because the version string couldn't be read.
   */
  readonly status: "ok" | "too_old" | "untested" | "unrecognized";
  /** The line to print to stderr, or undefined when there is nothing to say. */
  readonly message: string | undefined;
}

/**
 * Decides whether a Node.js version can run Nilometer, and what to tell the user.
 *
 * Older majors stop: `node:sqlite` is missing or experimental there (D-093). A tested major runs
 * quietly. Any other major from the minimum on runs with a warning, since no CI job runs it (D-066,
 * D-094): Node 26 was such a major until SQLite 3.54 broke two views on it.
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
      message: `Nilometer couldn't read the Node.js version ("${version}"). It needs Node.js ${TESTED_TEXT}; see ${REQUIREMENTS_DOC} if a command fails.`,
    };
  }
  const major = Number(match[1]);
  if (major < SUPPORTED_NODE_MAJOR) {
    return {
      status: "too_old",
      message: `Nilometer needs Node.js ${SUPPORTED_NODE_MAJOR} or newer, and this is Node.js ${version}. Older versions lack the SQLite built into Node.js ${SUPPORTED_NODE_MAJOR}, or have only an experimental one. Install Node.js ${TESTED_TEXT} (see ${REQUIREMENTS_DOC} in the Nilometer repository) and run the command again. Nothing was changed.`,
    };
  }
  if (!TESTED_NODE_MAJORS.includes(major)) {
    return {
      status: "untested",
      message: `Nilometer is tested on Node.js ${TESTED_TEXT}, and this is Node.js ${version}. Other versions aren't tested; if a command fails, switch to Node.js ${TESTED_TEXT} (see ${REQUIREMENTS_DOC} in the Nilometer repository).`,
    };
  }
  return { status: "ok", message: undefined };
}
