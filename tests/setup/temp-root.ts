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
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates the run's temporary root and points TMPDIR, TEMP, and TMP at it.
 * @returns Teardown that removes the root and everything tests left in it.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "aua-vitest-"));
  for (const name of ["TMPDIR", "TEMP", "TMP"]) {
    process.env[name] = root;
  }
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
