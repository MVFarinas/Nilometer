/**
 * @file The `init` and `uninstall` operations: register the status line hook, and reverse it.
 *
 * Implements README § How it works ("Chaining, not clobbering"), docs/development.md P1.3, and the
 * `statusline-collector` skill's `init` steps: back up first, wrap an existing command, write
 * atomically, be idempotent, and make `uninstall` restore the original exactly.
 *
 * Both operations return a plain outcome object. Wording for the user belongs to the CLI layer,
 * so outcomes can be tested without asserting on prose.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  type SettingsFormat,
  backupSettings,
  locateSettings,
  readSettings,
  serializeSettings,
  writeFileAtomic,
} from "../settings/settings-file.js";
import {
  buildHookCommand,
  dataDirFromHookCommand,
  isCommandEntry,
  planInstall,
  planUninstall,
} from "../settings/statusline.js";
import { HOOK_RELATIVE_PATH, INSTALLED_HOOK_FILE, resolveDataDir } from "./locations.js";
import { ensurePrivateDir, installHook } from "./private-files.js";
import { readInstallRecord, removeInstallRecord, writeInstallRecord } from "./record.js";

/** Layout used when `init` creates a settings file from scratch: what Claude Code writes. */
export const DEFAULT_FORMAT: SettingsFormat = { indent: 2, trailingNewline: true };

/** Inputs shared by {@link runInit} and {@link runUninstall}. */
export interface InstallOptions {
  /** The user's home directory. */
  readonly home: string;
  /** Environment variables consulted for locations. */
  readonly env: {
    readonly CLAUDE_CONFIG_DIR?: string | undefined;
    readonly NILOMETER_HOME?: string | undefined;
    readonly XDG_DATA_HOME?: string | undefined;
  };
  /** `--settings` flag value, if given. */
  readonly settingsOverride?: string | undefined;
  /** `--data-dir` flag value, if given. */
  readonly dataDirOverride?: string | undefined;
  /** Package root containing `hooks/statusline.sh`. */
  readonly packageRoot: string;
  /** Current time, injected for deterministic backup names. */
  readonly now: Date;
  /** The platform, for tests; defaults to this one. Decides whether file modes are set (D-049). */
  readonly platform?: NodeJS.Platform;
}

/** Result of {@link runInit}. */
export interface InitOutcome {
  /**
   * True when this run wrote a new copy of the hook into the data directory: a first install, or a
   * package whose hook changed since last time (D-056). A stale copy would keep recording with the
   * previous version's behaviour, so `init` says when it refreshed one.
   */
  readonly hookRefreshed: boolean;
  /**
   * What happened:
   * - `installed`: the hook now runs, wrapping any original command
   * - `updated`: our entry pointed at an old hook location and was corrected
   * - `already-installed`: nothing changed
   * - `refused-unsupported`: `statusLine` isn't a command entry; nothing changed
   * - `refused-other-install`: our hook is installed with a different data directory; nothing changed
   */
  readonly action:
    "installed" | "updated" | "already-installed" | "refused-unsupported" | "refused-other-install";
  /** Settings file operated on. */
  readonly settingsPath: string;
  /** Data directory the hook records into. */
  readonly dataDir: string;
  /** Backup created by this run, or null if nothing was written or there was no file. */
  readonly backupPath: string | null;
  /** The user's original command that the hook now wraps, or null. */
  readonly wrappedCommand: string | null;
}

/**
 * Resolves the settings path, data directory, and hook command for a run.
 * @param options - Install options.
 * @returns The three resolved locations.
 */
export function resolveTargets(options: InstallOptions): {
  settingsPath: string;
  dataDir: string;
  hookCommand: string;
  hookPath: string;
} {
  const settingsPath = locateSettings({
    home: options.home,
    override: options.settingsOverride,
    claudeConfigDir: options.env.CLAUDE_CONFIG_DIR,
  });
  const dataDir = resolveDataDir({
    home: options.home,
    env: options.env,
    override: options.dataDirOverride,
  });
  // The command names the copy in the data directory, which nothing moves, not the one in the
  // package, whose path changes with the Node version or the checkout's location (D-056).
  const hookPath = join(dataDir, INSTALLED_HOOK_FILE);
  const hookCommand = buildHookCommand(hookPath, dataDir);
  return { settingsPath, dataDir, hookCommand, hookPath };
}

/**
 * Registers the status line hook in Claude Code's settings. Safe to run repeatedly.
 * @param options - Locations, environment, and clock.
 * @returns What happened, with the paths involved.
 * @throws {import("../settings/settings-file.js").SettingsError} If the settings file can't be
 *   parsed; nothing is changed.
 * @throws {import("./record.js").InstallRecordError} If an existing install record is corrupt.
 */
export function runInit(options: InstallOptions): InitOutcome {
  const { settingsPath, dataDir, hookCommand, hookPath } = resolveTargets(options);
  const read = readSettings(settingsPath);
  const settings = read.kind === "ok" ? read.settings : null;
  const plan = planInstall(settings, hookCommand);
  // Before the settings can name it, and on every run: a package whose hook changed needs the copy
  // refreshed, even when the command itself is already correct (D-056).
  const platform = options.platform ?? process.platform;
  let hookRefreshed = false;
  if (plan.action !== "refuse") {
    ensurePrivateDir(dataDir, platform);
    hookRefreshed = installHook(join(options.packageRoot, HOOK_RELATIVE_PATH), hookPath, platform);
  }
  const base = { settingsPath, dataDir, hookRefreshed };

  switch (plan.action) {
    case "none":
      return { ...base, action: "already-installed", backupPath: null, wrappedCommand: wrapped() };
    case "refuse":
      return { ...base, action: "refused-unsupported", backupPath: null, wrappedCommand: null };
    case "update-command": {
      // The record lives in the data directory. If this data directory has none, the hook was
      // installed with another one, and moving on would lose the user's original command.
      if (readInstallRecord(dataDir) === null) {
        return { ...base, action: "refused-other-install", backupPath: null, wrappedCommand: null };
      }
      const backupPath = backupSettings(settingsPath, options.now);
      writeSettings(settingsPath, plan.settings, read.kind === "ok" ? read.format : DEFAULT_FORMAT);
      return { ...base, action: "updated", backupPath, wrappedCommand: wrapped() };
    }
    case "install": {
      const backupPath = backupSettings(settingsPath, options.now);
      // Record first: once settings point at the hook, its next run must find the original command.
      writeInstallRecord(dataDir, {
        version: 1,
        settingsPath,
        settingsExisted: read.kind === "ok",
        backupPath,
        original: plan.original,
        installedAt: options.now.toISOString(),
      });
      writeSettings(settingsPath, plan.settings, read.kind === "ok" ? read.format : DEFAULT_FORMAT);
      return { ...base, action: "installed", backupPath, wrappedCommand: wrapped() };
    }
  }

  /**
   * Reads which original command the hook wraps, from the record in this data directory.
   * @returns The wrapped command, or null if there is none.
   */
  function wrapped(): string | null {
    return readInstallRecord(dataDir)?.original?.command ?? null;
  }
}

/**
 * Serializes settings and writes them atomically, creating the directory if needed.
 * @param path - Settings file path.
 * @param settings - Settings to write.
 * @param format - Layout to use.
 */
function writeSettings(
  path: string,
  settings: Record<string, unknown>,
  format: SettingsFormat,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, serializeSettings(settings, format));
}

/** Result of {@link runUninstall}. */
export interface UninstallOutcome {
  /**
   * What happened:
   * - `restored`: the original `statusLine` is back (or ours is removed when there was none)
   * - `removed-settings-file`: `init` had created the file and nothing else was in it, so it's gone
   * - `not-installed`: nothing to undo
   * - `replaced-by-user`: `statusLine` was changed after install; left alone
   */
  readonly action: "restored" | "removed-settings-file" | "not-installed" | "replaced-by-user";
  /** Settings file operated on. */
  readonly settingsPath: string;
  /** Data directory whose record was used; collected data in it is never deleted. */
  readonly dataDir: string;
  /** Backup created by this run before writing, or null. */
  readonly backupPath: string | null;
  /** True when the file was restored from the pre-install backup's exact bytes. */
  readonly exactBytes: boolean;
  /** True when no install record was found, so an original command couldn't be restored. */
  readonly recordMissing: boolean;
  /**
   * The status line command being restored from the install record, or null when there was none.
   * Printed so the user sees what `uninstall` puts back, since it comes from a file on disk (D-050).
   */
  readonly restoredCommand: string | null;
}

/**
 * Removes the hook from Claude Code's settings and restores what `init` replaced.
 * Collected data (spool, error log) is kept.
 * @param options - Locations, environment, and clock.
 * @returns What happened, with the paths involved.
 * @throws {import("../settings/settings-file.js").SettingsError} If the settings file can't be
 *   parsed; nothing is changed.
 * @throws {import("./record.js").InstallRecordError} If the install record is corrupt.
 */
export function runUninstall(options: InstallOptions): UninstallOutcome {
  const targets = resolveTargets(options);
  let dataDir = targets.dataDir;
  let record = readInstallRecord(dataDir);
  // The record knows which file was changed, even if flags or environment differ today.
  const settingsPath = record?.settingsPath ?? targets.settingsPath;
  const read = readSettings(settingsPath);
  if (record === null && read.kind === "ok") {
    // `init --data-dir X` followed by a plain `uninstall` looks for the record in the default
    // directory and doesn't find it. Without the record, the plan below would delete the user's
    // own status line instead of restoring it, so recover the directory from the command that's
    // about to be removed — the one other place `init` wrote that path down (D-050).
    const entry = read.settings["statusLine"];
    const installedAt = isCommandEntry(entry) ? dataDirFromHookCommand(entry.command) : null;
    const recovered = installedAt === null ? null : readInstallRecord(installedAt);
    if (installedAt !== null && recovered !== null) {
      record = recovered;
      dataDir = installedAt;
    }
  }
  const settings = read.kind === "ok" ? read.settings : null;
  const plan = planUninstall(settings, record?.original ?? null);
  const base = {
    settingsPath,
    dataDir,
    recordMissing: record === null,
    restoredCommand: record?.original?.command ?? null,
  };

  if (plan.action === "none" || read.kind !== "ok") {
    const action = plan.action === "none" ? plan.reason : "not-installed";
    return { ...base, action, backupPath: null, exactBytes: false };
  }

  const backupPath = backupSettings(settingsPath, options.now);
  // init created this file and nothing else was added since: the faithful undo is no file at all.
  if (record !== null && !record.settingsExisted && Object.keys(plan.settings).length === 0) {
    rmSync(settingsPath);
    removeInstallRecord(dataDir);
    return { ...base, action: "removed-settings-file", backupPath, exactBytes: true };
  }
  // If the result equals the pre-install file, write its exact bytes: a re-serialization could
  // differ in whitespace the JSON parser discarded.
  const original = record?.backupPath ?? null;
  if (original !== null && existsSync(original)) {
    const originalRaw = readFileSync(original, "utf8");
    if (isDeepStrictEqual(JSON.parse(originalRaw), plan.settings)) {
      writeFileAtomic(settingsPath, originalRaw);
      removeInstallRecord(dataDir);
      return { ...base, action: "restored", backupPath, exactBytes: true };
    }
  }
  writeFileAtomic(settingsPath, serializeSettings(plan.settings, read.format));
  removeInstallRecord(dataDir);
  return { ...base, action: "restored", backupPath, exactBytes: false };
}
