/**
 * @file Unit tests for core/install/record.ts.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HAS_POSIX_MODES } from "../../../setup/platform.js";

import {
  type InstallRecord,
  InstallRecordError,
  RECORD_FILE,
  WRAPPED_COMMAND_FILE,
  readInstallRecord,
  removeInstallRecord,
  writeInstallRecord,
} from "../../../../core/install/record.js";

/** A valid record wrapping an original command. */
const RECORD: InstallRecord = {
  version: 1,
  settingsPath: "/home/example/.claude/settings.json",
  settingsExisted: true,
  backupPath: "/home/example/.claude/settings.json.bak-20260913-000000",
  original: { type: "command", command: "~/bin/status.sh --color", padding: 0 },
  installedAt: "2026-09-13T00:00:00.000Z",
};

/**
 * Creates a data directory path that doesn't exist yet.
 * @returns Absolute path inside a fresh temp directory.
 */
function dataDirPath(): string {
  return join(mkdtempSync(join(tmpdir(), "aua-record-test-")), "data");
}

describe("writeInstallRecord and readInstallRecord", () => {
  it.skipIf(!HAS_POSIX_MODES)(
    "creates the data directory and both files owner-only, and tightens older ones (D-043)",
    () => {
      const dataDir = dataDirPath();
      writeInstallRecord(dataDir, RECORD);
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dataDir, "install-record.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dataDir, WRAPPED_COMMAND_FILE)).mode & 0o777).toBe(0o600);
      chmodSync(join(dataDir, "install-record.json"), 0o644);
      writeInstallRecord(dataDir, RECORD);
      expect(statSync(join(dataDir, "install-record.json")).mode & 0o777).toBe(0o600);
    },
  );

  it("round-trips a record and writes the wrapped command as plain text", () => {
    const dataDir = dataDirPath();
    writeInstallRecord(dataDir, RECORD);
    expect(readInstallRecord(dataDir)).toEqual(RECORD);
    expect(readFileSync(join(dataDir, WRAPPED_COMMAND_FILE), "utf8")).toBe(
      "~/bin/status.sh --color",
    );
  });

  it("removes a stale wrapped-command file when there is no original", () => {
    const dataDir = dataDirPath();
    writeInstallRecord(dataDir, RECORD);
    writeInstallRecord(dataDir, { ...RECORD, original: null, backupPath: null });
    expect(existsSync(join(dataDir, WRAPPED_COMMAND_FILE))).toBe(false);
    expect(readInstallRecord(dataDir)?.original).toBeNull();
  });

  it("returns null when no record exists", () => {
    expect(readInstallRecord(dataDirPath())).toBeNull();
  });

  it.each([
    ["invalid JSON", "{", "not valid JSON"],
    ["a JSON array", "[]", "not a JSON object"],
    ["JSON null", "null", "not a JSON object"],
    ["a wrong version", JSON.stringify({ ...RECORD, version: 2 }), "missing or mistyped fields"],
    [
      "a missing settingsPath",
      JSON.stringify({ ...RECORD, settingsPath: undefined }),
      "missing or mistyped fields",
    ],
    [
      "a non-boolean settingsExisted",
      JSON.stringify({ ...RECORD, settingsExisted: "yes" }),
      "missing or mistyped fields",
    ],
    [
      "a numeric backupPath",
      JSON.stringify({ ...RECORD, backupPath: 5 }),
      "missing or mistyped fields",
    ],
    [
      "an original without a command",
      JSON.stringify({ ...RECORD, original: { type: "command" } }),
      "missing or mistyped fields",
    ],
    [
      "a missing installedAt",
      JSON.stringify({ ...RECORD, installedAt: undefined }),
      "missing or mistyped fields",
    ],
  ])("rejects %s with an InstallRecordError", (_name, text, reason) => {
    const dataDir = dataDirPath();
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, RECORD_FILE), text);
    let caught: unknown;
    try {
      readInstallRecord(dataDir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InstallRecordError);
    expect((caught as Error).name).toBe("InstallRecordError");
    expect((caught as Error).message).toContain(reason);
  });
});

describe("removeInstallRecord", () => {
  it("removes the record and wrapped command but keeps other data", () => {
    const dataDir = dataDirPath();
    writeInstallRecord(dataDir, RECORD);
    writeFileSync(join(dataDir, "statusline.spool.jsonl"), "{}\n");
    removeInstallRecord(dataDir);
    expect(existsSync(join(dataDir, RECORD_FILE))).toBe(false);
    expect(existsSync(join(dataDir, WRAPPED_COMMAND_FILE))).toBe(false);
    expect(existsSync(join(dataDir, "statusline.spool.jsonl"))).toBe(true);
  });

  it("does nothing when there is no record", () => {
    const dataDir = dataDirPath();
    expect(() => {
      removeInstallRecord(dataDir);
    }).not.toThrow();
  });
});
