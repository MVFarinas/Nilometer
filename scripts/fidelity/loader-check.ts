/**
 * @file Loader fidelity check (audit check A6c; docs/development.md P4.5, `verify-against-ccusage` skill).
 *
 * For every fixture case, stages each state into a temporary root the way Claude Code changes
 * files (overwriting in place, and separately replacing files), runs the real ingest, and compares
 * the result with the hand-computed `expected.json` field by field. The reference implementation
 * already matches those files (A6b), so agreement here means the loader agrees with two independent
 * sources.
 *
 * Then it proves re-runnability (check 4 of the fidelity suite): the fingerprints of raw and derived
 * tables must be identical after an incremental re-ingest, a full rescan, and a rebuild of the
 * derived tables.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { openDatabase } from "../../core/db/database.js";
import { fingerprintTables } from "../../core/db/fingerprint.js";
import { ensureDerived, rebuildDerived } from "../../core/ingest/derive.js";
import { ingestLogs } from "../../core/ingest/ingest.js";
import { readResult } from "../../core/ingest/results.js";

/** How a state's files are put in place before an ingest. */
export type StagingMode = "overwrite" | "replace";

/** Tables whose contents must survive re-ingest and rebuild unchanged. */
export const IDEMPOTENT_TABLES = [
  "raw_lines",
  "parsed_lines",
  "requests",
  "events",
  "line_problems",
];

/** One state of a fixture case. */
export interface FixtureStateDir {
  /** `final`, `run-1`, `run-2`, ... */
  readonly name: string;
  /** Directory containing `projects/`. */
  readonly dir: string;
}

/**
 * Lists a case's states in ingest order.
 * @param caseDir - A fixture case directory.
 * @returns `[final]` for single-state cases, else `run-1`, `run-2`, ... in numeric order.
 */
export function statesOf(caseDir: string): FixtureStateDir[] {
  if (existsSync(join(caseDir, "projects"))) {
    return [{ name: "final", dir: caseDir }];
  }
  return readdirSync(caseDir)
    .filter((name) => /^run-\d+$/.test(name))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
    .map((name) => ({ name, dir: join(caseDir, name) }));
}

/**
 * Lists every file under a directory.
 * @param dir - Directory to walk.
 * @returns Paths relative to `dir`, sorted.
 */
export function listFilesRecursive(dir: string): string[] {
  return (
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      // "/" on every platform, like discovery's stored paths (D-049).
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
      .sort()
  );
}

/**
 * Puts a state's `projects/` tree into a root.
 * @param stateDir - Directory containing `projects/`.
 * @param root - Staging root.
 * @param mode - `overwrite` rewrites existing files in place (same inode); `replace` removes the
 *   tree first, so every file is new (new inode).
 */
export function stageState(stateDir: string, root: string, mode: StagingMode): void {
  if (mode === "replace") {
    rmSync(join(root, "projects"), { recursive: true, force: true });
    cpSync(join(stateDir, "projects"), join(root, "projects"), { recursive: true });
    return;
  }
  for (const file of listFilesRecursive(join(stateDir, "projects"))) {
    const target = join(root, "projects", file);
    mkdirSync(dirname(target), { recursive: true });
    // copyFileSync truncates an existing destination and rewrites it, keeping its inode.
    copyFileSync(join(stateDir, "projects", file), target);
  }
}

/**
 * Lists the JSON paths where two values differ.
 * @param expected - Expected value.
 * @param actual - Actual value.
 * @param path - Path of these values, `$` at the top.
 * @returns One line per difference, e.g. `$.requests[0].output_tokens: expected 42, got 20`.
 */
export function diffValues(expected: unknown, actual: unknown, path = "$"): string[] {
  if (isDeepStrictEqual(expected, actual)) {
    return [];
  }
  const bothArrays = Array.isArray(expected) && Array.isArray(actual);
  const bothObjects =
    !bothArrays &&
    typeof expected === "object" &&
    typeof actual === "object" &&
    expected !== null &&
    actual !== null &&
    !Array.isArray(expected) &&
    !Array.isArray(actual);
  if (bothArrays) {
    const differences: string[] = [];
    if (expected.length !== actual.length) {
      differences.push(`${path}: expected ${expected.length} items, got ${actual.length}`);
    }
    for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
      differences.push(...diffValues(expected[index], actual[index], `${path}[${index}]`));
    }
    return differences;
  }
  if (bothObjects) {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    return [...new Set([...Object.keys(e), ...Object.keys(a)])]
      .sort()
      .flatMap((key) =>
        key in e && key in a
          ? diffValues(e[key], a[key], `${path}.${key}`)
          : [`${path}.${key}: ${key in e ? "missing" : "unexpected"}`],
      );
  }
  return [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

/** Result of checking one case under one staging mode. */
export interface CaseCheck {
  /** Differences from expected.json, prefixed with the state name. */
  readonly differences: string[];
  /** Tables whose fingerprint changed after a re-ingest, full rescan, or rebuild. */
  readonly unstableTables: string[];
}

/**
 * Ingests every state of a case and checks results and idempotency.
 * @param caseDir - Fixture case directory with `expected.json`.
 * @param schemaDir - Migrations directory.
 * @param mode - How states are staged.
 * @returns Differences and unstable tables; both empty when the case passes.
 */
export function checkCase(caseDir: string, schemaDir: string, mode: StagingMode): CaseCheck {
  const expected = JSON.parse(readFileSync(join(caseDir, "expected.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const db = openDatabase(":memory:", schemaDir);
  const root = mkdtempSync(join(tmpdir(), "aua-fidelity-"));
  /**
   * A fixed clock: run timestamps don't affect results.
   * @returns A constant instant.
   */
  const now = (): Date => new Date("2026-09-13T00:00:00Z");
  const differences: string[] = [];
  for (const state of statesOf(caseDir)) {
    stageState(state.dir, root, mode);
    ingestLogs(db, { roots: [root], mode: "incremental", now });
    ensureDerived(db);
    differences.push(...diffValues(expected[state.name], readResult(db), state.name));
  }
  const baseline = fingerprintTables(db, IDEMPOTENT_TABLES);
  const unstable = new Set<string>();
  /**
   * Records any table whose fingerprint moved away from the baseline.
   * @param step - Label for the step just performed.
   */
  const compare = (step: string): void => {
    const current = fingerprintTables(db, IDEMPOTENT_TABLES);
    for (const table of IDEMPOTENT_TABLES) {
      if (current[table] !== baseline[table]) {
        unstable.add(`${table} after ${step}`);
      }
    }
  };
  ingestLogs(db, { roots: [root], mode: "incremental", now });
  ensureDerived(db);
  compare("incremental re-ingest");
  ingestLogs(db, { roots: [root], mode: "full", now });
  ensureDerived(db);
  compare("full rescan");
  rebuildDerived(db);
  compare("rebuild");
  db.close();
  rmSync(root, { recursive: true, force: true });
  return { differences, unstableTables: [...unstable] };
}

/**
 * Runs the loader check over every fixture case, in both staging modes.
 * @param fixturesRoot - The `fixtures/` directory.
 * @param schemaDir - Migrations directory.
 * @param print - Receives output lines.
 * @returns Exit code 0 when every case passes in both modes.
 */
export function main(
  fixturesRoot: string,
  schemaDir: string,
  print: (line: string) => void,
): number {
  const cases = readdirSync(fixturesRoot, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(fixturesRoot, entry.name, "expected.json")),
    )
    .map((entry) => entry.name)
    .sort();
  let failures = 0;
  for (const caseId of cases) {
    for (const mode of ["overwrite", "replace"] as const) {
      const { differences, unstableTables } = checkCase(
        join(fixturesRoot, caseId),
        schemaDir,
        mode,
      );
      if (differences.length === 0 && unstableTables.length === 0) {
        print(`PASS ${caseId} (${mode})`);
        continue;
      }
      failures += 1;
      print(`FAIL ${caseId} (${mode})`);
      for (const difference of differences) {
        print(`  ${difference}`);
      }
      for (const table of unstableTables) {
        print(`  not idempotent: ${table}`);
      }
    }
  }
  print(
    failures === 0
      ? `loader fidelity: PASS (${cases.length} cases × 2 staging modes)`
      : `loader fidelity: FAIL (${failures} case runs)`,
  );
  // No cases means nothing was checked, which must not look like a pass.
  return cases.length > 0 && failures === 0 ? 0 : 1;
}
