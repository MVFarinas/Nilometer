/**
 * @file Unit tests for core/settings/statusline.ts.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SH } from "../../../setup/platform.js";

import {
  HOOK_MARKER,
  type StatusLineEntry,
  buildHookCommand,
  classifyStatusLine,
  dataDirFromHookCommand,
  isCommandEntry,
  planInstall,
  planUninstall,
  shellQuote,
  withStatusLine,
} from "../../../../core/settings/statusline.js";

/** The hook command used across tests. */
const HOOK_COMMAND = buildHookCommand("/opt/aua/hooks/statusline.sh", "/home/example/data");

/** A user's own status line entry, with an extra field that must survive. */
const FOREIGN: StatusLineEntry = { type: "command", command: "~/bin/my-status.sh", padding: 1 };

describe("shellQuote", () => {
  it.each([
    ["a plain path", "/usr/bin/x"],
    ["spaces", "/Applications/My App/x"],
    ["single quotes", "it's a 'quoted' path"],
    ["shell metacharacters", '$HOME; rm -rf / `x` "y"'],
    ["an empty string", ""],
  ])("round-trips %s through /bin/sh unchanged", (_name, value) => {
    const result = spawnSync(SH, ["-c", `printf '%s' ${shellQuote(value)}`], {
      encoding: "utf8",
    });
    expect(result.stdout).toBe(value);
  });
});

describe("buildHookCommand", () => {
  it("runs the hook under /bin/sh with both paths quoted and ends with the marker", () => {
    expect(HOOK_COMMAND).toBe(
      `/bin/sh '/opt/aua/hooks/statusline.sh' '/home/example/data' ${HOOK_MARKER}`,
    );
  });

  it("refuses relative paths, which the hook would resolve against the wrong folder (D-050)", () => {
    expect(() => buildHookCommand("hooks/statusline.sh", "/home/example/data")).toThrow(
      "absolute paths",
    );
    expect(() => buildHookCommand("/opt/aua/hooks/statusline.sh", "mydata")).toThrow(
      "absolute paths",
    );
  });

  it("produces a command that passes awkward paths to the script intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "aua it's here "));
    const script = join(dir, "print-args.sh");
    writeFileSync(script, 'printf "%s|" "$@"\n');
    const dataDir = join(dir, "data $dir 'x'");
    const result = spawnSync(SH, ["-c", buildHookCommand(script, dataDir)], {
      encoding: "utf8",
    });
    expect(result.stdout).toBe(`${dataDir}|`);
  });
});

describe("dataDirFromHookCommand", () => {
  it("reads back what buildHookCommand wrote, however the path is spelled (D-050)", () => {
    // uninstall depends on this to find the install record when it isn't given --data-dir.
    for (const dir of ["/data", "/a b/it's here", "/x'y", "/tmp/dir with  spaces"]) {
      expect(dataDirFromHookCommand(buildHookCommand("/repo/hooks/statusline.sh", dir))).toBe(dir);
    }
  });

  it("returns null for a command that isn't ours or can't be parsed", () => {
    expect(dataDirFromHookCommand("~/bin/status.sh")).toBeNull();
    // Our marker, but not the shape init writes.
    expect(dataDirFromHookCommand(`my-script ${HOOK_MARKER}`)).toBeNull();
    expect(dataDirFromHookCommand(`/bin/sh '/only/one/word' ${HOOK_MARKER}`)).toBeNull();
  });
});

describe("isCommandEntry", () => {
  it.each([
    ["a command entry", { type: "command", command: "x" }, true],
    ["a command entry with extra fields", { type: "command", command: "x", padding: 0 }, true],
    ["a missing command", { type: "command" }, false],
    ["a non-string command", { type: "command", command: 42 }, false],
    ["another type", { type: "static", command: "x" }, false],
    ["an array", ["command"], false],
    ["null", null, false],
    ["a string", "command", false],
  ])("returns the right answer for %s", (_name, value, expected) => {
    expect(isCommandEntry(value)).toBe(expected);
  });
});

describe("classifyStatusLine", () => {
  it("treats a missing settings file as absent", () => {
    expect(classifyStatusLine(null, HOOK_COMMAND)).toEqual({ kind: "absent" });
  });

  it("treats settings without a statusLine key as absent", () => {
    expect(classifyStatusLine({ theme: "dark" }, HOOK_COMMAND)).toEqual({ kind: "absent" });
  });

  it("treats someone else's command as foreign", () => {
    expect(classifyStatusLine({ statusLine: FOREIGN }, HOOK_COMMAND)).toEqual({
      kind: "foreign",
      entry: FOREIGN,
    });
  });

  it("recognizes our exact command as ours", () => {
    const entry = { type: "command", command: HOOK_COMMAND };
    expect(classifyStatusLine({ statusLine: entry }, HOOK_COMMAND)).toEqual({
      kind: "ours",
      entry,
    });
  });

  it("recognizes our marker with a different path as ours-outdated", () => {
    const entry = { type: "command", command: buildHookCommand("/old/place.sh", "/old/data") };
    expect(classifyStatusLine({ statusLine: entry }, HOOK_COMMAND)).toEqual({
      kind: "ours-outdated",
      entry,
    });
  });

  it.each([
    ["an explicit null", null],
    ["a non-command type", { type: "static", text: "hi" }],
    ["a bare string", "echo hi"],
  ])("treats %s as unsupported", (_name, value) => {
    expect(classifyStatusLine({ statusLine: value }, HOOK_COMMAND)).toEqual({
      kind: "unsupported",
      value,
    });
  });
});

describe("withStatusLine", () => {
  it("replaces an existing statusLine in place, keeping key order", () => {
    const original = { a: 1, statusLine: FOREIGN, z: 2 };
    const entry = { type: "command", command: "new" };
    const result = withStatusLine(original, entry);
    expect(Object.keys(result)).toEqual(["a", "statusLine", "z"]);
    expect(result["statusLine"]).toEqual(entry);
  });

  it("appends statusLine last when it was absent", () => {
    const result = withStatusLine({ a: 1, b: 2 }, { type: "command", command: "new" });
    expect(Object.keys(result)).toEqual(["a", "b", "statusLine"]);
  });

  it("removes the key when given undefined", () => {
    expect(withStatusLine({ a: 1, statusLine: FOREIGN, z: 2 }, undefined)).toEqual({ a: 1, z: 2 });
  });

  it("does nothing when removing a key that isn't there", () => {
    expect(withStatusLine({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it("never mutates the original settings", () => {
    const original = { statusLine: FOREIGN };
    withStatusLine(original, undefined);
    expect(original).toEqual({ statusLine: FOREIGN });
  });
});

describe("planInstall", () => {
  it("installs into a missing settings file with nothing to record", () => {
    expect(planInstall(null, HOOK_COMMAND)).toEqual({
      action: "install",
      settings: { statusLine: { type: "command", command: HOOK_COMMAND } },
      original: null,
    });
  });

  it("installs alongside existing settings without a statusLine", () => {
    const plan = planInstall({ theme: "dark" }, HOOK_COMMAND);
    expect(plan).toEqual({
      action: "install",
      settings: { theme: "dark", statusLine: { type: "command", command: HOOK_COMMAND } },
      original: null,
    });
  });

  it("wraps a foreign entry, keeping its other fields and recording the original", () => {
    const plan = planInstall({ statusLine: FOREIGN, model: "x" }, HOOK_COMMAND);
    expect(plan).toEqual({
      action: "install",
      settings: {
        statusLine: { type: "command", command: HOOK_COMMAND, padding: 1 },
        model: "x",
      },
      original: FOREIGN,
    });
  });

  it("does nothing when our hook is already installed", () => {
    const settings = { statusLine: { type: "command", command: HOOK_COMMAND } };
    expect(planInstall(settings, HOOK_COMMAND)).toEqual({
      action: "none",
      reason: "already-installed",
    });
  });

  it("updates only the command when our entry points at an old location", () => {
    const old = { type: "command", command: buildHookCommand("/old.sh", "/old"), padding: 2 };
    expect(planInstall({ statusLine: old }, HOOK_COMMAND)).toEqual({
      action: "update-command",
      settings: { statusLine: { type: "command", command: HOOK_COMMAND, padding: 2 } },
    });
  });

  it("refuses to touch an entry that isn't a command", () => {
    const value = { type: "static", text: "hi" };
    expect(planInstall({ statusLine: value }, HOOK_COMMAND)).toEqual({
      action: "refuse",
      reason: "unsupported-statusline",
      value,
    });
  });
});

describe("planUninstall", () => {
  const ours = { type: "command", command: HOOK_COMMAND, padding: 1 };

  it("does nothing when there is no settings file", () => {
    expect(planUninstall(null, FOREIGN)).toEqual({ action: "none", reason: "not-installed" });
  });

  it("does nothing when there is no statusLine", () => {
    expect(planUninstall({ a: 1 }, null)).toEqual({ action: "none", reason: "not-installed" });
  });

  it.each([
    ["a foreign command", FOREIGN],
    ["a non-command value", "echo hi"],
  ])("leaves %s alone because the user replaced our entry", (_name, value) => {
    expect(planUninstall({ statusLine: value }, FOREIGN)).toEqual({
      action: "none",
      reason: "replaced-by-user",
    });
  });

  it("restores the recorded original entry in place", () => {
    expect(planUninstall({ a: 1, statusLine: ours, z: 2 }, FOREIGN)).toEqual({
      action: "restore",
      settings: { a: 1, statusLine: FOREIGN, z: 2 },
    });
  });

  it("removes our entry when there was no original", () => {
    expect(planUninstall({ a: 1, statusLine: ours }, null)).toEqual({
      action: "restore",
      settings: { a: 1 },
    });
  });
});
