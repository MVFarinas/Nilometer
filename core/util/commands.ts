/**
 * @file Starting another program the same way on macOS, Linux, and Windows (D-051).
 *
 * On Windows the tools npm installs are `.cmd` shims, which Node refuses to spawn unless a shell
 * runs them, so a command that works everywhere else fails there with ENOENT. Going through a shell
 * brings two problems of its own: Node concatenates arguments without escaping them (DEP0190), so a
 * path containing a space is split into two words, and `cmd.exe` reports a command it can't find as
 * exit 1, which is indistinguishable from a tool that ran and failed.
 *
 * This module answers both: the command line is quoted here and passed as one pre-built string, and
 * a command is looked up before it runs, so "not installed" is reported as itself.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Exit code reported when a command isn't installed, or couldn't be started. */
export const NOT_STARTED = 127;

/**
 * `cmd.exe`'s code for "is not recognized as an internal or external command".
 *
 * Windows ships a `python3` stub that exits with this instead of running Python, so a command that
 * returns it hasn't really run.
 */
export const WINDOWS_NOT_RECOGNIZED = 9009;

/** Characters that make `cmd.exe` read a word as something other than one plain argument. */
const NEEDS_QUOTING = /[\s&|<>^()%!]/;

/**
 * Quotes one word of a `cmd.exe` command line.
 * @param word - A command name or argument.
 * @returns The word, in double quotes when it would otherwise be split or interpreted.
 * @throws {Error} If the word contains a double quote. Nothing here needs one, and quoting it
 *   correctly depends on how the receiving program parses its arguments, so this refuses rather
 *   than building a command line that might mean something else (report, don't fix).
 * @example
 * quoteForCmd("C:\\Program Files\\nodejs\\node.exe"); // '"C:\\Program Files\\nodejs\\node.exe"'
 */
export function quoteForCmd(word: string): string {
  if (word.includes('"')) {
    throw new Error(`cannot quote ${word} for cmd.exe: it contains a double quote`);
  }
  return word === "" || NEEDS_QUOTING.test(word) ? `"${word}"` : word;
}

/**
 * Builds one `cmd.exe` command line from a command and its arguments.
 * @param command - Executable name or path.
 * @param args - Arguments, in order.
 * @returns A single command line with every word quoted as it needs.
 */
export function windowsCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteForCmd).join(" ");
}

/** How to hand one command to Node's spawn functions on this platform. */
export interface Invocation {
  /** What to pass as the command: the name itself, or a whole command line on Windows. */
  readonly command: string;
  /** What to pass as the arguments: empty on Windows, where they're already in the command line. */
  readonly args: readonly string[];
  /** Whether a shell runs it. */
  readonly shell: boolean;
}

/**
 * Decides how to start a command on this platform.
 *
 * Windows gets one pre-quoted command line and no separate arguments, because Node only
 * concatenates arguments when a shell is used and doesn't escape them. Everywhere else the command
 * and arguments are passed as they are, with no shell involved at all.
 * @param command - Executable name or path.
 * @param args - Arguments, in order.
 * @param platform - The platform; defaults to this one.
 * @returns The command, arguments, and shell flag to spawn with.
 */
export function invocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): Invocation {
  if (platform !== "win32") {
    return { command, args, shell: false };
  }
  return { command: windowsCommandLine(command, args), args: [], shell: true };
}

/** Injectable lookups for {@link commandFound}, so tests never depend on what's installed. */
export interface FindDeps {
  /** The platform; defaults to this one. */
  readonly platform?: NodeJS.Platform;
  /** Exit code of `where.exe <name>`; 0 when the name resolves. */
  readonly probe?: (name: string) => number | null;
  /** Whether a path exists on disk. */
  readonly exists?: (path: string) => boolean;
}

/**
 * Reports whether a command can be started, where that can't be told from its exit code.
 *
 * On POSIX a missing command reports itself (the spawn fails with ENOENT), so this always says yes
 * and lets the spawn answer. On Windows a shell reports a missing command as exit 1, so the name is
 * looked up first with `where.exe` — a real executable, which spawns without a shell.
 * @param command - Executable name or path.
 * @param deps - Injectable platform and lookups.
 * @returns False only when Windows could not find the command.
 */
export function commandFound(command: string, deps: FindDeps = {}): boolean {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    return true;
  }
  const exists = deps.exists ?? existsSync;
  // A path is checked on disk: `where` takes patterns to search for, not paths that already resolve.
  if (command.includes("/") || command.includes("\\")) {
    return exists(command);
  }
  const probe =
    deps.probe ?? ((name) => spawnSync("where.exe", [name], { stdio: "ignore" }).status);
  return probe(command) === 0;
}
