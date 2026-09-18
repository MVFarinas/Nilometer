/**
 * @file Unit tests for core/install/install.ts, run against temporary home directories.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { absolute, slash } from "../../../setup/platform.js";

import {
  type InstallOptions,
  resolveTargets,
  runInit,
  runUninstall,
} from "../../../../core/install/install.js";
import { INSTALLED_HOOK_FILE } from "../../../../core/install/locations.js";
import { RECORD_FILE, WRAPPED_COMMAND_FILE } from "../../../../core/install/record.js";
import { SettingsError } from "../../../../core/settings/settings-file.js";
import { HOOK_MARKER, buildHookCommand } from "../../../../core/settings/statusline.js";

/** This repository's root, which contains hooks/statusline.sh. */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** A copy of the package elsewhere, standing in for a package that moved (D-056). */
const PACKAGE_ROOT_COPY = (() => {
  const root = mkdtempSync(join(tmpdir(), "aua-install-pkg-"));
  mkdirSync(join(root, "hooks"), { recursive: true });
  cpSync(join(PACKAGE_ROOT, "hooks", "statusline.sh"), join(root, "hooks", "statusline.sh"));
  writeFileSync(join(root, "package.json"), "{}\n");
  return root;
})();

/** A user's own status line, written with unusual formatting that JSON.stringify can't reproduce. */
const FOREIGN_SETTINGS =
  '{\n    "model": "opus",\n    "statusLine": {"type": "command", "command": "~/bin/status.sh", "padding": 1},\n    "theme": "dark"\n}\n';

/**
 * Creates options for a fresh temporary home directory.
 * @param overrides - Fields to change from the defaults.
 * @returns Install options whose paths all live under a new temp directory.
 */
function freshOptions(overrides: Partial<InstallOptions> = {}): InstallOptions {
  const home = mkdtempSync(join(tmpdir(), "aua-install-test-"));
  return {
    home,
    env: {},
    packageRoot: PACKAGE_ROOT,
    now: new Date("2026-09-13T12:00:00Z"),
    ...overrides,
  };
}

/**
 * Writes a settings file at the default location under a home directory.
 * @param options - Options whose home is used.
 * @param text - Exact file contents.
 * @returns The settings file path.
 */
function writeSettingsText(options: InstallOptions, text: string): string {
  const path = join(options.home, ".claude", "settings.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/**
 * Returns the same options with the clock moved forward, so each run gets a distinct backup name.
 * @param options - Options to copy.
 * @param seconds - Seconds to add.
 * @returns New options.
 */
function later(options: InstallOptions, seconds: number): InstallOptions {
  return { ...options, now: new Date(options.now.getTime() + seconds * 1000) };
}

describe("resolveTargets", () => {
  it("combines default settings path, default data dir, and the hook command", () => {
    const options = freshOptions();
    const dataDir = join(options.home, ".local", "share", "nilometer");
    // The command names the hook inside the data directory, not the one in the package (D-056).
    const hookPath = join(dataDir, INSTALLED_HOOK_FILE);
    expect(resolveTargets(options)).toEqual({
      settingsPath: join(options.home, ".claude", "settings.json"),
      dataDir,
      hookPath,
      hookCommand: buildHookCommand(hookPath, dataDir),
    });
    expect(slash(hookPath)).not.toContain(slash(PACKAGE_ROOT));
  });

  it("honours CLAUDE_CONFIG_DIR and flag overrides", () => {
    const options = freshOptions();
    const targets = resolveTargets({
      ...options,
      env: { CLAUDE_CONFIG_DIR: "/cfg" },
      dataDirOverride: "/flag-data",
    });
    expect(slash(targets.settingsPath)).toBe("/cfg/settings.json");
    expect(slash(targets.dataDir)).toBe(absolute("/flag-data"));
  });
});

describe("runInit", () => {
  it("creates a settings file with the hook when none exists", () => {
    const options = freshOptions();
    const outcome = runInit(options);
    const { settingsPath, dataDir, hookCommand } = resolveTargets(options);
    expect(outcome).toEqual({
      action: "installed",
      settingsPath,
      dataDir,
      backupPath: null,
      wrappedCommand: null,
      hookRefreshed: true,
    });
    expect(readFileSync(settingsPath, "utf8")).toBe(
      `${JSON.stringify({ statusLine: { type: "command", command: hookCommand } }, null, 2)}\n`,
    );
    expect(existsSync(join(dataDir, WRAPPED_COMMAND_FILE))).toBe(false);
    const record = JSON.parse(readFileSync(join(dataDir, RECORD_FILE), "utf8")) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({ settingsExisted: false, original: null, backupPath: null });
  });

  it("adds the hook beside existing settings that have no statusLine, with a backup", () => {
    const options = freshOptions();
    const path = writeSettingsText(options, '{\n  "theme": "dark"\n}\n');
    const outcome = runInit(options);
    expect(outcome.action).toBe("installed");
    expect(outcome.backupPath).toBe(`${path}.bak-20260913-120000`);
    expect(readFileSync(outcome.backupPath!, "utf8")).toBe('{\n  "theme": "dark"\n}\n');
    const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(settings)).toEqual(["theme", "statusLine"]);
  });

  it("wraps a custom statusLine: records it, keeps its padding and the file's indentation", () => {
    const options = freshOptions();
    const path = writeSettingsText(options, FOREIGN_SETTINGS);
    const outcome = runInit(options);
    const { dataDir, hookCommand } = resolveTargets(options);
    expect(outcome.action).toBe("installed");
    expect(outcome.wrappedCommand).toBe("~/bin/status.sh");
    expect(readFileSync(join(dataDir, WRAPPED_COMMAND_FILE), "utf8")).toBe("~/bin/status.sh");
    const text = readFileSync(path, "utf8");
    expect(text.startsWith('{\n    "model"')).toBe(true);
    expect(JSON.parse(text)).toEqual({
      model: "opus",
      statusLine: { type: "command", command: hookCommand, padding: 1 },
      theme: "dark",
    });
  });

  it("is idempotent: a second run changes nothing and makes no backup", () => {
    const options = freshOptions();
    const path = writeSettingsText(options, FOREIGN_SETTINGS);
    runInit(options);
    const afterFirst = readFileSync(path, "utf8");
    const second = runInit(later(options, 1));
    expect(second.action).toBe("already-installed");
    expect(second.backupPath).toBeNull();
    expect(second.wrappedCommand).toBe("~/bin/status.sh");
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
    // Only the one backup from the first run exists: the wrapper was never wrapped.
    expect(readdirSync(dirname(path)).filter((name) => name.includes(".bak-"))).toHaveLength(1);
    expect(readFileSync(path, "utf8").split(HOOK_MARKER)).toHaveLength(2);
  });

  it("leaves the command alone when the package moves, which is the point (D-056)", () => {
    // A global npm install lives under the Node version in use, so an upgrade moves the package.
    // The command names the copy in the data directory, so it keeps working.
    const options = freshOptions();
    const path = writeSettingsText(options, FOREIGN_SETTINGS);
    runInit(options);
    const before = readFileSync(path, "utf8");
    const moved = { ...later(options, 1), packageRoot: PACKAGE_ROOT_COPY };
    const outcome = runInit(moved);
    expect(outcome.action).toBe("already-installed");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(slash(readFileSync(path, "utf8"))).toContain(
      slash(join(resolveTargets(options).dataDir, INSTALLED_HOOK_FILE)),
    );
  });

  it("updates a command left by an install that named the package, keeping the record", () => {
    // Installs made before D-056 point at the package. Running init again moves them across.
    const options = freshOptions();
    const path = writeSettingsText(options, FOREIGN_SETTINGS);
    runInit(options);
    const { dataDir } = resolveTargets(options);
    const old = JSON.parse(readFileSync(path, "utf8")) as { statusLine: { command: string } };
    old.statusLine.command = buildHookCommand(
      join(PACKAGE_ROOT, "hooks", "statusline.sh"),
      dataDir,
    );
    writeFileSync(path, JSON.stringify(old, null, 2));
    const outcome = runInit(later(options, 1));
    expect(outcome.action).toBe("updated");
    expect(outcome.backupPath).not.toBeNull();
    expect(outcome.wrappedCommand).toBe("~/bin/status.sh");
    const written = JSON.parse(readFileSync(path, "utf8")) as { statusLine: { command: string } };
    expect(slash(written.statusLine.command)).toContain(slash(join(dataDir, INSTALLED_HOOK_FILE)));
  });

  it("refreshes the installed hook when the package's hook changed (D-056)", () => {
    // Pulling a new version leaves the settings command right but the installed copy old.
    const options = freshOptions();
    writeSettingsText(options, FOREIGN_SETTINGS);
    expect(runInit(options).hookRefreshed).toBe(true);
    expect(runInit(later(options, 1)).hookRefreshed).toBe(false);
    const hookPath = join(resolveTargets(options).dataDir, INSTALLED_HOOK_FILE);
    writeFileSync(hookPath, "# an older version\n");
    const outcome = runInit(later(options, 2));
    expect(outcome).toMatchObject({ action: "already-installed", hookRefreshed: true });
    expect(readFileSync(hookPath, "utf8")).toBe(
      readFileSync(join(PACKAGE_ROOT, "hooks", "statusline.sh"), "utf8"),
    );
  });

  it("refuses to update when the hook was installed with a different data directory", () => {
    const options = freshOptions();
    const path = writeSettingsText(options, FOREIGN_SETTINGS);
    runInit(options);
    const before = readFileSync(path, "utf8");
    const other = runInit({ ...options, dataDirOverride: join(options.home, "other-data") });
    expect(other.action).toBe("refused-other-install");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("refuses a statusLine that isn't a command, changing nothing", () => {
    const options = freshOptions();
    const text = '{ "statusLine": { "type": "static", "text": "hi" } }';
    const path = writeSettingsText(options, text);
    expect(runInit(options).action).toBe("refused-unsupported");
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readdirSync(dirname(path))).toEqual(["settings.json"]);
  });

  it("throws a SettingsError for invalid JSON and leaves the file and data dir untouched", () => {
    const options = freshOptions();
    const path = writeSettingsText(options, "{ not json");
    expect(() => runInit(options)).toThrow(SettingsError);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
    expect(existsSync(resolveTargets(options).dataDir)).toBe(false);
  });
});

describe("runUninstall", () => {
  it.each([
    ["a custom statusLine", FOREIGN_SETTINGS],
    ["settings without a statusLine", '{\n\t"theme": "dark"\n}'],
  ])("init, init, uninstall leaves %s byte-identical", (_name, text) => {
    const options = freshOptions();
    const path = writeSettingsText(options, text);
    runInit(options);
    runInit(later(options, 1));
    const outcome = runUninstall(later(options, 2));
    expect(outcome).toMatchObject({ action: "restored", exactBytes: true, recordMissing: false });
    expect(readFileSync(path, "utf8")).toBe(text);
    const { dataDir } = resolveTargets(options);
    expect(existsSync(join(dataDir, RECORD_FILE))).toBe(false);
    expect(existsSync(join(dataDir, WRAPPED_COMMAND_FILE))).toBe(false);
  });

  it("restores the user's command when uninstall is run without the install's --data-dir (D-050)", () => {
    // `init --data-dir X` then a plain `uninstall`: the record isn't in the default directory, and
    // deleting the statusLine entry instead of restoring it would lose the user's own command.
    const options = freshOptions();
    const path = writeSettingsText(options, FOREIGN_SETTINGS);
    const dataDir = join(mkdtempSync(join(tmpdir(), "aua-install-elsewhere-")), "data");
    runInit({ ...options, dataDirOverride: dataDir });
    const outcome = runUninstall(later(options, 1));
    expect(outcome).toMatchObject({
      action: "restored",
      exactBytes: true,
      recordMissing: false,
      // The report names where the data actually is, not the default it was asked about.
      dataDir,
      restoredCommand: "~/bin/status.sh",
    });
    expect(readFileSync(path, "utf8")).toBe(FOREIGN_SETTINGS);
    expect(existsSync(join(dataDir, RECORD_FILE))).toBe(false);
  });

  it("removes a settings file that init created when nothing else was added", () => {
    const options = freshOptions();
    runInit(options);
    const outcome = runUninstall(later(options, 1));
    expect(outcome.action).toBe("removed-settings-file");
    expect(existsSync(resolveTargets(options).settingsPath)).toBe(false);
  });

  it("keeps the rest of a file that init created when the user added settings", () => {
    const options = freshOptions();
    runInit(options);
    const { settingsPath } = resolveTargets(options);
    const withUserSetting = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(settingsPath, JSON.stringify({ theme: "light", ...withUserSetting }, null, 2));
    const outcome = runUninstall(later(options, 1));
    expect(outcome).toMatchObject({ action: "restored", exactBytes: false });
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ theme: "light" });
  });

  it("restores the original but keeps later user edits when the file changed after install", () => {
    const options = freshOptions();
    const path = writeSettingsText(options, FOREIGN_SETTINGS);
    runInit(options);
    const edited = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...edited, theme: "light" }, null, 4));
    const outcome = runUninstall(later(options, 1));
    expect(outcome).toMatchObject({ action: "restored", exactBytes: false });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      model: "opus",
      statusLine: { type: "command", command: "~/bin/status.sh", padding: 1 },
      theme: "light",
    });
  });

  it("falls back to re-serializing when the pre-install backup is gone", () => {
    const options = freshOptions();
    const path = writeSettingsText(options, FOREIGN_SETTINGS);
    const installed = runInit(options);
    rmSync(installed.backupPath!);
    const outcome = runUninstall(later(options, 1));
    expect(outcome).toMatchObject({ action: "restored", exactBytes: false });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(FOREIGN_SETTINGS));
  });

  it("leaves a statusLine the user replaced after install alone", () => {
    const options = freshOptions();
    const path = writeSettingsText(options, FOREIGN_SETTINGS);
    runInit(options);
    const replaced = '{ "statusLine": { "type": "command", "command": "my-new-status" } }';
    writeFileSync(path, replaced);
    expect(runUninstall(later(options, 1)).action).toBe("replaced-by-user");
    expect(readFileSync(path, "utf8")).toBe(replaced);
  });

  it("reports not-installed when there is no settings file", () => {
    const outcome = runUninstall(freshOptions());
    expect(outcome).toMatchObject({
      action: "not-installed",
      recordMissing: true,
      backupPath: null,
    });
  });

  it("reports not-installed for settings without our hook", () => {
    const options = freshOptions();
    writeSettingsText(options, '{ "theme": "dark" }');
    expect(runUninstall(options).action).toBe("not-installed");
  });

  it("removes our entry and flags the missing record when the record was deleted", () => {
    const options = freshOptions();
    const path = writeSettingsText(options, FOREIGN_SETTINGS);
    runInit(options);
    rmSync(join(resolveTargets(options).dataDir, RECORD_FILE));
    const outcome = runUninstall(later(options, 1));
    expect(outcome).toMatchObject({ action: "restored", recordMissing: true, exactBytes: false });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "opus", theme: "dark" });
  });

  it("uses the settings path from the install record, not today's flags", () => {
    const options = freshOptions();
    const customPath = join(options.home, "custom", "settings.json");
    mkdirSync(dirname(customPath));
    writeFileSync(customPath, FOREIGN_SETTINGS);
    runInit({ ...options, settingsOverride: customPath });
    const outcome = runUninstall(later(options, 1));
    expect(outcome.settingsPath).toBe(customPath);
    expect(readFileSync(customPath, "utf8")).toBe(FOREIGN_SETTINGS);
  });
});
