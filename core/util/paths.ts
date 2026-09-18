/**
 * @file Path helpers shared by ingestion and `init`.
 *
 * Implements README § How it works (session logs are read from `~/.claude/projects/`).
 * Paths in configuration and environment variables may start with `~`, which Node's `fs`
 * does not expand, so every path from outside the program passes through {@link expandHome}.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expands a leading `~` in a path to the given home directory.
 *
 * Only the current user's home is supported: `~` alone and `~/...`. A `~user/...` form is
 * returned unchanged, because resolving another user's home needs a system lookup this tool
 * has no reason to make.
 * @param path - A filesystem path, possibly starting with `~`.
 * @param home - The home directory to substitute. Defaults to the current user's home; tests
 *   pass a fixed value so results don't depend on the machine.
 * @returns The path with `~` expanded, or the input unchanged if it has no leading `~`.
 * @example
 * expandHome("~/.claude/projects", "/home/example"); // "/home/example/.claude/projects"
 * expandHome("/tmp/logs", "/home/example");          // "/tmp/logs"
 */
export function expandHome(path: string, home: string = homedir()): string {
  // A bare "~" means the home directory itself.
  if (path === "~") {
    return home;
  }
  // Only "~/" is expanded. "~user/" and "~" in the middle of a path are left alone on purpose.
  if (path.startsWith("~/")) {
    // join() normalizes separators, so "~//x" still becomes "<home>/x".
    return join(home, path.slice(2));
  }
  return path;
}
