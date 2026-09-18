/**
 * @file Vitest global setup: one temporary root per test run, removed when the run ends.
 *
 * Tests create scratch directories with `mkdtempSync(join(tmpdir(), ...))` and don't delete them.
 * Pointing the temp variables at a run-scoped directory before workers start makes `os.tmpdir()`
 * return it in every worker and every child process, so one removal at teardown cleans up after all
 * of them. Before this existed, thousands of leftover directories filled the disk.
 *
 * `os.tmpdir()` reads TMPDIR on macOS and Linux but TEMP and TMP on Windows, so all three are set
 * (D-049). A Windows run once left 336 folders behind when only TMPDIR was.
 *
 * The root is canonicalized before anything derives a path from it, so every test and child process
 * spells it the way the filesystem does (D-055).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates the run's temporary root and points TMPDIR, TEMP, and TMP at it.
 * @returns Teardown that removes the root and everything tests left in it.
 */
export default function setup(): () => void {
  // `realpathSync.native`, not `realpathSync`: on Windows a user name longer than eight characters
  // appears in TEMP as an 8.3 short name (`RUNNER~1`), and git reports the long one
  // (`runneradmin`). A test comparing a path it built against a path git returned would then differ
  // by spelling alone, for the same directory. Only `.native` expands the short form; plain
  // `realpathSync` keeps it. It also resolves the macOS `/var` → `/private/var` symlink, which
  // individual tests were already doing for the same reason (D-055).
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aua-vitest-")));
  for (const name of ["TMPDIR", "TEMP", "TMP"]) {
    process.env[name] = root;
  }
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
