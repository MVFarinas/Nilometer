/**
 * @file Tests for core/ingest/command.ts (docs/development.md P4.8), on temporary homes with fixture logs.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SH } from "../../../setup/platform.js";

import {
  DATABASE_FILE,
  HOOK_ERRORS_FILE,
  countHookErrors,
  runIngestCommand,
} from "../../../../core/ingest/command.js";
import { DiscoveryError } from "../../../../core/ingest/discover.js";

/** This repository's root. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * A fixed clock.
 * @returns 2026-09-13T00:00:00Z.
 */
function now(): Date {
  return new Date("2026-09-13T00:00:00Z");
}

/**
 * Creates a home directory whose ~/.claude/projects holds the given fixture cases' logs.
 * @param caseIds - Single-state fixture cases to copy in.
 * @returns The home directory.
 */
function homeWith(...caseIds: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "aua-command-"));
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  for (const caseId of caseIds) {
    cpSync(join(ROOT, "fixtures", caseId, "projects"), join(home, ".claude", "projects"), {
      recursive: true,
    });
  }
  return home;
}

describe("countHookErrors", () => {
  it("counts non-empty lines and returns 0 without a log", () => {
    const dir = mkdtempSync(join(tmpdir(), "aua-hookerr-"));
    expect(countHookErrors(dir)).toBe(0);
    writeFileSync(join(dir, HOOK_ERRORS_FILE), "1 append-failed\n\n2 append-failed\n");
    expect(countHookErrors(dir)).toBe(2);
  });
});

describe("runIngestCommand", () => {
  it("creates the database in the data directory and summarizes stored data", () => {
    const home = homeWith("01-streaming-snapshots", "08-limit-hits", "10-malformed-lines");
    const outcome = runIngestCommand({ home, env: {}, full: false, packageRoot: ROOT, now });
    const dataDir = join(home, ".local", "share", "nilometer");
    expect(outcome.databasePath).toBe(join(dataDir, DATABASE_FILE));
    expect(existsSync(outcome.databasePath)).toBe(true);
    expect(outcome.roots).toEqual([join(home, ".claude")]);
    expect(outcome.run).toMatchObject({ files: 3, linesStored: 16, spoolRead: false });
    expect(outcome.derived).toEqual({ lines: 16, rebuilt: true });
    expect(outcome.repositoriesResolved).toBe(1);
    expect(outcome.totals).toEqual({
      requests: 5,
      unkeyedRequests: 0,
      limitHits: 4,
      otherEvents: 0,
      malformedLines: 2,
      statusReadings: 0,
      malformedReadings: 0,
      invalidWindows: 0,
      hookErrors: 0,
      firstRequestUtc: "2026-09-01T10:00:01.000Z",
      lastRequestUtc: "2026-09-01T10:01:02.000Z",
    });
  });

  it("reports the same totals on a second run, which reads nothing new", () => {
    const home = homeWith("06-mixed-models");
    const first = runIngestCommand({ home, env: {}, full: false, packageRoot: ROOT, now });
    const second = runIngestCommand({ home, env: {}, full: false, packageRoot: ROOT, now });
    expect(second.run).toMatchObject({ linesRead: 0, linesStored: 0 });
    expect(second.derived).toEqual({ lines: 0, rebuilt: false });
    expect(second.totals).toEqual(first.totals);
  });

  it("rereads everything with full, storing nothing new", () => {
    const home = homeWith("05-missing-ids");
    runIngestCommand({ home, env: {}, full: false, packageRoot: ROOT, now });
    const full = runIngestCommand({ home, env: {}, full: true, packageRoot: ROOT, now });
    expect(full.run).toMatchObject({ linesRead: 5, linesStored: 0 });
    expect(full.totals.unkeyedRequests).toBe(2);
  });

  it("reads the spool and counts readings, flagged windows, and hook errors", () => {
    const home = homeWith();
    const dataDir = join(home, "custom-data");
    const hook = join(ROOT, "hooks/statusline.sh");
    const payload = readFileSync(join(ROOT, "tests/fixtures/statusline/payload.json"), "utf8");
    spawnSync(SH, [hook, dataDir], { input: payload });
    spawnSync(SH, [hook, dataDir], {
      input: payload.replace('"used_percentage":42.3', '"used_percentage":101'),
    });
    spawnSync(SH, [hook, dataDir], { input: "not json" });
    writeFileSync(join(dataDir, HOOK_ERRORS_FILE), "1 append-failed\n");
    const outcome = runIngestCommand({
      home,
      env: {},
      dataDirOverride: dataDir,
      full: false,
      packageRoot: ROOT,
      now,
    });
    expect(outcome.run.spoolRead).toBe(true);
    expect(outcome.totals).toMatchObject({
      statusReadings: 2,
      malformedReadings: 1,
      invalidWindows: 1,
      hookErrors: 1,
      requests: 0,
      firstRequestUtc: null,
      lastRequestUtc: null,
    });
  });

  it("uses CLAUDE_CONFIG_DIR and NILOMETER_HOME from the environment", () => {
    const home = mkdtempSync(join(tmpdir(), "aua-command-env-"));
    const config = join(home, "alt");
    cpSync(join(ROOT, "fixtures/04-btw-replay/projects"), join(config, "projects"), {
      recursive: true,
    });
    const outcome = runIngestCommand({
      home,
      env: { CLAUDE_CONFIG_DIR: config, NILOMETER_HOME: join(home, "aua") },
      full: false,
      packageRoot: ROOT,
      now,
    });
    expect(outcome.roots).toEqual([config]);
    expect(outcome.databasePath).toBe(join(home, "aua", DATABASE_FILE));
    expect(outcome.totals.requests).toBe(1);
  });

  it("throws a DiscoveryError for an unusable CLAUDE_CONFIG_DIR, before creating a database", () => {
    const home = mkdtempSync(join(tmpdir(), "aua-command-bad-"));
    expect(() =>
      runIngestCommand({
        home,
        env: { CLAUDE_CONFIG_DIR: join(home, "nope") },
        full: false,
        packageRoot: ROOT,
        now,
      }),
    ).toThrow(DiscoveryError);
    expect(existsSync(join(home, ".local"))).toBe(false);
  });
});
