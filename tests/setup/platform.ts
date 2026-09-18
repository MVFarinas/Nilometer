/**
 * @file Platform facts for tests that spawn a shell, check file modes, create symbolic links, or
 * compare paths (D-049).
 *
 * Nilometer supports Windows with Git for Windows. There, Node can't resolve `/bin/sh` (Git's `sh`
 * is found through PATH), `chmod` only toggles the read-only attribute, creating a symbolic link
 * needs Developer Mode or administrator rights, and `path.join` uses `\`. Tests of those behaviors
 * either adapt or skip, and say which.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** True on Windows. */
export const IS_WINDOWS = process.platform === "win32";

/** The POSIX shell to spawn: `/bin/sh`, or on Windows `sh` from PATH (Git for Windows). */
export const SH = IS_WINDOWS ? "sh" : "/bin/sh";

/** Whether permission modes can be set and read back (not on Windows; D-049). */
export const HAS_POSIX_MODES = !IS_WINDOWS;

/**
 * Checks whether this process may create a symbolic link.
 * @returns True when a test link could be created and removed.
 */
function probeSymlinks(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "aua-symlink-probe-"));
  try {
    writeFileSync(join(dir, "target"), "");
    symlinkSync(join(dir, "target"), join(dir, "link"));
    return true;
  } catch {
    // EPERM on Windows without Developer Mode; any failure means links can't be tested here.
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether tests may create symbolic links. */
export const CAN_SYMLINK = probeSymlinks();

/**
 * Writes a path with `/` separators, for comparing platform paths with POSIX-style expectations.
 * @param path - A path from `path.join` or the filesystem.
 * @returns The same path with every `\` replaced by `/`; unchanged on POSIX.
 */
export function slash(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Environment for a child process that must use `home` as its home directory.
 * @param home - The temporary home.
 * @returns HOME, and on Windows also USERPROFILE (which `os.homedir()` reads there), plus the
 *   variables Windows programs need to start (`SystemRoot`, `TEMP`, `TMP`). Nothing else is inherited,
 *   so no CLAUDE_CONFIG_DIR or XDG variable can leak in, and a test never touches the real profile.
 */
export function homeEnv(home: string): Record<string, string> {
  const env: Record<string, string> = { HOME: home, PATH: process.env["PATH"] ?? "" };
  if (IS_WINDOWS) {
    env["USERPROFILE"] = home;
    for (const name of ["SystemRoot", "TEMP", "TMP"]) {
      const value = process.env[name];
      if (value !== undefined) {
        env[name] = value;
      }
    }
  }
  return env;
}
