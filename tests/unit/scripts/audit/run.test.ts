/**
 * @file Unit tests for scripts/audit/run.ts, the `npm run audit` runner.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_CHECKS,
  NOT_STARTED,
  commandCandidates,
  defaultDeps,
  formatSummary,
  main,
  runChecks,
  type AuditCheck,
  type CommandRunner,
  type RunDeps,
} from "../../../../scripts/audit/run.js";

/** Two checks used across tests; the commands are never actually executed. */
const CHECKS: readonly AuditCheck[] = [
  { id: "X1", name: "First", command: "first", args: ["--a"] },
  { id: "X2", name: "Second", command: "second", args: [] },
];

/**
 * Creates a clock that advances by a fixed step on every call.
 * @param stepMs - Milliseconds added per call.
 * @returns A deterministic clock function.
 */
function steppingClock(stepMs: number): () => number {
  let current = 0;
  return () => {
    current += stepMs;
    return current;
  };
}

describe("AUDIT_CHECKS", () => {
  it("has unique IDs", () => {
    const ids = AUDIT_CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers the checks added so far: A1-A7, A9, A10, and A11", () => {
    const prefixes = new Set(AUDIT_CHECKS.map((check) => check.id.replace(/[a-z]$/, "")));
    expect([...prefixes]).toEqual(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A9", "A10", "A11"]);
  });
});

describe("runChecks", () => {
  it("runs every check in order with its command and arguments", () => {
    const run = vi.fn<CommandRunner>(() => 0);
    runChecks(CHECKS, run, steppingClock(1));
    expect(run.mock.calls).toEqual([
      ["first", ["--a"]],
      ["second", []],
    ]);
  });

  it("continues after a failing check and records each exit code", () => {
    /**
     * Fails only the first check.
     * @param command - Executable name of the check being run.
     * @returns Exit code 2 for `first`, 0 otherwise.
     */
    const run: CommandRunner = (command) => (command === "first" ? 2 : 0);
    const results = runChecks(CHECKS, run, steppingClock(1));
    expect(results.map((result) => [result.check.id, result.passed, result.exitCode])).toEqual([
      ["X1", false, 2],
      ["X2", true, 0],
    ]);
  });

  it("measures each check's duration with the injected clock", () => {
    const results = runChecks(CHECKS, () => 0, steppingClock(250));
    expect(results.map((result) => result.durationMs)).toEqual([250, 250]);
  });
});

describe("formatSummary", () => {
  it("prints a table and an overall PASS when every check passed", () => {
    const results = runChecks(CHECKS, () => 0, steppingClock(1500));
    expect(formatSummary(results)).toBe(
      [
        "| Check | Name | Result | Time |",
        "|---|---|---|---|",
        "| X1 | First | PASS | 1.5s |",
        "| X2 | Second | PASS | 1.5s |",
        "",
        "AUDIT: PASS",
      ].join("\n"),
    );
  });

  it("shows the exit code of failures and counts them in the overall line", () => {
    const results = runChecks(
      CHECKS,
      (command) => (command === "second" ? 2 : 0),
      () => 0,
    );
    const summary = formatSummary(results);
    expect(summary).toContain("| X2 | Second | FAIL (exit 2) | 0.0s |");
    expect(summary.endsWith("AUDIT: FAIL (1 of 2 checks failed)")).toBe(true);
  });

  it("says a check's tool isn't installed instead of printing a shell's error code (D-051)", () => {
    // gitleaks and shellcheck aren't installed everywhere; that's a different problem from a
    // check that ran and found something, and the summary goes into an audit record.
    const results = runChecks(
      CHECKS,
      (command) => (command === "second" ? NOT_STARTED : 0),
      () => 0,
    );
    expect(formatSummary(results)).toContain("| X2 | Second | FAIL (not installed) | 0.0s |");
  });

  it("never reports PASS for an empty result list", () => {
    expect(formatSummary([]).endsWith("AUDIT: FAIL (0 of 0 checks failed)")).toBe(true);
  });
});

describe("main", () => {
  /**
   * Builds runner dependencies with a scripted runner and captured output.
   * @param run - The command runner to use.
   * @returns The dependencies and the captured printed text.
   */
  function depsWith(run: CommandRunner): { deps: RunDeps; printed: string[] } {
    const printed: string[] = [];
    return { deps: { run, now: () => 0, print: (text) => printed.push(text) }, printed };
  }

  it("returns 0 and prints the summary when all checks pass", () => {
    const { deps, printed } = depsWith(() => 0);
    expect(main(deps, CHECKS)).toBe(0);
    expect(printed.join("")).toContain("AUDIT: PASS");
  });

  it("returns 1 when any check fails", () => {
    const { deps } = depsWith((command) => (command === "first" ? 1 : 0));
    expect(main(deps, CHECKS)).toBe(1);
  });

  it("returns 1 when there are no checks to run", () => {
    const { deps } = depsWith(() => 0);
    expect(main(deps, [])).toBe(1);
  });

  it("runs the standard checks when none are passed", () => {
    const run = vi.fn<CommandRunner>(() => 0);
    const { deps } = depsWith(run);
    main(deps);
    expect(run).toHaveBeenCalledTimes(AUDIT_CHECKS.length);
  });
});

describe("commandCandidates", () => {
  it("tries the plain name everywhere, and python after python3 on Windows (D-051)", () => {
    // `npm run` puts node_modules/.bin on PATH, so the name alone is right on POSIX.
    expect(commandCandidates("tsc", "darwin")).toEqual(["tsc"]);
    expect(commandCandidates("python3", "darwin")).toEqual(["python3"]);
    expect(commandCandidates("gitleaks", "linux")).toEqual(["gitleaks"]);
    // Windows ships a python3 stub that isn't an interpreter; real installs are `python`.
    expect(commandCandidates("python3", "win32")).toEqual(["python3", "python"]);
    expect(commandCandidates("tsc", "win32")).toEqual(["tsc"]);
  });
});

describe("defaultDeps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the exit code of a real command", () => {
    const { run } = defaultDeps();
    expect(run(process.execPath, ["-e", "process.exit(3)"])).toBe(3);
  });

  it("returns 127 when the command cannot be started", () => {
    expect(defaultDeps().run("definitely-not-a-real-command-xyz", [])).toBe(127);
  });

  it("provides a clock that does not go backwards", () => {
    const { now } = defaultDeps();
    const first = now();
    expect(now()).toBeGreaterThanOrEqual(first);
  });

  it("prints through console.log", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    defaultDeps().print("summary");
    expect(log).toHaveBeenCalledWith("summary");
  });
});
