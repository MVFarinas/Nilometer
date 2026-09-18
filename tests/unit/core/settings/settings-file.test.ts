/**
 * @file Unit tests for core/settings/settings-file.ts.
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HAS_POSIX_MODES, slash } from "../../../setup/platform.js";

import {
  type AtomicFs,
  NODE_ATOMIC_FS,
  SettingsError,
  backupSettings,
  backupStamp,
  detectFormat,
  locateSettings,
  readSettings,
  serializeSettings,
  writeFileAtomic,
} from "../../../../core/settings/settings-file.js";

/** Fixed home directory so results never depend on the machine running the tests. */
const HOME = "/home/example";

/**
 * Creates a fresh temporary directory for one test.
 * @returns Absolute path of the directory.
 */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "aua-settings-test-"));
}

/**
 * Writes a settings file with the given text into a fresh directory.
 * @param text - Exact file contents.
 * @returns Path of the written file.
 */
function settingsFile(text: string): string {
  const path = join(freshDir(), "settings.json");
  writeFileSync(path, text);
  return path;
}

describe("locateSettings", () => {
  it("defaults to ~/.claude/settings.json", () => {
    expect(slash(locateSettings({ home: HOME }))).toBe("/home/example/.claude/settings.json");
  });

  it("uses CLAUDE_CONFIG_DIR when set, expanding a leading tilde", () => {
    expect(slash(locateSettings({ home: HOME, claudeConfigDir: "~/alt-claude" }))).toBe(
      "/home/example/alt-claude/settings.json",
    );
  });

  it("lets an explicit override win over CLAUDE_CONFIG_DIR", () => {
    expect(
      slash(
        locateSettings({ home: HOME, override: "~/custom.json", claudeConfigDir: "/etc/claude" }),
      ),
    ).toBe("/home/example/custom.json");
  });

  it("ignores empty strings for both override and CLAUDE_CONFIG_DIR", () => {
    expect(slash(locateSettings({ home: HOME, override: "", claudeConfigDir: "" }))).toBe(
      "/home/example/.claude/settings.json",
    );
  });
});

describe("detectFormat", () => {
  it.each([
    ["two spaces", '{\n  "a": 1\n}\n', 2, true],
    ["four spaces", '{\n    "a": 1\n}', 4, false],
    ["tabs", '{\n\t"a": 1\n}\n', "\t", true],
  ])("detects %s", (_name, raw, indent, trailingNewline) => {
    expect(detectFormat(raw)).toEqual({ indent, trailingNewline });
  });

  it("falls back to two spaces when nothing is indented", () => {
    expect(detectFormat("{}")).toEqual({ indent: 2, trailingNewline: false });
  });
});

describe("readSettings", () => {
  it("reports a missing file without creating it", () => {
    const path = join(freshDir(), "settings.json");
    expect(readSettings(path)).toEqual({ kind: "missing", path });
    expect(existsSync(path)).toBe(false);
  });

  it("parses a valid file, keeping key order, raw text, and format", () => {
    const raw = '{\n    "z": 1,\n    "a": { "b": true }\n}\n';
    const result = readSettings(settingsFile(raw));
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(Object.keys(result.settings)).toEqual(["z", "a"]);
    expect(result.raw).toBe(raw);
    expect(result.format).toEqual({ indent: 4, trailingNewline: true });
  });

  it.each([
    ["an empty file", "", "empty"],
    ["a whitespace-only file", " \n\t\n", "empty"],
    ["invalid JSON", '{ "a": 1,, }', "invalid-json"],
    ["a JSON array", "[1, 2]", "not-an-object"],
    ["JSON null", "null", "not-an-object"],
    ["a JSON string", '"text"', "not-an-object"],
  ])("refuses %s with a SettingsError and leaves the file untouched", (_name, raw, code) => {
    const path = settingsFile(raw);
    let caught: unknown;
    try {
      readSettings(path);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SettingsError);
    expect((caught as SettingsError).code).toBe(code);
    expect((caught as SettingsError).path).toBe(path);
    expect((caught as SettingsError).name).toBe("SettingsError");
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("includes the parser's reason in an invalid-JSON message", () => {
    expect(() => readSettings(settingsFile("{"))).toThrow(/is not valid JSON: /);
  });
});

describe("backupStamp", () => {
  it("formats the time in UTC as YYYYMMDD-HHMMSS", () => {
    expect(backupStamp(new Date("2026-03-04T05:06:07.890Z"))).toBe("20260304-050607");
  });
});

describe("backupSettings", () => {
  const now = new Date("2026-09-13T01:02:03Z");

  it("returns null when there is no file to back up", () => {
    expect(backupSettings(join(freshDir(), "settings.json"), now)).toBeNull();
  });

  it("creates a byte-identical copy with a timestamped name", () => {
    const path = settingsFile('{"a": 1}');
    const backup = backupSettings(path, now);
    expect(backup).toBe(`${path}.bak-20260913-010203`);
    expect(readFileSync(backup!, "utf8")).toBe('{"a": 1}');
  });

  it.skipIf(!HAS_POSIX_MODES)(
    "makes every backup owner-only, even of a readable settings file (D-043)",
    () => {
      const path = settingsFile('{"env": {"TOKEN": "x"}}');
      chmodSync(path, 0o644);
      const backup = backupSettings(path, now);
      expect(statSync(backup!).mode & 0o777).toBe(0o600);
    },
  );

  it("never overwrites an existing backup from the same second", () => {
    const path = settingsFile("{}");
    const first = backupSettings(path, now);
    writeFileSync(path, '{"changed": true}');
    const second = backupSettings(path, now);
    const third = backupSettings(path, now);
    expect([first, second, third]).toEqual([
      `${path}.bak-20260913-010203`,
      `${path}.bak-20260913-010203-1`,
      `${path}.bak-20260913-010203-2`,
    ]);
    expect(readFileSync(first!, "utf8")).toBe("{}");
  });
});

describe("serializeSettings", () => {
  const settings = { b: 1, a: [true] };

  it("uses the requested indent and adds a trailing newline", () => {
    expect(serializeSettings(settings, { indent: 4, trailingNewline: true })).toBe(
      '{\n    "b": 1,\n    "a": [\n        true\n    ]\n}\n',
    );
  });

  it("uses tabs and omits the trailing newline when asked", () => {
    expect(serializeSettings({ b: 1 }, { indent: "\t", trailingNewline: false })).toBe(
      '{\n\t"b": 1\n}',
    );
  });
});

describe("writeFileAtomic", () => {
  it("writes the complete contents and leaves no temp file", () => {
    const dir = freshDir();
    const path = join(dir, "settings.json");
    writeFileSync(path, "old");
    writeFileAtomic(path, "new contents");
    expect(readFileSync(path, "utf8")).toBe("new contents");
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  it.skipIf(!HAS_POSIX_MODES)("keeps restrictive permissions of the original file", () => {
    const path = settingsFile("{}");
    chmodSync(path, 0o600);
    writeFileAtomic(path, '{"a": 1}');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!HAS_POSIX_MODES)(
    "creates a new file owner-only, since settings can hold secrets (D-043)",
    () => {
      const path = join(freshDir(), "settings.json");
      writeFileAtomic(path, "{}");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(!HAS_POSIX_MODES)("keeps a user's existing 0644 settings file at 0644", () => {
    const path = settingsFile("{}");
    chmodSync(path, 0o644);
    writeFileAtomic(path, '{"a": 1}');
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it("leaves the original intact and removes the temp file when the rename fails", () => {
    const dir = freshDir();
    const path = join(dir, "settings.json");
    writeFileSync(path, "original");
    /** The real filesystem, except the rename step crashes. */
    const crashingFs: AtomicFs = {
      ...NODE_ATOMIC_FS,
      renameSync: () => {
        throw new Error("simulated crash before rename");
      },
    };
    expect(() => writeFileAtomic(path, "replacement", crashingFs)).toThrow(
      "simulated crash before rename",
    );
    expect(readFileSync(path, "utf8")).toBe("original");
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  it("removes a partly written temp file when writing fails", () => {
    const dir = freshDir();
    const path = join(dir, "settings.json");
    writeFileSync(path, "original");
    /** The real filesystem, except the write leaves a partial file and then fails. */
    const failingFs: AtomicFs = {
      ...NODE_ATOMIC_FS,
      writeFileSync: (tempPath) => {
        writeFileSync(tempPath, "partial");
        throw new Error("disk full");
      },
    };
    expect(() => writeFileAtomic(path, "replacement", failingFs)).toThrow("disk full");
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    expect(readFileSync(path, "utf8")).toBe("original");
  });
});
