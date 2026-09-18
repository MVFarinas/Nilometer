/**
 * @file Reading, backing up, and atomically writing Claude Code's `settings.json`.
 *
 * Implements README § How it works ("Chaining, not clobbering") and the `statusline-collector`
 * skill's `init` rules. The settings file belongs to the user, so every operation here:
 * - backs up before writing,
 * - refuses to "fix" a file it can't parse (report, don't fix),
 * - writes atomically (temp file + rename), so a crash never leaves a half-written file,
 * - keeps the file's key order, indentation, trailing newline, and permissions, so the diff
 *   shows only the change that was made.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { expandHome } from "../util/paths.js";

/** Why a settings file couldn't be used. */
export type SettingsErrorCode = "invalid-json" | "not-an-object" | "empty" | "dangling-link";

/** A settings file that exists but can't be safely edited. The file is never modified. */
export class SettingsError extends Error {
  /** Machine-readable reason, used by `init` to choose its message. */
  readonly code: SettingsErrorCode;

  /** Path of the offending file. */
  readonly path: string;

  /**
   * Creates a settings error.
   * @param code - Machine-readable reason.
   * @param path - Path of the offending file.
   * @param message - Human-readable explanation.
   */
  constructor(code: SettingsErrorCode, path: string, message: string) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
    this.path = path;
  }
}

/** A parsed JSON object with keys in file order. */
export type SettingsObject = Record<string, unknown>;

/** How the file was laid out, so a rewrite can match it. */
export interface SettingsFormat {
  /** The indentation unit: a number of spaces, or a tab character. */
  readonly indent: number | "\t";
  /** Whether the file ended with a newline. */
  readonly trailingNewline: boolean;
}

/** The result of reading a settings file. */
export type SettingsRead =
  | { readonly kind: "missing"; readonly path: string }
  | {
      readonly kind: "ok";
      readonly path: string;
      /** Parsed settings, keys in file order. */
      readonly settings: SettingsObject;
      /** The exact file text, kept so an unchanged object can be written back byte-for-byte. */
      readonly raw: string;
      /** Detected layout. */
      readonly format: SettingsFormat;
    };

/** Inputs to {@link locateSettings}. */
export interface LocateOptions {
  /** The user's home directory. */
  readonly home: string;
  /** Explicit settings path from a command-line flag; wins over everything. May start with `~`. */
  readonly override?: string | undefined;
  /** Value of the `CLAUDE_CONFIG_DIR` environment variable, if set. May start with `~`. */
  readonly claudeConfigDir?: string | undefined;
}

/**
 * Decides which settings file `init` operates on.
 *
 * Order: an explicit `--settings` path, then `$CLAUDE_CONFIG_DIR/settings.json`, then
 * `~/.claude/settings.json`. Project-level settings are never chosen: the hook is per user.
 * @param options - Home directory, flag override, and environment.
 * @returns Absolute or home-expanded path to the settings file (which may not exist yet).
 */
export function locateSettings(options: LocateOptions): string {
  if (options.override !== undefined && options.override !== "") {
    return expandHome(options.override, options.home);
  }
  if (options.claudeConfigDir !== undefined && options.claudeConfigDir !== "") {
    return join(expandHome(options.claudeConfigDir, options.home), "settings.json");
  }
  return join(options.home, ".claude", "settings.json");
}

/**
 * Detects the indentation and trailing newline of a JSON text.
 *
 * Uses the first indented line; a file with no indented lines (e.g. `{}`) falls back to two
 * spaces, the formatting Claude Code itself writes.
 * @param raw - The file's text.
 * @returns The layout to reuse when rewriting the file.
 */
export function detectFormat(raw: string): SettingsFormat {
  const trailingNewline = raw.endsWith("\n");
  // The first line that starts with whitespace followed by content defines the indent unit.
  const match = /^([ \t]+)\S/m.exec(raw);
  const leading = match?.[1];
  if (leading === undefined) {
    return { indent: 2, trailingNewline };
  }
  return { indent: leading.startsWith("\t") ? "\t" : leading.length, trailingNewline };
}

/**
 * Reports whether a path is a symbolic link, without following it.
 * @param path - Path to inspect.
 * @returns True if the path itself is a symbolic link.
 */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    // No such path, or its parent can't be read: not a link this code has to handle.
    return false;
  }
}

/**
 * Reads and parses a settings file without modifying it.
 * @param path - Path to the settings file.
 * @returns `missing` if the file doesn't exist, otherwise the parsed settings with raw text.
 * @throws {SettingsError} If the file is empty, isn't valid JSON, or isn't a JSON object.
 */
export function readSettings(path: string): SettingsRead {
  // A symbolic link to a file that isn't there yet would otherwise look like "no settings file",
  // and `init` would create whatever the link points at, which may be any path on the machine
  // (D-050). A link to an existing file is followed: that's how a dotfiles repository is set up.
  if (!existsSync(path) && isLink(path)) {
    throw new SettingsError(
      "dangling-link",
      path,
      `${path} is a symbolic link to a file that doesn't exist; refusing to create its target`,
    );
  }
  if (!existsSync(path)) {
    return { kind: "missing", path };
  }
  const raw = readFileSync(path, "utf8");
  // An empty file isn't silently treated as `{}`: that would be fixing the user's file.
  if (raw.trim() === "") {
    throw new SettingsError("empty", path, `${path} is empty; refusing to guess its contents`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SettingsError("invalid-json", path, `${path} is not valid JSON: ${reason}`);
  }
  // Arrays and primitives are valid JSON but not settings; editing them could destroy data.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsError("not-an-object", path, `${path} does not contain a JSON object`);
  }
  return {
    kind: "ok",
    path,
    settings: parsed as SettingsObject,
    raw,
    format: detectFormat(raw),
  };
}

/**
 * Formats a UTC timestamp for use in a backup filename.
 * @param now - The moment to format.
 * @returns `YYYYMMDD-HHMMSS` in UTC, safe in filenames on every platform.
 */
export function backupStamp(now: Date): string {
  // toISOString is always UTC, so backups sort chronologically regardless of the machine's zone.
  const iso = now.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/**
 * Copies the settings file to a timestamped backup next to it, never overwriting a backup.
 * @param path - Path to the settings file.
 * @param now - Current time, injected for deterministic names in tests.
 * @returns Path of the backup created, or `null` if there was no file to back up.
 */
export function backupSettings(path: string, now: Date): string | null {
  if (!existsSync(path)) {
    return null;
  }
  const base = `${path}.bak-${backupStamp(now)}`;
  let candidate = base;
  // Two runs within the same second must not overwrite each other's backup.
  for (let suffix = 1; existsSync(candidate); suffix += 1) {
    candidate = `${base}-${suffix}`;
  }
  copyFileSync(path, candidate);
  // Settings can hold secrets (API keys in `env`), and a backup is one more copy: owner-only (D-043).
  chmodSync(candidate, 0o600);
  return candidate;
}

/**
 * Serializes settings using a detected layout.
 * @param settings - The settings object; key order is preserved.
 * @param format - Indentation and trailing-newline style to use.
 * @returns The JSON text to write.
 */
export function serializeSettings(settings: SettingsObject, format: SettingsFormat): string {
  const text = JSON.stringify(settings, null, format.indent);
  return format.trailingNewline ? `${text}\n` : text;
}

/** The filesystem operations {@link writeFileAtomic} needs, injectable to simulate crashes. */
export interface AtomicFs {
  /** Writes a whole file. */
  readonly writeFileSync: (path: string, data: string, options: { mode: number }) => void;
  /** Renames a file, replacing the destination. */
  readonly renameSync: (from: string, to: string) => void;
  /** Removes a file if it exists. */
  readonly rmSync: (path: string, options: { force: boolean }) => void;
  /** Returns a file's permission bits, or `null` if it doesn't exist. */
  readonly modeOf: (path: string) => number | null;
  /** Sets a file's permission bits. */
  readonly chmodSync: (path: string, mode: number) => void;
  /** Returns what a symbolic link points at, or the path itself when it isn't one. */
  readonly resolveLink: (path: string) => string;
}

/** The real filesystem implementation of {@link AtomicFs}. */
export const NODE_ATOMIC_FS: AtomicFs = {
  writeFileSync: (path, data, options) => {
    writeFileSync(path, data, options);
  },
  renameSync: (from, to) => {
    renameSync(from, to);
  },
  rmSync: (path, options) => {
    rmSync(path, options);
  },
  modeOf: (path) => (existsSync(path) ? statSync(path).mode & 0o777 : null),
  chmodSync: (path, mode) => {
    chmodSync(path, mode);
  },
  resolveLink: (path) => (isLink(path) ? realpathSync(path) : path),
};

/**
 * Writes text to a file atomically: a temp file in the same directory, then a rename.
 *
 * Rename within one directory is atomic, so readers see either the old file or the new one,
 * never a partial write. The original file's permissions are kept (settings may be 0600).
 * @param path - Destination file.
 * @param text - Complete new contents.
 * @param fs - Filesystem operations; defaults to the real filesystem.
 * @throws {Error} Whatever the filesystem throws. The temp file is removed first, and the
 *   original file is untouched unless the rename itself succeeded.
 */
export function writeFileAtomic(path: string, text: string, fs: AtomicFs = NODE_ATOMIC_FS): void {
  // A rename replaces a symbolic link with a regular file, which would quietly detach a settings
  // file that a dotfiles repository links to. Write to what the link points at instead (D-050).
  const destination = fs.resolveLink(path);
  // Same directory as the destination: rename across filesystems isn't atomic.
  const temp = join(
    dirname(destination),
    `.${basename(destination)}.tmp-${process.pid}-${Date.now()}`,
  );
  // An existing file keeps its mode; a new one is owner-only, since settings can hold secrets (D-043).
  const mode = fs.modeOf(destination) ?? 0o600;
  try {
    fs.writeFileSync(temp, text, { mode });
    // writeFile's mode is filtered by the umask; chmod makes the result match the original exactly.
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, destination);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}
