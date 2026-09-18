/**
 * @file Owner-only storage for Nilometer's data (D-043).
 *
 * The database holds copies of session log lines (prompts, code, file paths) and the spool holds
 * status line payloads. Claude Code keeps its own transcripts owner-only (`~/.claude` 0700,
 * transcripts 0600; observed 2026-09-13), so Nilometer's copies must be no easier to read:
 * directories 0700, files 0600. New paths are created that way, and existing installs are tightened
 * the next time Nilometer opens them. Nothing here ever loosens a mode.
 *
 * On Windows none of this applies (D-049): Node's `chmod` there only toggles the read-only attribute,
 * so a mode can't be tightened and reads back as 666 whatever was set. Tightening is skipped rather
 * than reported as done, and the data relies on the user profile folder's permissions.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Mode for directories Nilometer owns. */
export const PRIVATE_DIR_MODE = 0o700;

/** Mode for files Nilometer writes. */
export const PRIVATE_FILE_MODE = 0o600;

/** Files Nilometer keeps in its data directory; their presence also identifies one. */
export const DATA_DIR_FILES = [
  "usage.db",
  "usage.db-wal",
  "usage.db-shm",
  "statusline.spool.jsonl",
  "hook-errors.log",
  "install-record.json",
  "wrapped-command",
  "statusline.sh",
] as const;

/** Subdirectories of the data directory whose files are all Nilometer's. */
export const DATA_DIR_SUBDIRS = ["reports"] as const;

/**
 * Tells whether POSIX permission modes mean anything on a platform.
 * @param platform - A `process.platform` value.
 * @returns False on Windows, where `chmod` only toggles read-only (D-049).
 */
export function hasPosixModes(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

/**
 * Removes group and other permission bits from an existing path, never loosening anything.
 * @param path - A file or directory.
 * @param platform - The platform, for tests; defaults to this one.
 * @returns True when the mode changed; false when it was already owner-only, is missing, is a
 *   symbolic link (chmod would follow the link and change a file Nilometer doesn't own), or the
 *   platform has no POSIX modes.
 */
export function tightenMode(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!hasPosixModes(platform) || !existsSync(path)) {
    return false;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return false;
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) === 0) {
    return false;
  }
  chmodSync(path, mode & 0o700);
  return true;
}

/**
 * Creates a directory owner-only if it doesn't exist.
 * @param dir - The directory.
 * @param platform - The platform, for tests; defaults to this one.
 * @returns True when this call created it.
 */
export function ensurePrivateDir(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (existsSync(dir)) {
    return false;
  }
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (hasPosixModes(platform)) {
    // mkdir's mode is filtered by the umask, and only the last component gets it exactly; chmod makes it certain.
    chmodSync(dir, PRIVATE_DIR_MODE);
  }
  return true;
}

/**
 * Creates an empty file owner-only if it doesn't exist, so a library that then opens it keeps that mode.
 * @param path - The file.
 * @param platform - The platform, for tests; defaults to this one.
 * @returns True when this call created it.
 * @throws {Error} If the file can't be created for a reason other than already existing.
 */
export function ensurePrivateFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (existsSync(path)) {
    return false;
  }
  // "wx": another process creating it first is fine; this only needs the file to exist privately.
  try {
    closeSync(openSync(path, "wx", PRIVATE_FILE_MODE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    return false;
  }
  if (hasPosixModes(platform)) {
    chmodSync(path, PRIVATE_FILE_MODE);
  }
  return true;
}

/**
 * Makes a data directory and everything Nilometer keeps in it owner-only.
 *
 * A directory created here is private from the start. An existing directory is tightened only if it
 * already holds a Nilometer file, so pointing `--data-dir` at a shared folder by mistake never
 * changes that folder's permissions; Nilometer's own files inside it are still tightened.
 * @param dataDir - The data directory.
 * @param platform - The platform, for tests; defaults to this one.
 * @returns Paths whose permissions were tightened (empty for a new or already private directory,
 *   and always empty on Windows, where there's nothing to tighten; D-049).
 */
export function securePrivateDataDir(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (ensurePrivateDir(dataDir, platform) || !hasPosixModes(platform)) {
    return [];
  }
  const tightened: string[] = [];
  const owned = DATA_DIR_FILES.some((name) => existsSync(join(dataDir, name)));
  if (owned && tightenMode(dataDir)) {
    tightened.push(dataDir);
  }
  for (const name of DATA_DIR_FILES) {
    const path = join(dataDir, name);
    if (tightenMode(path)) {
      tightened.push(path);
    }
  }
  for (const sub of DATA_DIR_SUBDIRS) {
    const dir = join(dataDir, sub);
    if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) {
      continue;
    }
    if (tightenMode(dir)) {
      tightened.push(dir);
    }
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (tightenMode(path)) {
        tightened.push(path);
      }
    }
  }
  return tightened;
}

/**
 * Describes a tightening for the user, once, when it happens.
 * @param tightened - Paths from {@link securePrivateDataDir}.
 * @returns One line, or null when nothing changed.
 */
export function describeTightened(tightened: readonly string[]): string | null {
  if (tightened.length === 0) {
    return null;
  }
  const noun = tightened.length === 1 ? "path was" : "paths were";
  return `Made Nilometer's data owner-only: ${tightened.length} ${noun} readable by other accounts on this computer.`;
}

/**
 * Installs the hook script into the data directory, replacing an older copy.
 *
 * The status line command names this copy, not the one in the package, so upgrading Node or moving
 * the checkout can't leave the command pointing at nothing (D-056). Written through a temporary
 * file and a rename, so a hook that is running during an upgrade never reads a half-written script.
 * @param source - The hook inside the package.
 * @param destination - Where it goes, inside the data directory.
 * @param platform - The platform, for tests; defaults to this one.
 * @returns True when the copy changed, so `init` can say the hook was refreshed.
 * @throws {Error} If the destination is a symbolic link. Its contents are executed on every reply,
 *   and `init` only ever writes a regular file there (D-050).
 */
export function installHook(
  source: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) {
    throw new Error(`${destination} is a symbolic link; refusing to write the hook through it`);
  }
  const wanted = readFileSync(source);
  if (existsSync(destination) && readFileSync(destination).equals(wanted)) {
    return false;
  }
  // Same directory as the destination, so the rename is atomic.
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, wanted, { mode: PRIVATE_FILE_MODE });
    if (hasPosixModes(platform)) {
      // writeFile's mode is filtered by the umask; chmod makes it exact.
      chmodSync(temp, PRIVATE_FILE_MODE);
    }
    renameSync(temp, destination);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return true;
}

/** What {@link deleteDataFiles} removed. */
export interface DataDeletion {
  /** Names removed from the data directory, in the order they were tried. */
  readonly removed: string[];
  /** True when the directory itself was removed because nothing else was left in it. */
  readonly directoryRemoved: boolean;
  /** Names found in the directory that Nilometer doesn't own, so weren't touched. */
  readonly kept: string[];
}

/**
 * Removes the files Nilometer keeps in a data directory, and the directory if nothing else is left.
 *
 * Only the names Nilometer writes are removed ({@link DATA_DIR_FILES}, {@link DATA_DIR_SUBDIRS}).
 * A user can point `--data-dir` at a folder that holds other things, and deleting a directory
 * because of what it is called would take those with it (D-043 leaves shared folders alone). What
 * was left behind is reported rather than removed (R2.5).
 * @param dataDir - The data directory.
 * @returns What was removed and what was left.
 */
export function deleteDataFiles(dataDir: string): DataDeletion {
  const removed: string[] = [];
  if (!existsSync(dataDir)) {
    return { removed, directoryRemoved: false, kept: [] };
  }
  const ours = new Set<string>([...DATA_DIR_FILES, ...DATA_DIR_SUBDIRS]);
  for (const name of readdirSync(dataDir)) {
    if (ours.has(name)) {
      rmSync(join(dataDir, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  const kept = readdirSync(dataDir);
  if (kept.length === 0) {
    // rmdir, not rm: it fails rather than succeeds if anything appeared since the check above.
    rmdirSync(dataDir);
  }
  return { removed, directoryRemoved: kept.length === 0, kept };
}
