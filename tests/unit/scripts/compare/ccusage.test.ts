/**
 * @file Unit tests for scripts/compare/ccusage.ts (audit check A7). ccusage itself is never run
 * here: a fake runner returns canned JSON, so these tests need no network.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CCUSAGE_VERSION,
  type CompareDeps,
  type Difference,
  KNOWN_DELTAS,
  type KnownDelta,
  ccusageArgs,
  classify,
  compareState,
  loaderCosts,
  sameValue,
  warmNpxCache,
  defaultDeps,
  describeState,
  diffTotals,
  discoverStates,
  main,
  normalizeCcusage,
  normalizeExpected,
  runCommand,
} from "../../../../scripts/compare/ccusage.js";

/** The committed fixtures directory. */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");

/** Totals used across tests. */
const TOTALS = { input: 1, output: 2, cache_read: 3, cache_write: 4, cost_usd: 0.5 };

/** Our cost for the mini fixtures' single day and model, matching {@link TOTALS}. */
const COSTS = { "2026-09-01|m": 0.5 };

/**
 * Builds ccusage-style daily JSON with one model breakdown.
 * @param date - Day.
 * @param model - Model name.
 * @param totals - Token totals.
 * @returns An object shaped like ccusage's `daily --json --breakdown` output.
 */
function ccusageJson(date: string, model: string, totals: typeof TOTALS): object {
  return {
    daily: [
      {
        date,
        modelBreakdowns: [
          {
            modelName: model,
            inputTokens: totals.input,
            outputTokens: totals.output,
            cacheReadTokens: totals.cache_read,
            cacheCreationTokens: totals.cache_write,
            cost: totals.cost_usd,
          },
        ],
      },
    ],
  };
}

/**
 * Creates a fixtures root with one single-state case and one two-run case.
 * @returns The root directory.
 */
function miniFixtures(): string {
  const root = mkdtempSync(join(tmpdir(), "aua-compare-"));
  const expectedTotals = {
    input_tokens: 1,
    output_tokens: 2,
    cache_read_tokens: 3,
    cache_write_5m_tokens: 1,
    cache_write_1h_tokens: 2,
    cache_write_unsplit_tokens: 1,
  };
  const state = { totals_by_day_utc: { "2026-09-01": { m: expectedTotals } } };
  mkdirSync(join(root, "01-a", "projects"), { recursive: true });
  writeFileSync(join(root, "01-a", "expected.json"), JSON.stringify({ final: state }));
  mkdirSync(join(root, "02-b", "run-1", "projects"), { recursive: true });
  mkdirSync(join(root, "02-b", "run-2", "projects"), { recursive: true });
  writeFileSync(join(root, "02-b", "expected.json"), JSON.stringify({ "run-1": state }));
  writeFileSync(join(root, "README.md"), "not a case");
  return root;
}

/**
 * Builds comparison dependencies whose runner returns the given stdout for every state.
 * @param stdout - Canned ccusage output.
 * @param exitCode - Canned exit code.
 * @returns Dependencies plus the printed lines, the environments the runner saw, and removed dirs.
 */
function fakeDeps(
  stdout: string,
  exitCode = 0,
): { deps: CompareDeps; printed: string[]; envs: Record<string, string>[]; removed: string[] } {
  const printed: string[] = [];
  const envs: Record<string, string>[] = [];
  const removed: string[] = [];
  return {
    printed,
    envs,
    removed,
    deps: {
      run: (_command, _args, env) => {
        envs.push({ ...env });
        return Promise.resolve({ exitCode, stdout, stderr: exitCode === 0 ? "" : "boom" });
      },
      path: "/bin",
      makeEmptyHome: () => "/empty-home",
      npmCache: "/npm-cache",
      removeDir: (path) => removed.push(path),
      readText: (path) => readFileSync(path, "utf8"),
      print: (line) => printed.push(line),
      costsFor: () => ({ final: COSTS, "run-1": COSTS, "run-2": COSTS }),
    },
  };
}

describe("discoverStates", () => {
  it("finds single-state and multi-run cases, skipping files", () => {
    const root = miniFixtures();
    expect(discoverStates(root)).toEqual([
      { caseId: "01-a", state: "final", dir: join(root, "01-a") },
      { caseId: "02-b", state: "run-1", dir: join(root, "02-b", "run-1") },
      { caseId: "02-b", state: "run-2", dir: join(root, "02-b", "run-2") },
    ]);
  });

  it("finds every state of the committed fixtures, including both runs of case 12", () => {
    const states = discoverStates(FIXTURES).map((s) => `${s.caseId}/${s.state}`);
    expect(states).toContain("12-rewritten-file/run-2");
    expect(states).toContain("01-streaming-snapshots/final");
  });
});

describe("ccusageArgs", () => {
  it("pins the version and asks for offline, token-priced, UTC JSON with a model breakdown", () => {
    expect(ccusageArgs()).toEqual([
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
    ]);
  });
});

describe("normalizeCcusage and normalizeExpected", () => {
  it("keys ccusage totals by day and model", () => {
    expect(normalizeCcusage(ccusageJson("2026-09-01", "m", TOTALS) as never)).toEqual({
      "2026-09-01|m": TOTALS,
    });
  });

  it("sums all three cache-write forms on our side", () => {
    const expected = JSON.parse(
      readFileSync(join(miniFixtures(), "01-a", "expected.json"), "utf8"),
    ) as Record<string, Parameters<typeof normalizeExpected>[0]>;
    const state = expected["final"]!;
    expect(normalizeExpected(state, COSTS)).toEqual({ "2026-09-01|m": TOTALS });
    expect(normalizeExpected(state, {})["2026-09-01|m"]?.cost_usd).toBe(0);
  });
});

describe("diffTotals", () => {
  it("returns nothing for identical totals", () => {
    expect(diffTotals({ k: TOTALS }, { k: TOTALS })).toEqual([]);
  });

  it("lists each differing field, treating a missing side as zero", () => {
    expect(diffTotals({ a: TOTALS }, { a: { ...TOTALS, output: 9 }, b: TOTALS })).toEqual([
      { key: "a", field: "output", ours: 2, theirs: 9 },
      { key: "b", field: "input", ours: 0, theirs: 1 },
      { key: "b", field: "output", ours: 0, theirs: 2 },
      { key: "b", field: "cache_read", ours: 0, theirs: 3 },
      { key: "b", field: "cache_write", ours: 0, theirs: 4 },
      { key: "b", field: "cost_usd", ours: 0, theirs: 0.5 },
    ]);
  });
});

describe("sameValue", () => {
  it("compares token fields exactly", () => {
    expect(sameValue("input", 1, 1)).toBe(true);
    expect(sameValue("input", 1, 2)).toBe(false);
  });

  it("compares costs within floating-point noise but not beyond", () => {
    expect(sameValue("cost_usd", 0.0017560000000000002, 0.0017559999999999997)).toBe(true);
    expect(sameValue("cost_usd", 0.000098, 0.000096)).toBe(false);
    expect(sameValue("cost_usd", 1_000_000, 1_000_000.0001)).toBe(true);
  });
});

describe("loaderCosts", () => {
  it("prices fixture 06 per day and model with the committed table", () => {
    const costs = loaderCosts(join(FIXTURES, "06-mixed-models"), join(FIXTURES, ".."));
    // Hand-computed: Opus 5 200 × $5 + 50 × $25 = 2250 µ$; Haiku 20 × $1 + 5 × $5 = 45 µ$;
    // Sonnet 5 (100 + 50) × $2 + (10 + 15) × $10 = 550 µ$.
    expect(costs["final"]?.["2026-09-01|claude-opus-5"]).toBeCloseTo(0.00225, 12);
    expect(costs["final"]?.["2026-09-01|claude-haiku-4-5-20251001"]).toBeCloseTo(0.000045, 12);
    expect(costs["final"]?.["2026-09-01|claude-sonnet-5"]).toBeCloseTo(0.00055, 12);
  });

  it("computes cumulative costs per run for a multi-run case", () => {
    const costs = loaderCosts(join(FIXTURES, "12-rewritten-file"), join(FIXTURES, ".."));
    // run-1: 6 × $2 + 60 × $10 = 612 µ$; run-2 keeps those and adds 4 × $2 + 5 × $10 = 58 µ$.
    expect(costs["run-1"]?.["2026-09-01|claude-sonnet-5"]).toBeCloseTo(0.000612, 12);
    expect(costs["run-2"]?.["2026-09-01|claude-sonnet-5"]).toBeCloseTo(0.00067, 12);
  });

  it("removes its staging directory, also when ingesting throws", () => {
    /**
     * Lists the staging directories currently in the temp directory.
     * @returns Their names.
     */
    const staged = (): string[] =>
      readdirSync(tmpdir()).filter((name) => name.startsWith("aua-ccusage-costs-"));
    const before = staged();
    loaderCosts(join(FIXTURES, "06-mixed-models"), join(FIXTURES, ".."));
    expect(staged()).toEqual(before);
    // A root without a price table throws before anything is staged…
    expect(() => loaderCosts(join(FIXTURES, "06-mixed-models"), "/no-such-root")).toThrow();
    // …and a case directory with a broken state throws inside the loop.
    expect(() => loaderCosts("/no-such-case", join(FIXTURES, ".."))).toThrow();
    expect(staged()).toEqual(before);
  });

  it("counts a day whose requests are all unpriced as zero cost", () => {
    const dir = mkdtempSync(join(tmpdir(), "aua-costs-unpriced-"));
    mkdirSync(join(dir, "projects", "p"), { recursive: true });
    writeFileSync(
      join(dir, "projects", "p", "s.jsonl"),
      `${JSON.stringify({ type: "assistant", sessionId: "s", timestamp: "2026-09-01T00:00:00Z", message: { id: "m", model: "claude-unknown", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 } } })}\n`,
    );
    expect(loaderCosts(dir, join(FIXTURES, ".."))).toEqual({
      final: { "2026-09-01|claude-unknown": 0 },
    });
  });
});

describe("classify", () => {
  const delta: KnownDelta = {
    caseId: "c",
    state: "final",
    key: "k",
    field: "input",
    ours: 1,
    theirs: 2,
    reason: "why",
  };
  const matching: Difference = { key: "k", field: "input", ours: 1, theirs: 2 };

  it("explains a difference that matches a known delta on every value", () => {
    expect(classify("c", "final", [matching], [delta])).toEqual({
      explained: [delta],
      unexplained: [],
      missing: [],
    });
  });

  it("leaves a difference unexplained when any value differs from the known delta", () => {
    const off = { ...matching, theirs: 3 };
    const result = classify("c", "final", [off], [delta]);
    expect(result.unexplained).toEqual([off]);
    expect(result.missing).toEqual([delta]);
  });

  it("reports a known delta that didn't occur as missing", () => {
    expect(classify("c", "final", [], [delta]).missing).toEqual([delta]);
  });

  it("ignores known deltas for other cases and states", () => {
    expect(classify("other", "final", [], [delta])).toEqual({
      explained: [],
      unexplained: [],
      missing: [],
    });
  });

  it("uses the committed known-delta list by default, each with a reason", () => {
    expect(classify("01-streaming-snapshots", "final", []).missing).toEqual([]);
    expect(KNOWN_DELTAS.every((known) => known.reason.length > 0)).toBe(true);
  });
});

describe("describeState", () => {
  const delta: KnownDelta = {
    caseId: "c",
    state: "s",
    key: "k",
    field: "output",
    ours: 1,
    theirs: 2,
    reason: "because",
  };

  it("prints MATCH for no differences", () => {
    expect(describeState("c s", { explained: [], unexplained: [], missing: [] })).toEqual([
      "MATCH       c s",
    ]);
  });

  it("prints the reason for a known delta", () => {
    expect(describeState("c s", { explained: [delta], unexplained: [], missing: [] })).toEqual([
      "KNOWN DELTA c s: because",
    ]);
  });

  it("prints every unexplained and stale entry", () => {
    const lines = describeState("c s", {
      explained: [],
      unexplained: [{ key: "k", field: "input", ours: 5, theirs: 6 }],
      missing: [delta],
    });
    expect(lines).toEqual([
      "UNEXPLAINED c s k input: ours 5, ccusage 6",
      "STALE DELTA c s k output: expected ours 1, ccusage 2",
    ]);
  });
});

describe("compareState and main", () => {
  it("passes when ccusage agrees, and never gives ccusage the real HOME", async () => {
    const root = miniFixtures();
    const { deps, printed, envs, removed } = fakeDeps(
      JSON.stringify(ccusageJson("2026-09-01", "m", TOTALS)),
    );
    // Only states with an expected entry: drop case 02's run-2 by comparing states directly.
    const result = await compareState(root, discoverStates(root)[0]!, deps, COSTS);
    expect(result).toEqual({ explained: [], unexplained: [], missing: [] });
    expect(envs[0]).toEqual({
      PATH: "/bin",
      HOME: "/empty-home",
      CLAUDE_CONFIG_DIR: join(root, "01-a"),
      npm_config_cache: "/npm-cache",
    });
    expect(printed).toEqual([]);
    expect(removed).toEqual(["/empty-home"]);
  });

  it("throws when ccusage exits non-zero", async () => {
    const root = miniFixtures();
    const { deps, removed } = fakeDeps("", 2);
    await expect(compareState(root, discoverStates(root)[0]!, deps, COSTS)).rejects.toThrow(
      "ccusage failed on 01-a/final (exit 2): boom",
    );
    expect(removed).toEqual(["/empty-home"]);
  });

  it("installs ccusage once into the shared cache, and fails loudly when it can't", async () => {
    const { deps, envs, removed } = fakeDeps("1.0.0");
    await warmNpxCache(deps);
    expect(envs).toEqual([{ PATH: "/bin", HOME: "/empty-home", npm_config_cache: "/npm-cache" }]);
    expect(removed).toEqual(["/empty-home"]);
    const failing = fakeDeps("", 1);
    await expect(warmNpxCache(failing.deps)).rejects.toThrow(
      `ccusage@${CCUSAGE_VERSION} could not be started (exit 1): boom`,
    );
    expect(failing.removed).toEqual(["/empty-home"]);
  });

  it("removes the empty home even when the runner itself throws", async () => {
    const root = miniFixtures();
    const { deps, removed } = fakeDeps("");
    const throwing: CompareDeps = { ...deps, run: () => Promise.reject(new Error("spawn failed")) };
    await expect(compareState(root, discoverStates(root)[0]!, throwing, COSTS)).rejects.toThrow(
      "spawn failed",
    );
    expect(removed).toEqual(["/empty-home"]);
  });

  it("throws when expected.json lacks the state", async () => {
    const root = miniFixtures();
    const { deps } = fakeDeps(JSON.stringify({ daily: [] }));
    await expect(compareState(root, discoverStates(root)[2]!, deps, COSTS)).rejects.toThrow(
      '02-b/expected.json has no "run-2" state',
    );
  });

  it("prints per-state lines and PASS, returning 0, when every state matches", async () => {
    const root = miniFixtures();
    writeFileSync(
      join(root, "02-b", "expected.json"),
      readFileSync(join(root, "02-b", "expected.json"), "utf8").replace(
        '{"run-1":',
        '{"run-2":{"totals_by_day_utc":{"2026-09-01":{"m":{"input_tokens":1,"output_tokens":2,"cache_read_tokens":3,"cache_write_5m_tokens":4,"cache_write_1h_tokens":0,"cache_write_unsplit_tokens":0}}}},"run-1":',
      ),
    );
    const { deps, printed } = fakeDeps(JSON.stringify(ccusageJson("2026-09-01", "m", TOTALS)));
    expect(await main(root, deps)).toBe(0);
    expect(printed).toEqual([
      "MATCH       01-a final",
      "MATCH       02-b run-1",
      "MATCH       02-b run-2",
      "ccusage comparison: PASS",
    ]);
  });

  it("returns 1 and counts failing states when ccusage disagrees", async () => {
    const root = mkdtempSync(join(tmpdir(), "aua-compare-fail-"));
    mkdirSync(join(root, "01-a", "projects"), { recursive: true });
    writeFileSync(
      join(root, "01-a", "expected.json"),
      JSON.stringify({ final: { totals_by_day_utc: {} } }),
    );
    const { deps, printed } = fakeDeps(JSON.stringify(ccusageJson("2026-09-01", "m", TOTALS)));
    expect(await main(root, deps)).toBe(1);
    expect(printed.at(-1)).toBe("ccusage comparison: FAIL (1 states)");
  });
});

describe("runCommand and defaultDeps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures stdout, stderr, and the exit code of a real command", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
      { PATH: process.env["PATH"] ?? "" },
    );
    expect(result).toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
  });

  it("returns 127 when the command can't start", async () => {
    const result = await runCommand("definitely-not-a-command-xyz", [], { PATH: "/nonexistent" });
    expect(result.exitCode).toBe(127);
    // POSIX reports the failed spawn itself; on Windows the command is looked up first, because a
    // shell would report it as exit 1 like any other failure (D-051). Both say it wasn't there.
    expect(result.stderr).toMatch(/ENOENT|was not found/);
  });

  it("provides a fresh empty home, file reading, and console output", () => {
    const deps = defaultDeps();
    expect(deps.run).toBe(runCommand);
    const home = deps.makeEmptyHome();
    expect(home).not.toBe(deps.makeEmptyHome());
    writeFileSync(join(home, "npx-cache"), "x");
    deps.removeDir(home);
    expect(existsSync(home)).toBe(false);
    expect(deps.readText(join(FIXTURES, "README.md"))).toContain("# Fixtures");
    expect(deps.npmCache).toMatch(/\.cache[/\\]nilometer[/\\]npm$/);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    deps.print("line");
    expect(log).toHaveBeenCalledWith("line");
    // The default cost source runs the real loader from the repository root.
    expect(deps.costsFor(join(FIXTURES, "04-btw-replay"))["final"]).toEqual({
      "2026-09-01|claude-sonnet-5": expect.closeTo(0.000308, 12) as number,
    });
  });
});
