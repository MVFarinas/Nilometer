/**
 * @file Compares pinned ccusage against the hand-computed fixture results (docs/development.md P2.3, audit
 * check A7, D-011, `verify-against-ccusage` skill).
 *
 * For every fixture state, runs `ccusage claude daily` offline against that state's log tree only,
 * normalizes both sides to per-day, per-model token totals, and classifies each difference:
 * - **matched**: no difference
 * - **known delta**: exactly one of {@link KNOWN_DELTAS}, where ccusage deliberately or knowingly
 *   differs from this project's rules
 * - **unexplained**: anything else, which fails the check
 *
 * A known delta that no longer occurs also fails, so the list can't go stale.
 *
 * Tokens on our side come from the hand-computed `expected.json`. Cost on our side comes from running
 * the real loader and the `request_costs` view (P5.2) over the same states, because expected files
 * hold no costs. Every fixture is dated inside one price period, so ccusage's current prices and this
 * project's dated rows (D-005, D-020) are comparable there.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { openDatabase } from "../../core/db/database.js";
import { ensureDerived } from "../../core/ingest/derive.js";
import { ingestLogs } from "../../core/ingest/ingest.js";
import { loadPriceTable, syncPrices } from "../../core/pricing/prices.js";
import { stageState, statesOf } from "../fidelity/loader-check.js";

/** Pinned ccusage version (D-011). Upgrading means re-reviewing every known delta. */
export const CCUSAGE_VERSION = "20.0.20";

/** Fields compared between ccusage and our results: four token totals and the USD cost. */
export const FIELDS = ["input", "output", "cache_read", "cache_write", "cost_usd"] as const;

/** One compared field. */
export type Field = (typeof FIELDS)[number];

/** Token totals and cost for one day and model. */
export type Totals = Record<Field, number>;

/** Totals keyed by `"<YYYY-MM-DD>|<model>"`. */
export type TotalsByDayModel = Record<string, Totals>;

/** One fixture state to compare. */
export interface FixtureState {
  /** Case directory name, e.g. `05-missing-ids`. */
  readonly caseId: string;
  /** `final`, `run-1`, `run-2`, ... */
  readonly state: string;
  /** Directory passed to ccusage as CLAUDE_CONFIG_DIR. */
  readonly dir: string;
}

/** One field that differs. */
export interface Difference {
  /** `"<day>|<model>"`. */
  readonly key: string;
  /** The differing field. */
  readonly field: Field;
  /** Our expected value; 0 when the day/model is absent on our side. */
  readonly ours: number;
  /** ccusage's value; 0 when absent on its side. */
  readonly theirs: number;
}

/** A difference that is expected, with the reason recorded next to it. */
export interface KnownDelta extends Difference {
  /** Case the delta belongs to. */
  readonly caseId: string;
  /** State the delta belongs to. */
  readonly state: string;
  /** Why ccusage differs, citing the decision that makes ours different. */
  readonly reason: string;
}

/**
 * Every expected disagreement, observed 2026-09-13 with ccusage 20.0.20 on these fixtures.
 * Each entry is one field of one day/model in one fixture state.
 */
export const KNOWN_DELTAS: readonly KnownDelta[] = [
  ...(["input", "output"] as const).map((field): KnownDelta => ({
    caseId: "05-missing-ids",
    state: "final",
    key: "2026-09-01|claude-sonnet-5",
    field,
    ours: field === "input" ? 4 : 19,
    theirs: field === "input" ? 5 : 23,
    reason:
      "ccusage doesn't deduplicate lines without message.id; we fall back to requestId (D-001)",
  })),
  ...(["input", "output"] as const).map((field): KnownDelta => ({
    caseId: "12-rewritten-file",
    state: "run-2",
    key: "2026-09-01|claude-sonnet-5",
    field,
    ours: field === "input" ? 10 : 65,
    theirs: field === "input" ? 5 : 15,
    reason:
      "ccusage re-reads current files, so requests removed by a rewrite vanish; we keep raw lines (D-002)",
  })),
  // The same three causes show up in cost: extra or missing tokens priced at the same rates.
  // Sonnet 5 at $2 input / $10 output per million tokens, computed by hand:
  // 05: ours 4 × 2 + 19 × 10 = 198 µ$, ccusage 5 × 2 + 23 × 10 = 240 µ$.
  // 12 run-2: ours 10 × 2 + 65 × 10 = 670 µ$, ccusage 5 × 2 + 15 × 10 = 160 µ$.
  // 17: ours 4 × 2 + 9 × 10 = 98 µ$, ccusage 3 × 2 + 9 × 10 = 96 µ$.
  {
    caseId: "05-missing-ids",
    state: "final",
    key: "2026-09-01|claude-sonnet-5",
    field: "cost_usd",
    ours: 0.000198,
    theirs: 0.00024,
    reason:
      "ccusage doesn't deduplicate lines without message.id; we fall back to requestId (D-001)",
  },
  {
    caseId: "12-rewritten-file",
    state: "run-2",
    key: "2026-09-01|claude-sonnet-5",
    field: "cost_usd",
    ours: 0.00067,
    theirs: 0.00016,
    reason:
      "ccusage re-reads current files, so requests removed by a rewrite vanish; we keep raw lines (D-002)",
  },
  {
    caseId: "17-report-edges",
    state: "final",
    key: "2026-09-01|claude-sonnet-5",
    field: "cost_usd",
    ours: 0.000098,
    theirs: 0.000096,
    reason:
      "ccusage drops a line missing output_tokens; we count it with output 0 and report the field (fixtures/README.md)",
  },
  {
    caseId: "17-report-edges",
    state: "final",
    key: "2026-09-01|claude-sonnet-5",
    field: "input",
    ours: 4,
    theirs: 3,
    reason:
      "ccusage drops a line missing output_tokens; we count it with output 0 and report the field (fixtures/README.md)",
  },
];

/**
 * Lists every fixture state under a fixtures root.
 * @param fixturesRoot - The `fixtures/` directory.
 * @returns States in case order; multi-run cases yield one entry per run directory.
 */
export function discoverStates(fixturesRoot: string): FixtureState[] {
  const states: FixtureState[] = [];
  // Only directories are cases; fixtures/README.md and similar files sit beside them.
  const caseIds = readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const caseId of caseIds) {
    const caseDir = join(fixturesRoot, caseId);
    if (existsSync(join(caseDir, "projects"))) {
      // A single-state case directory itself holds projects/, so it is the config dir.
      states.push({ caseId, state: "final", dir: caseDir });
      continue;
    }
    for (const run of readdirSync(caseDir)
      .filter((name) => /^run-\d+$/.test(name))
      .sort()) {
      states.push({ caseId, state: run, dir: join(caseDir, run) });
    }
  }
  return states;
}

/**
 * Builds the ccusage command-line arguments.
 * @returns Arguments for `npx`: pinned version, JSON, token-based pricing, offline, UTC days.
 */
export function ccusageArgs(): string[] {
  // --mode calculate ignores legacy costUSD fields; --offline freezes the embedded price table.
  return [
    "-y",
    `ccusage@${CCUSAGE_VERSION}`,
    "claude",
    "daily",
    "--json",
    "--mode",
    "calculate",
    "--offline",
    "-z",
    "UTC",
    "--breakdown",
  ];
}

/** Shape of the parts of ccusage's daily JSON this module reads. */
interface CcusageDaily {
  /** One entry per day. */
  readonly daily: readonly {
    /** `YYYY-MM-DD` in the requested timezone. */
    readonly date: string;
    /** Per-model token totals for the day. */
    readonly modelBreakdowns: readonly {
      readonly modelName: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheCreationTokens: number;
      /** USD cost at ccusage's embedded (offline) prices. */
      readonly cost: number;
    }[];
  }[];
}

/**
 * Normalizes ccusage daily JSON to per-day, per-model totals.
 * @param json - Parsed output of `ccusage claude daily --json --breakdown`.
 * @returns Totals keyed by `"<day>|<model>"`.
 */
export function normalizeCcusage(json: CcusageDaily): TotalsByDayModel {
  const result: TotalsByDayModel = {};
  for (const day of json.daily) {
    for (const model of day.modelBreakdowns) {
      result[`${day.date}|${model.modelName}`] = {
        input: model.inputTokens,
        output: model.outputTokens,
        cache_read: model.cacheReadTokens,
        // ccusage reports one cache-write total; its JSON has no 5m/1h split (skill § Comparing).
        cache_write: model.cacheCreationTokens,
        cost_usd: model.cost,
      };
    }
  }
  return result;
}

/** Shape of one state object in `expected.json` that this module reads. */
interface ExpectedState {
  /** Per-day, per-model totals as documented in fixtures/README.md. */
  readonly totals_by_day_utc: Readonly<
    Record<
      string,
      Readonly<
        Record<
          string,
          {
            readonly input_tokens: number;
            readonly output_tokens: number;
            readonly cache_read_tokens: number;
            readonly cache_write_5m_tokens: number;
            readonly cache_write_1h_tokens: number;
            readonly cache_write_unsplit_tokens: number;
          }
        >
      >
    >
  >;
}

/**
 * Normalizes one expected state to the same shape as {@link normalizeCcusage}.
 * @param state - One state object from `expected.json`.
 * @param costs - Our USD cost per `"<day>|<model>"` for this state, from {@link loaderCosts}.
 * @returns Totals keyed by `"<day>|<model>"`, with all cache-write forms summed.
 */
export function normalizeExpected(
  state: ExpectedState,
  costs: Readonly<Record<string, number>>,
): TotalsByDayModel {
  const result: TotalsByDayModel = {};
  for (const [day, models] of Object.entries(state.totals_by_day_utc)) {
    for (const [model, totals] of Object.entries(models)) {
      result[`${day}|${model}`] = {
        input: totals.input_tokens,
        output: totals.output_tokens,
        cache_read: totals.cache_read_tokens,
        cache_write:
          totals.cache_write_5m_tokens +
          totals.cache_write_1h_tokens +
          totals.cache_write_unsplit_tokens,
        cost_usd: costs[`${day}|${model}`] ?? 0,
      };
    }
  }
  return result;
}

/**
 * Compares two values of a field: token counts exactly, costs within floating-point noise.
 * @param field - The field compared.
 * @param a - One value.
 * @param b - The other value.
 * @returns True when the values are equal for that field.
 */
export function sameValue(field: Field, a: number, b: number): boolean {
  if (field !== "cost_usd") {
    return a === b;
  }
  // Summing binary floats in a different order differs in the 17th digit; a millionth of a cent doesn't.
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Lists every field that differs between two totals maps.
 * @param ours - Expected totals.
 * @param theirs - ccusage totals.
 * @returns Differences sorted by key, then field order.
 */
export function diffTotals(ours: TotalsByDayModel, theirs: TotalsByDayModel): Difference[] {
  const differences: Difference[] = [];
  const keys = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])].sort();
  for (const key of keys) {
    for (const field of FIELDS) {
      // A day/model missing on one side compares as zero, so it shows up as a difference.
      const oursValue = ours[key]?.[field] ?? 0;
      const theirsValue = theirs[key]?.[field] ?? 0;
      if (!sameValue(field, oursValue, theirsValue)) {
        differences.push({ key, field, ours: oursValue, theirs: theirsValue });
      }
    }
  }
  return differences;
}

/** Classification of one state's differences. */
export interface Classification {
  /** Differences matching a known delta exactly. */
  readonly explained: readonly KnownDelta[];
  /** Differences no known delta explains. */
  readonly unexplained: readonly Difference[];
  /** Known deltas for this state that didn't occur (the list is stale). */
  readonly missing: readonly KnownDelta[];
}

/**
 * Splits a state's differences into explained, unexplained, and missing known deltas.
 * @param caseId - Case being compared.
 * @param state - State being compared.
 * @param differences - Output of {@link diffTotals}.
 * @param known - Known deltas; defaults to {@link KNOWN_DELTAS}.
 * @returns The classification.
 */
export function classify(
  caseId: string,
  state: string,
  differences: readonly Difference[],
  known: readonly KnownDelta[] = KNOWN_DELTAS,
): Classification {
  const forState = known.filter((delta) => delta.caseId === caseId && delta.state === state);
  /**
   * Finds the known delta matching a difference on every value.
   * @param difference - One difference.
   * @returns The matching known delta, or undefined.
   */
  const match = (difference: Difference): KnownDelta | undefined =>
    forState.find(
      (delta) =>
        delta.key === difference.key &&
        delta.field === difference.field &&
        sameValue(delta.field, delta.ours, difference.ours) &&
        sameValue(delta.field, delta.theirs, difference.theirs),
    );
  const explained: KnownDelta[] = [];
  const unexplained: Difference[] = [];
  for (const difference of differences) {
    const delta = match(difference);
    if (delta === undefined) {
      unexplained.push(difference);
    } else {
      explained.push(delta);
    }
  }
  const missing = forState.filter((delta) => !explained.includes(delta));
  return { explained, unexplained, missing };
}

/** Result of running an external command. */
export interface CommandResult {
  /** Exit code; 127 if it couldn't start. */
  readonly exitCode: number;
  /** Captured stdout. */
  readonly stdout: string;
  /** Captured stderr. */
  readonly stderr: string;
}

/** Dependencies of {@link main}. */
export interface CompareDeps {
  /** Runs a command with an exact environment, resolving when it exits. */
  readonly run: (
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => Promise<CommandResult>;
  /** Environment variables to pass through (only PATH is used). */
  readonly path: string;
  /** Creates an empty directory used as HOME, so ccusage can't find real logs. */
  readonly makeEmptyHome: () => string;
  /** Removes a directory made by `makeEmptyHome`, with everything npx wrote into it. */
  readonly removeDir: (path: string) => void;
  /**
   * npm cache directory shared by every ccusage run. Without it, npx downloads the package into
   * each empty HOME, and the concurrent runs briefly need over a gigabyte of disk.
   */
  readonly npmCache: string;
  /** Reads a text file. */
  readonly readText: (path: string) => string;
  /** Writes one output line. */
  readonly print: (line: string) => void;
  /** Our USD cost per state and `"<day>|<model>"` for one case directory. */
  readonly costsFor: (caseDir: string) => Record<string, Record<string, number>>;
}

/**
 * Computes our cost per day and model for every state of a case, using the real loader and prices.
 * @param caseDir - A fixture case directory.
 * @param packageRoot - Repository root, for the schema and the price table.
 * @returns USD per `"<day>|<model>"`, keyed by state name. Unpriced requests contribute nothing.
 */
export function loaderCosts(
  caseDir: string,
  packageRoot: string,
): Record<string, Record<string, number>> {
  const prices = loadPriceTable(join(packageRoot, "core", "pricing", "prices.json"));
  const db = openDatabase(":memory:", join(packageRoot, "core", "schema"));
  const root = mkdtempSync(join(tmpdir(), "aua-ccusage-costs-"));
  const result: Record<string, Record<string, number>> = {};
  try {
    for (const state of statesOf(caseDir)) {
      // Staged in place and ingested cumulatively, exactly as the loader fidelity check does.
      stageState(state.dir, root, "overwrite");
      ingestLogs(db, { roots: [root], mode: "incremental", now: () => new Date(0) });
      ensureDerived(db);
      syncPrices(db, prices);
      const costs: Record<string, number> = {};
      for (const row of db
        .prepare(
          "SELECT day_utc, model, SUM(total_usd) AS usd FROM request_costs WHERE day_utc IS NOT NULL GROUP BY day_utc, model",
        )
        .all() as { day_utc: string; model: string; usd: number | null }[]) {
        costs[`${row.day_utc}|${row.model}`] = row.usd ?? 0;
      }
      result[state.name] = costs;
    }
  } finally {
    db.close();
    // Every compared state stages a copy of its fixture here; leaving them fills the disk over runs.
    rmSync(root, { recursive: true, force: true });
  }
  return result;
}

/**
 * Runs ccusage for one fixture state and classifies its differences from the expected results.
 * @param fixturesRoot - The `fixtures/` directory.
 * @param fixture - The state to compare.
 * @param deps - Command runner, filesystem, and environment.
 * @param costs - Our USD cost per `"<day>|<model>"` for this state.
 * @returns The classification for that state.
 * @throws {Error} If ccusage fails, prints output that isn't JSON, or the expected file lacks the state.
 */
export async function compareState(
  fixturesRoot: string,
  fixture: FixtureState,
  deps: CompareDeps,
  costs: Readonly<Record<string, number>>,
): Promise<Classification> {
  const { caseId, state, dir } = fixture;
  // Only PATH, an empty HOME, and the fixture dir: nothing lets ccusage reach real ~/.claude logs.
  const home = deps.makeEmptyHome();
  const env = {
    PATH: deps.path,
    HOME: home,
    CLAUDE_CONFIG_DIR: dir,
    npm_config_cache: deps.npmCache,
  };
  let result: CommandResult;
  try {
    result = await deps.run("npx", ccusageArgs(), env);
  } finally {
    // npx can write its cache under HOME; one leftover home per compared state adds up over runs.
    deps.removeDir(home);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `ccusage failed on ${caseId}/${state} (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
  const theirs = normalizeCcusage(JSON.parse(result.stdout) as CcusageDaily);
  const expected = JSON.parse(deps.readText(join(fixturesRoot, caseId, "expected.json"))) as Record<
    string,
    ExpectedState
  >;
  const expectedState = expected[state];
  if (expectedState === undefined) {
    throw new Error(`${caseId}/expected.json has no "${state}" state`);
  }
  return classify(caseId, state, diffTotals(normalizeExpected(expectedState, costs), theirs));
}

/**
 * Formats one state's classification as output lines.
 * @param label - `"<case> <state>"`.
 * @param classification - Result of {@link classify}.
 * @returns Lines to print; exactly one line when the state passes.
 */
export function describeState(label: string, classification: Classification): string[] {
  const { explained, unexplained, missing } = classification;
  if (unexplained.length === 0 && missing.length === 0) {
    const first = explained[0];
    return [first === undefined ? `MATCH       ${label}` : `KNOWN DELTA ${label}: ${first.reason}`];
  }
  return [
    ...unexplained.map(
      (d) => `UNEXPLAINED ${label} ${d.key} ${d.field}: ours ${d.ours}, ccusage ${d.theirs}`,
    ),
    ...missing.map(
      (d) =>
        `STALE DELTA ${label} ${d.key} ${d.field}: expected ours ${d.ours}, ccusage ${d.theirs}`,
    ),
  ];
}

/**
 * Runs the comparison over every fixture state and prints a line per state.
 * @param fixturesRoot - The `fixtures/` directory.
 * @param deps - Command runner, filesystem, and output.
 * @returns Exit code 0 when every difference is a known delta and every known delta occurred.
 * @throws {Error} If ccusage fails or a state is missing from an expected file.
 */
export async function main(fixturesRoot: string, deps: CompareDeps): Promise<number> {
  const states = discoverStates(fixturesRoot);
  await warmNpxCache(deps);
  // Our costs need cumulative ingests, so each case is computed once, sequentially and in-process.
  const costsByCase = new Map<string, Record<string, Record<string, number>>>();
  for (const { caseId } of states) {
    if (!costsByCase.has(caseId)) {
      costsByCase.set(caseId, deps.costsFor(join(fixturesRoot, caseId)));
    }
  }
  // ccusage runs are independent and each npx launch costs seconds, so they run concurrently.
  const results = await Promise.all(
    states.map((fixture) =>
      compareState(
        fixturesRoot,
        fixture,
        deps,
        costsByCase.get(fixture.caseId)?.[fixture.state] ?? {},
      ),
    ),
  );
  let failures = 0;
  states.forEach(({ caseId, state }, index) => {
    const classification = results[index]!;
    if (classification.unexplained.length > 0 || classification.missing.length > 0) {
      failures += 1;
    }
    describeState(`${caseId} ${state}`, classification).forEach((line) => {
      deps.print(line);
    });
  });
  deps.print(
    failures === 0 ? "ccusage comparison: PASS" : `ccusage comparison: FAIL (${failures} states)`,
  );
  return failures === 0 ? 0 : 1;
}

/**
 * Runs a command to completion, capturing its output.
 * @param command - Executable name.
 * @param args - Arguments.
 * @param env - The complete environment for the child.
 * @returns Exit code (127 if it couldn't start) and captured output.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // "error" fires when the command can't start at all; report it the way a shell would (127).
    child.on("error", (error) => {
      resolve({ exitCode: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 127, stdout, stderr });
    });
  });
}

/**
 * Installs the pinned ccusage into the shared npm cache once, before the concurrent runs. Parallel
 * npx launches against an empty cache would each install the package at the same time.
 * @param deps - Command runner, environment, and cache location.
 * @throws {Error} If ccusage can't be installed or started.
 */
export async function warmNpxCache(deps: CompareDeps): Promise<void> {
  const home = deps.makeEmptyHome();
  let result: CommandResult;
  try {
    result = await deps.run("npx", ["-y", `ccusage@${CCUSAGE_VERSION}`, "--version"], {
      PATH: deps.path,
      HOME: home,
      npm_config_cache: deps.npmCache,
    });
  } finally {
    deps.removeDir(home);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `ccusage@${CCUSAGE_VERSION} could not be started (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
}

/**
 * Builds the real dependencies used by `npm run compare:ccusage`.
 * @returns Dependencies backed by child processes and the filesystem.
 */
export function defaultDeps(): CompareDeps {
  return {
    run: runCommand,
    path: process.env["PATH"] ?? "",
    makeEmptyHome: () => mkdtempSync(join(tmpdir(), "aua-ccusage-home-")),
    removeDir: (path) => {
      rmSync(path, { recursive: true, force: true });
    },
    // A cache of the npm package only: nothing Claude Code writes lives here.
    npmCache: join(homedir(), ".cache", "nilometer", "npm"),
    readText: (path) => readFileSync(path, "utf8"),
    print: (line) => {
      console.log(line);
    },
    costsFor: (caseDir) => loaderCosts(caseDir, join(import.meta.dirname, "..", "..")),
  };
}
