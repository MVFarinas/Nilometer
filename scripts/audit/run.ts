/**
 * @file The standard audit runner behind `npm run audit` (docs/development.md § Audits).
 *
 * Runs every check in order and keeps going after a failure, so one run reports the state of all
 * checks. It then prints a summary block for the step's audit record, and exits non-zero if any
 * check failed. Checks were added here as later build steps built their suites (A5–A9).
 */
import { spawnSync } from "node:child_process";

/** One command the audit runs. */
export interface AuditCheck {
  /** Plan ID, e.g. `A1`. Sub-checks of one plan row share a prefix (`A10a`, `A10b`). */
  readonly id: string;
  /** Human-readable name printed in the summary. */
  readonly name: string;
  /** Executable name, resolved on PATH; `npm run` puts `node_modules/.bin` there. */
  readonly command: string;
  /** Arguments passed to the executable. */
  readonly args: readonly string[];
}

/** The outcome of one check. */
export interface CheckResult {
  /** The check that ran. */
  readonly check: AuditCheck;
  /** Whether the command exited 0. */
  readonly passed: boolean;
  /** The command's exit code; 127 when it couldn't be started. */
  readonly exitCode: number;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
}

/** Every check in the standard audit, in the order they run. */
export const AUDIT_CHECKS: readonly AuditCheck[] = [
  { id: "A1", name: "Types", command: "tsc", args: ["--noEmit"] },
  { id: "A2", name: "Lint + documentation rules", command: "eslint", args: ["."] },
  { id: "A3", name: "Formatting", command: "prettier", args: ["--check", "."] },
  { id: "A4", name: "Unit tests + coverage", command: "vitest", args: ["run", "--coverage"] },
  // Every schema column names its source; every view names its metric (docs/development.md § Standards).
  {
    id: "A5",
    name: "Schema column comments",
    command: "tsx",
    args: ["scripts/audit/schema-docs.cli.ts"],
  },
  // The independent reference (D-017) must pass its own tests before its answers are trusted.
  {
    id: "A6a",
    name: "Fidelity: reference unit tests",
    command: "python3",
    args: ["-m", "unittest", "discover", "-s", "scripts/fidelity", "-p", "test_*.py"],
  },
  {
    id: "A6b",
    name: "Fidelity: reference vs hand-computed",
    command: "python3",
    args: ["scripts/fidelity/reference.py", "--check", "fixtures"],
  },
  // The TypeScript loader must reproduce every fixture result and stay idempotent (P4.5).
  {
    id: "A6c",
    name: "Fidelity: loader vs hand-computed",
    command: "tsx",
    args: ["scripts/fidelity/loader-check.cli.ts"],
  },
  {
    id: "A7",
    name: "ccusage comparison on fixtures",
    command: "tsx",
    args: ["scripts/compare/ccusage.cli.ts"],
  },
  // Wording is part of correctness (CLAUDE.md): the viewer's rendered output is checked for banned phrases.
  {
    id: "A9",
    name: "Banned phrases in viewer output",
    command: "vitest",
    args: ["run", "tests/wording"],
  },
  // History is scanned too: a secret removed in a later commit is still published.
  {
    id: "A10a",
    name: "Secrets: git history",
    command: "gitleaks",
    args: ["git", "--no-banner", "--redact", "."],
  },
  {
    id: "A10b",
    name: "Secrets: working tree",
    command: "gitleaks",
    args: ["dir", "--no-banner", "--redact", "."],
  },
  {
    id: "A10c",
    name: "Personal data",
    command: "tsx",
    args: ["scripts/audit/scan-personal.cli.ts"],
  },
  // The hook is shell (D-018), so shellcheck stands in for tsc and eslint there.
  { id: "A11", name: "Shell hook lint", command: "shellcheck", args: ["hooks/statusline.sh"] },
];

/**
 * Runs a command with output streamed to the terminal. Injected so tests don't spawn processes.
 * @param command - Executable name.
 * @param args - Arguments.
 * @returns The exit code; 127 when the command couldn't be started.
 */
export type CommandRunner = (command: string, args: readonly string[]) => number;

/**
 * Runs each check in order, continuing after failures.
 * @param checks - The checks to run.
 * @param run - Executes one command.
 * @param now - Millisecond clock, injected so durations are deterministic in tests.
 * @returns One result per check, in the same order.
 */
export function runChecks(
  checks: readonly AuditCheck[],
  run: CommandRunner,
  now: () => number,
): CheckResult[] {
  return checks.map((check) => {
    const started = now();
    const exitCode = run(check.command, check.args);
    return { check, passed: exitCode === 0, exitCode, durationMs: now() - started };
  });
}

/**
 * Formats results as the summary block pasted into an audit record.
 * @param results - Results from {@link runChecks}.
 * @returns A multi-line table followed by an overall PASS or FAIL line.
 */
export function formatSummary(results: readonly CheckResult[]): string {
  const rows = results.map((result) => {
    const status = result.passed ? "PASS" : `FAIL (exit ${result.exitCode})`;
    // Seconds with one decimal is precise enough to notice a slow check without noise.
    const seconds = (result.durationMs / 1000).toFixed(1);
    return `| ${result.check.id} | ${result.check.name} | ${status} | ${seconds}s |`;
  });
  const failed = results.filter((result) => !result.passed).length;
  // An empty result list can't prove anything, so it never counts as a pass.
  const overall =
    results.length > 0 && failed === 0
      ? "AUDIT: PASS"
      : `AUDIT: FAIL (${failed} of ${results.length} checks failed)`;
  return ["| Check | Name | Result | Time |", "|---|---|---|---|", ...rows, "", overall].join("\n");
}

/** Dependencies of {@link main}. */
export interface RunDeps {
  /** Executes one command. */
  readonly run: CommandRunner;
  /** Millisecond clock. */
  readonly now: () => number;
  /** Writes text to output. */
  readonly print: (text: string) => void;
}

/**
 * Runs the full audit and prints its summary.
 * @param deps - Command execution, clock, and output.
 * @param checks - Checks to run; defaults to {@link AUDIT_CHECKS}.
 * @returns Process exit code: 0 only if every check passed and at least one ran.
 */
export function main(deps: RunDeps, checks: readonly AuditCheck[] = AUDIT_CHECKS): number {
  const results = runChecks(checks, deps.run, deps.now);
  deps.print(`\n${formatSummary(results)}`);
  return results.length > 0 && results.every((result) => result.passed) ? 0 : 1;
}

/**
 * Builds the real dependencies used by `npm run audit`.
 * @returns Dependencies that spawn processes with inherited output.
 */
export function defaultDeps(): RunDeps {
  return {
    run: (command, args) => {
      // Inherit stdio so each tool's own output (test counts, coverage table) reaches the log.
      const result = spawnSync(command, args, { stdio: "inherit" });
      // status is null when the process couldn't start (e.g. gitleaks not installed).
      return result.status ?? 127;
    },
    now: () => performance.now(),
    print: (text) => {
      console.log(text);
    },
  };
}
