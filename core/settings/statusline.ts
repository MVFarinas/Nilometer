/**
 * @file Deciding how `init` and `uninstall` change the `statusLine` entry in settings.
 *
 * Implements README § How it works ("Chaining, not clobbering") and the `statusline-collector`
 * skill. Everything here is pure: functions take a settings object and return a new one plus a
 * description of what changed. Reading and writing files is `settings-file.ts`'s job, so every
 * decision can be tested without touching a disk.
 */
import { isAbsolute } from "node:path";

import type { SettingsObject } from "./settings-file.js";

/**
 * Comment appended to the hook command. It identifies our entry even if the repository moves,
 * so `init` never wraps its own hook (docs/development.md P1.2, "already ours").
 */
export const HOOK_MARKER = "# nilometer-hook";

/** A `statusLine` entry as Claude Code stores it. Unknown fields (e.g. `padding`) are preserved. */
export interface StatusLineEntry {
  /** Entry type. Only `"command"` is supported. */
  readonly type: string;
  /** Shell command Claude Code runs after each turn. */
  readonly command: string;
  /** Any other fields Claude Code supports; carried through untouched. */
  readonly [key: string]: unknown;
}

/** What the current `statusLine` entry is, relative to our hook. */
export type StatusLineState =
  | { readonly kind: "absent" }
  | { readonly kind: "foreign"; readonly entry: StatusLineEntry }
  | { readonly kind: "ours"; readonly entry: StatusLineEntry }
  | { readonly kind: "ours-outdated"; readonly entry: StatusLineEntry }
  | { readonly kind: "unsupported"; readonly value: unknown };

/**
 * Quotes a string for safe use as one word in a POSIX shell command.
 * @param value - Any string, including spaces, quotes, or `$`.
 * @returns The value in single quotes, with embedded single quotes escaped as `'\''`.
 * @example
 * shellQuote("/a b/it's"); // "'/a b/it'\\''s'"
 */
export function shellQuote(value: string): string {
  // Inside single quotes nothing is special except the closing quote itself.
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Reads the data directory out of a command {@link buildHookCommand} produced.
 *
 * `uninstall` needs the install record, which lives in the data directory, to put the user's own
 * status line back. When it's run without the `--data-dir` the install used, the only other place
 * that path is written down is the command being removed, so read it from there (D-050). Without
 * this, an uninstall that can't find the record deletes the `statusLine` entry instead of
 * restoring it.
 * @param command - A `statusLine.command` value.
 * @returns The data directory, or `null` if the command isn't one of ours or can't be parsed.
 * @example
 * dataDirFromHookCommand("/bin/sh '/repo/hooks/statusline.sh' '/data' # nilometer-hook"); // "/data"
 */
export function dataDirFromHookCommand(command: string): string | null {
  if (!command.includes(HOOK_MARKER)) {
    return null;
  }
  // Two single-quoted words, the hook path then the data directory, as buildHookCommand writes
  // them: `''` can't appear inside one, because shellQuote escapes an embedded quote as `'\''`.
  const match = /^\/bin\/sh '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)' /.exec(command);
  const quoted = match?.[2];
  if (quoted === undefined) {
    return null;
  }
  return quoted.replaceAll(`'\\''`, "'");
}

/**
 * Builds the exact `statusLine.command` string that runs our hook.
 * @param hookPath - Absolute path to `hooks/statusline.sh`.
 * @throws {Error} If either path is relative: the hook would resolve it against whatever directory
 *   Claude Code runs in, which the user doesn't control (D-050).
 * @param dataDir - Absolute path to the tool's data directory.
 * @returns A shell command running the hook under `/bin/sh`, ending in {@link HOOK_MARKER}.
 * @example
 * buildHookCommand("/opt/aua/hooks/statusline.sh", "/home/example/.local/share/nilometer");
 * // "/bin/sh '/opt/aua/hooks/statusline.sh' '/home/example/.local/share/nilometer' # nilometer-hook"
 */
export function buildHookCommand(hookPath: string, dataDir: string): string {
  for (const path of [hookPath, dataDir]) {
    if (!isAbsolute(path)) {
      throw new Error(`the status line command needs absolute paths; got ${path}`);
    }
  }
  // Running through /bin/sh explicitly means the script needn't be executable after a git checkout.
  return `/bin/sh ${shellQuote(hookPath)} ${shellQuote(dataDir)} ${HOOK_MARKER}`;
}

/**
 * Reports whether a value is a usable `statusLine` entry of type `command`.
 * @param value - The raw `statusLine` value from settings.
 * @returns `true` if it is an object with `type: "command"` and a string `command`.
 */
export function isCommandEntry(value: unknown): value is StatusLineEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record["type"] === "command" && typeof record["command"] === "string";
}

/**
 * Classifies the current `statusLine` entry.
 * @param settings - Parsed settings; `null` when the settings file doesn't exist.
 * @param hookCommand - The command {@link buildHookCommand} produces for this installation.
 * @returns The entry's state: absent, someone else's, ours (current or outdated), or unsupported.
 */
export function classifyStatusLine(
  settings: SettingsObject | null,
  hookCommand: string,
): StatusLineState {
  // `in` rather than a truthiness check: an explicit `"statusLine": null` isn't "absent".
  if (settings === null || !("statusLine" in settings)) {
    return { kind: "absent" };
  }
  const value = settings["statusLine"];
  // Anything that isn't a command entry is left alone: wrapping it could change what the user sees.
  if (!isCommandEntry(value)) {
    return { kind: "unsupported", value };
  }
  if (!value.command.includes(HOOK_MARKER)) {
    return { kind: "foreign", entry: value };
  }
  // Ours, but pointing somewhere else (e.g. the repository moved): update the command in place.
  return value.command === hookCommand
    ? { kind: "ours", entry: value }
    : { kind: "ours-outdated", entry: value };
}

/**
 * Returns a copy of settings with `statusLine` replaced, keeping key order.
 * @param settings - Original settings.
 * @param entry - New `statusLine` value, or `undefined` to remove the key.
 * @returns A new object. An existing key stays in place; a new key goes last.
 */
export function withStatusLine(
  settings: SettingsObject,
  entry: StatusLineEntry | undefined,
): SettingsObject {
  const result: SettingsObject = {};
  let replaced = false;
  for (const [key, value] of Object.entries(settings)) {
    if (key === "statusLine") {
      replaced = true;
      // Replacing in position keeps the diff to the one changed entry.
      if (entry !== undefined) {
        result[key] = entry;
      }
      continue;
    }
    result[key] = value;
  }
  if (!replaced && entry !== undefined) {
    result["statusLine"] = entry;
  }
  return result;
}

/** What `init` should do. */
export type InstallPlan =
  | {
      readonly action: "install";
      /** Settings to write. */
      readonly settings: SettingsObject;
      /** The entry being replaced, recorded so `uninstall` can restore it; `null` if none. */
      readonly original: StatusLineEntry | null;
    }
  | {
      readonly action: "update-command";
      /** Settings to write; the previously recorded original is kept as it is. */
      readonly settings: SettingsObject;
    }
  | { readonly action: "none"; readonly reason: "already-installed" }
  | {
      readonly action: "refuse";
      readonly reason: "unsupported-statusline";
      readonly value: unknown;
    };

/**
 * Plans the settings change for `init`. Pure: nothing is written.
 * @param settings - Current settings; `null` when the file doesn't exist.
 * @param hookCommand - The command that runs our hook.
 * @returns The plan: install (with the original to record), update our command, do nothing, or
 *   refuse because the existing entry isn't a command.
 */
export function planInstall(settings: SettingsObject | null, hookCommand: string): InstallPlan {
  const state = classifyStatusLine(settings, hookCommand);
  const base = settings ?? {};
  switch (state.kind) {
    case "absent":
      return {
        action: "install",
        settings: withStatusLine(base, { type: "command", command: hookCommand }),
        original: null,
      };
    case "foreign":
      // Keep every other field of the user's entry (padding and anything added later).
      return {
        action: "install",
        settings: withStatusLine(base, { ...state.entry, command: hookCommand }),
        original: state.entry,
      };
    case "ours":
      // Running init twice must not wrap the wrapper.
      return { action: "none", reason: "already-installed" };
    case "ours-outdated":
      return {
        action: "update-command",
        settings: withStatusLine(base, { ...state.entry, command: hookCommand }),
      };
    case "unsupported":
      return { action: "refuse", reason: "unsupported-statusline", value: state.value };
  }
}

/** What `uninstall` should do. */
export type UninstallPlan =
  | { readonly action: "restore"; readonly settings: SettingsObject }
  | { readonly action: "none"; readonly reason: "not-installed" | "replaced-by-user" };

/**
 * Plans the settings change for `uninstall`. Pure: nothing is written.
 * @param settings - Current settings; `null` when the file doesn't exist.
 * @param original - The entry recorded at install time; `null` if there was none.
 * @returns Restore the original entry (or remove ours), or do nothing. If the current entry isn't
 *   ours, the user changed it after install, and it's left alone rather than clobbered.
 */
export function planUninstall(
  settings: SettingsObject | null,
  original: StatusLineEntry | null,
): UninstallPlan {
  if (settings === null || !("statusLine" in settings)) {
    return { action: "none", reason: "not-installed" };
  }
  const value = settings["statusLine"];
  if (!isCommandEntry(value) || !value.command.includes(HOOK_MARKER)) {
    return { action: "none", reason: "replaced-by-user" };
  }
  return { action: "restore", settings: withStatusLine(settings, original ?? undefined) };
}
