/**
 * @file Install rehearsal: the packed npm tarball, installed the way a user would, in an empty home
 * (step G5.4, plan-public R2's clean-install audit).
 *
 * It proves what tests of the source tree can't: that the published files are enough to run, and that
 * recording outlives the package (D-056). In a home directory of its own, it:
 * 1. installs the tarball globally and runs `nilometer --help` and `--version`;
 * 2. runs `init` over a settings file that has no status line, then runs the status line command `init`
 *    wrote, as Claude Code would, with a payload on stdin;
 * 3. uninstalls the package and runs the status line command again: the hook lives in the data
 *    directory, so it must still record;
 * 4. reinstalls, then ingests and reports;
 * 5. runs `uninstall`, which must leave the settings file byte-identical to how it started.
 *
 * It uses the network (npm fetches the package's dependency), so it runs in CI, not in the audit.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { resolveDataDir } from "../../core/install/locations.js";
import { invocation } from "../../core/util/commands.js";

/** What one command returned. */
export interface RunResult {
  /** Exit code; 1 when it was killed by a signal. */
  readonly status: number;
  /** Its stdout. */
  readonly stdout: string;
}

/**
 * Runs one command with the given environment and stdin.
 * @param command - Executable, or a shell command line when `shell` is true.
 * @param args - Arguments.
 * @param env - The whole environment: nothing is inherited.
 * @param input - Bytes for stdin, if any.
 */
export type Run = (
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  input?: Buffer,
) => RunResult;

/** One rehearsal step and whether it held. */
export interface Step {
  /** What was checked. */
  readonly name: string;
  /** Whether it held. */
  readonly ok: boolean;
}

/** What the rehearsal needs. */
export interface RehearsalDeps {
  /** The packed tarball (`npm pack`). */
  readonly tarball: string;
  /** An empty directory to use as the home directory. */
  readonly home: string;
  /** A folder of session logs to copy in as `~/.claude/projects` (a fixture's `projects`). */
  readonly projects: string;
  /** A status line payload. */
  readonly payload: Buffer;
  /** The platform. */
  readonly platform: NodeJS.Platform;
  /** The environment the rehearsal starts from: only PATH and Windows' system variables are kept. */
  readonly baseEnv: NodeJS.ProcessEnv;
  /** Starts commands. */
  readonly run: Run;
  /** Writes one output line. */
  readonly print: (line: string) => void;
}

/** The settings file the rehearsal starts from: a user setting and no status line. */
export const STARTING_SETTINGS = '{\n  "theme": "dark"\n}\n';

/** Windows variables a program needs to start at all, or to find `.cmd` shims. */
const WINDOWS_SYSTEM = ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"];

/**
 * Where npm puts global commands for a prefix.
 * @param prefix - npm's global prefix.
 * @param platform - The platform.
 * @returns The folder holding the `nilometer` command.
 */
export function globalBin(prefix: string, platform: NodeJS.Platform): string {
  // Windows puts the shims in the prefix itself; everywhere else they go in prefix/bin.
  return platform === "win32" ? prefix : join(prefix, "bin");
}

/**
 * The `nilometer` command a global install creates.
 * @param prefix - npm's global prefix.
 * @param platform - The platform.
 * @returns Its full path.
 */
export function installedCommand(prefix: string, platform: NodeJS.Platform): string {
  return join(globalBin(prefix, platform), platform === "win32" ? "nilometer.cmd" : "nilometer");
}

/**
 * An environment with nothing of the real user's in it: its own home, npm prefix and cache.
 * @param home - The rehearsal's home directory.
 * @param platform - The platform.
 * @param base - The environment to take PATH and Windows' system variables from.
 * @returns The whole environment for every command.
 */
export function isolatedEnv(
  home: string,
  platform: NodeJS.Platform,
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  const prefix = join(home, ".npm-global");
  const env: Record<string, string> = {
    HOME: home,
    // The install's own commands first, so a `nilometer` elsewhere on PATH can't answer instead.
    PATH: [globalBin(prefix, platform), base["PATH"] ?? base["Path"] ?? ""].join(delimiter),
    npm_config_prefix: prefix,
    npm_config_cache: join(home, ".npm-cache"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  if (platform === "win32") {
    env["USERPROFILE"] = home;
    env["APPDATA"] = join(home, "AppData", "Roaming");
    env["LOCALAPPDATA"] = join(home, "AppData", "Local");
    for (const name of WINDOWS_SYSTEM) {
      const value = base[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
  }
  return env;
}

/**
 * Reads the status line command out of a settings file.
 * @param settingsText - The file's text.
 * @returns The command, or undefined when there's none.
 */
export function statusLineCommand(settingsText: string): string | undefined {
  try {
    const parsed = JSON.parse(settingsText) as { statusLine?: { command?: unknown } };
    const command = parsed.statusLine?.command;
    return typeof command === "string" ? command : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Counts the lines in a file.
 * @param path - The file.
 * @returns Its line count; 0 when it doesn't exist.
 */
export function lineCount(path: string): number {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).length : 0;
}

/**
 * Runs the rehearsal.
 * @param deps - What it needs.
 * @returns Whether every step held, and the steps run, in order; it stops at the first that fails.
 */
export function rehearse(deps: RehearsalDeps): { ok: boolean; steps: Step[] } {
  const { home, platform, run } = deps;
  const env = isolatedEnv(home, platform, deps.baseEnv);
  const nilometer = installedCommand(join(home, ".npm-global"), platform);
  const settingsPath = join(home, ".claude", "settings.json");
  const spool = join(resolveDataDir({ home, env: {} }), "statusline.spool.jsonl");
  mkdirSync(join(home, ".claude"), { recursive: true });
  cpSync(deps.projects, join(home, ".claude", "projects"), { recursive: true });
  writeFileSync(settingsPath, STARTING_SETTINGS);

  const steps: Step[] = [];
  /**
   * Records a step.
   * @param name - What was checked.
   * @param ok - Whether it held.
   * @returns Whether it held.
   */
  const check = (name: string, ok: boolean): boolean => {
    steps.push({ name, ok });
    deps.print(`${ok ? "ok  " : "FAIL"} ${name}`);
    return ok;
  };
  /**
   * Runs the status line command `init` wrote, as Claude Code would: through `sh`, payload on stdin.
   * @returns What it printed, or undefined when it failed or there's no command.
   */
  const statusLine = (): string | undefined => {
    const command = statusLineCommand(readFileSync(settingsPath, "utf8"));
    if (command === undefined) {
      return undefined;
    }
    const result = run("sh", ["-c", command], env, deps.payload);
    return result.status === 0 ? result.stdout.trim() : undefined;
  };
  /**
   * Runs npm in the rehearsal's environment.
   * @param args - npm's arguments.
   * @returns Whether it exited 0.
   */
  const npm = (...args: string[]) => run("npm", args, env).status === 0;
  /**
   * Runs the installed command by its full path, so no other `nilometer` on PATH can answer.
   * @param args - Its arguments.
   * @returns What it returned.
   */
  const cli = (...args: string[]) => run(nilometer, args, env);

  const ok =
    check("npm install -g <tarball>", npm("install", "-g", deps.tarball)) &&
    check("nilometer --help", cli("--help").stdout.includes("Usage: nilometer")) &&
    // Read from the installed package.json, so this also proves the package root is found.
    check("nilometer --version", /^\d+\.\d+\.\d+/.test(cli("--version").stdout.trim())) &&
    check("nilometer init", cli("init").status === 0) &&
    check(
      "init wrote a status line command",
      (statusLineCommand(readFileSync(settingsPath, "utf8")) ?? "").includes("nilometer-hook"),
    ) &&
    check("the status line shows text", (statusLine() ?? "") !== "") &&
    check("and records one reading", lineCount(spool) === 1) &&
    check("npm uninstall -g nilometer", npm("uninstall", "-g", "nilometer")) &&
    check("the package is gone", !existsSync(nilometer)) &&
    check("the status line still shows text", (statusLine() ?? "") !== "") &&
    check("and still records (the hook outlives the package)", lineCount(spool) === 2) &&
    check("npm install -g <tarball>, again", npm("install", "-g", deps.tarball)) &&
    check("nilometer ingest", cli("ingest").status === 0) &&
    check("nilometer report", cli("report").stdout.includes("Claude subscription usage")) &&
    check("nilometer uninstall", cli("uninstall").status === 0) &&
    check(
      "settings.json is byte-identical to how it started",
      readFileSync(settingsPath, "utf8") === STARTING_SETTINGS,
    );
  deps.print(ok ? "install rehearsal: PASS" : "install rehearsal: FAIL");
  return { ok, steps };
}

/**
 * Starts a command through the platform's spawn rules (D-051): on Windows, npm and the installed
 * command are `.cmd` shims, which need a shell.
 * @param command - Executable.
 * @param args - Arguments.
 * @param env - The whole environment.
 * @param input - Bytes for stdin, if any.
 * @returns Its exit code and stdout.
 */
export const spawnRun: Run = (command, args, env, input) => {
  const call = invocation(command, args);
  const result = spawnSync(call.command, call.args, {
    env,
    shell: call.shell,
    input,
    encoding: "utf8",
    // stderr is the user's to read in the CI log; only stdout is checked.
    stdio: ["pipe", "pipe", "inherit"],
  });
  return { status: result.status ?? 1, stdout: result.stdout };
};
