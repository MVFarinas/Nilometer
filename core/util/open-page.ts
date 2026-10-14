/**
 * @file Opening a saved HTML page with the platform's own opener (D-082, step G2.10).
 *
 * `report --save --html --open` hands the page to whatever opens files on this machine: `open` on
 * macOS, `start` on Windows, `xdg-open` elsewhere. Nothing here decides which browser runs. A failed
 * open is reported to the caller, which still succeeds: the page is saved either way, and over SSH
 * or in a script there may be no browser to open.
 */
import { spawnSync } from "node:child_process";

import { type Invocation, invocation } from "./commands.js";

/** How long an opener may take before it's taken as not having opened the page. */
const OPENER_TIMEOUT_MS = 15_000;

/** The command and arguments that open one file. */
export interface Opener {
  /** The opener's name. */
  readonly command: string;
  /** Its arguments, ending with the file. */
  readonly args: readonly string[];
}

/** What came of an attempt to open the page. */
export type OpenResult =
  | { readonly opened: true }
  | {
      readonly opened: false;
      /** Why, in a few words, for the message that prints the path instead. */
      readonly reason: string;
    };

/** What starting the opener reported. */
export interface OpenerRun {
  /** Exit code; null when it didn't exit by itself. */
  readonly status: number | null;
  /** Set when the opener couldn't be started, or was stopped for taking too long. */
  readonly error?: Error | undefined;
}

/** Injectable platform and process start, so tests never launch a browser. */
export interface OpenDeps {
  /** The platform; defaults to this one. */
  readonly platform?: NodeJS.Platform;
  /** Starts the opener and waits for it; defaults to {@link spawnOpener}. */
  readonly run?: (call: Invocation) => OpenerRun;
}

/**
 * Names the platform's opener for a file.
 * @param path - The file to open.
 * @param platform - The platform.
 * @returns The command and arguments.
 * @example
 * openerFor("/tmp/report.html", "darwin"); // { command: "open", args: ["/tmp/report.html"] }
 */
export function openerFor(path: string, platform: NodeJS.Platform): Opener {
  if (platform === "darwin") {
    return { command: "open", args: [path] };
  }
  if (platform === "win32") {
    // start is a cmd.exe builtin, and its first quoted word is a window title; the empty title
    // keeps a quoted path from being read as one.
    return { command: "start", args: ["", path] };
  }
  return { command: "xdg-open", args: [path] };
}

/**
 * Runs an opener and waits for it to exit. `open`, `start`, and `xdg-open` hand the file over and
 * return; the timeout covers one that doesn't.
 * @param call - The command, arguments, and shell flag from {@link invocation}.
 * @returns Its exit code, and the error when it couldn't start or timed out.
 */
export function spawnOpener(call: Invocation): OpenerRun {
  const result = spawnSync(call.command, call.args, {
    shell: call.shell,
    // Nothing the opener prints belongs in the report's output, which may be JSON on stdout.
    stdio: "ignore",
    timeout: OPENER_TIMEOUT_MS,
  });
  return { status: result.status, error: result.error };
}

/**
 * Opens a saved page with the platform's opener (D-082).
 * @param path - The saved page.
 * @param deps - Injectable platform and process start.
 * @returns Opened, or why not.
 */
export function openPage(path: string, deps: OpenDeps = {}): OpenResult {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? spawnOpener;
  const opener = openerFor(path, platform);
  const result = run(invocation(opener.command, opener.args, platform));
  if (result.error !== undefined) {
    return { opened: false, reason: `${opener.command} couldn't run: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      opened: false,
      reason: `${opener.command} exited with ${result.status === null ? "no code" : String(result.status)}`,
    };
  }
  return { opened: true };
}
