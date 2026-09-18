/**
 * @file Tests for core/ingest/ingest.ts (docs/development.md P4.3), run on committed fixture log trees.
 *
 * Multi-run fixtures are staged into one temporary root, the way Claude Code changes files in
 * place: either by overwriting a file (same inode) or by replacing it (new inode). Both must give
 * the same stored lines.
 */
import {
  type Dirent,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { type Db, openDatabase } from "../../../../core/db/database.js";
import { fingerprintTables } from "../../../../core/db/fingerprint.js";
import { discoverLogFiles } from "../../../../core/ingest/discover.js";
import {
  ingestLogs,
  normalizeWindowsRelativePaths,
  statFile,
} from "../../../../core/ingest/ingest.js";

/** Repository paths. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SCHEMA = join(ROOT, "core/schema");
const FIXTURES = join(ROOT, "fixtures");

/**
 * Lists files under a directory, recursively.
 * @param dir - Directory to walk.
 * @returns Paths relative to `dir`.
 */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

/**
 * Stages a fixture state's log tree into a root.
 * @param stateDir - Directory containing `projects/` (a case dir or its run-N dir).
 * @param root - Staging root.
 * @param how - `overwrite` keeps existing inodes; `replace` deletes the tree first.
 */
function stage(stateDir: string, root: string, how: "overwrite" | "replace"): void {
  if (how === "replace") {
    rmSync(join(root, "projects"), { recursive: true, force: true });
    cpSync(join(stateDir, "projects"), join(root, "projects"), { recursive: true });
    return;
  }
  for (const file of listFiles(join(stateDir, "projects"))) {
    const target = join(root, "projects", file);
    mkdirSync(dirname(target), { recursive: true });
    // copyFileSync truncates and rewrites an existing destination, keeping its inode.
    copyFileSync(join(stateDir, "projects", file), target);
  }
}

/**
 * A clock that is always the same instant.
 * @returns 2026-09-13T02:00:00Z.
 */
const now = (): Date => new Date("2026-09-13T02:00:00Z");

describe("statFile", () => {
  it("returns size and inode for a real file", () => {
    const stat = statFile(join(FIXTURES, "README.md"));
    expect(stat.size).toBe(statSync(join(FIXTURES, "README.md")).size);
    expect(stat.inode).not.toBeNull();
  });

  it("treats a zero inode as unknown", () => {
    expect(statFile("/x", () => ({ size: 3, ino: 0 }))).toEqual({ size: 3, inode: null });
  });
});

describe("ingestLogs", () => {
  let db: Db;
  let root: string;

  beforeEach(() => {
    db = openDatabase(":memory:", SCHEMA);
    root = mkdtempSync(join(tmpdir(), "aua-ingest-"));
  });

  it("stores every complete line of a single-state case and records the run", () => {
    stage(join(FIXTURES, "01-streaming-snapshots"), root, "replace");
    const summary = ingestLogs(db, { roots: [root], mode: "incremental", now });
    expect(summary).toMatchObject({
      files: 1,
      linesRead: 6,
      linesStored: 6,
      linesAlreadyStored: 0,
      filesRewritten: 0,
    });
    const file = db.prepare("SELECT byte_offset, line_count, size FROM source_files").get() as {
      byte_offset: number;
      line_count: number;
      size: number;
    };
    expect(file.byte_offset).toBe(file.size);
    expect(file.line_count).toBe(6);
    expect(db.prepare("SELECT finished_at FROM ingest_runs").get()).toEqual({
      finished_at: "2026-09-13T02:00:00.000Z",
    });
  });

  it("rewrites paths a Windows database stored with backslashes, so its files aren't read again (D-049)", () => {
    stage(join(FIXTURES, "11-subagent-file"), root, "replace");
    ingestLogs(db, { roots: [root], mode: "incremental", now });
    /**
     * Lists the stored relative paths.
     * @returns One per source file, in insertion order.
     */
    const stored = (): string[] =>
      (
        db.prepare("SELECT relative_path FROM source_files ORDER BY id").all() as {
          relative_path: string;
        }[]
      ).map((row) => row.relative_path);
    const forward = stored();
    expect(forward.every((path) => path.startsWith("projects/") && !path.includes("\\"))).toBe(
      true,
    );
    // Before 2026-09-17, discovery on Windows stored the platform separator.
    db.prepare(
      "UPDATE source_files SET relative_path = replace(relative_path, '/', char(92))",
    ).run();
    const before = fingerprintTables(db, ["raw_lines"]);
    // Elsewhere a backslash can be part of a file name, so nothing is rewritten.
    expect(normalizeWindowsRelativePaths(db, "darwin")).toBe(0);
    expect(normalizeWindowsRelativePaths(db, "linux")).toBe(0);
    expect(
      ingestLogs(db, { roots: [root], mode: "incremental", now, platform: "win32" }),
    ).toMatchObject({
      linesRead: 0,
      linesStored: 0,
    });
    expect(stored()).toEqual(forward);
    expect(fingerprintTables(db, ["raw_lines"])).toEqual(before);
    expect(normalizeWindowsRelativePaths(db, "win32")).toBe(0);
  });

  it("reads nothing new on a second incremental run, leaving raw lines byte-identical", () => {
    stage(join(FIXTURES, "11-subagent-file"), root, "replace");
    ingestLogs(db, { roots: [root], mode: "incremental", now });
    const before = fingerprintTables(db, ["raw_lines"]);
    expect(ingestLogs(db, { roots: [root], mode: "incremental", now })).toMatchObject({
      linesRead: 0,
      linesStored: 0,
    });
    expect(fingerprintTables(db, ["raw_lines"])).toEqual(before);
  });

  it("rereads everything in full mode but stores nothing new", () => {
    stage(join(FIXTURES, "10-malformed-lines"), root, "replace");
    ingestLogs(db, { roots: [root], mode: "incremental", now });
    const before = fingerprintTables(db, ["raw_lines"]);
    expect(ingestLogs(db, { roots: [root], mode: "full", now })).toMatchObject({
      linesRead: 4,
      linesStored: 0,
      linesAlreadyStored: 4,
    });
    expect(fingerprintTables(db, ["raw_lines"])).toEqual(before);
  });

  it.each(["overwrite", "replace"] as const)(
    "resumes a response split across runs (%s staging) without storing lines twice",
    (how) => {
      stage(join(FIXTURES, "02-split-across-runs/run-1"), root, how);
      expect(ingestLogs(db, { roots: [root], mode: "incremental", now }).linesStored).toBe(3);
      stage(join(FIXTURES, "02-split-across-runs/run-2"), root, how);
      expect(ingestLogs(db, { roots: [root], mode: "incremental", now }).linesStored).toBe(1);
      expect(
        db.prepare("SELECT line_number, first_run_id FROM raw_lines ORDER BY line_number").all(),
      ).toEqual([
        { line_number: 1, first_run_id: 1 },
        { line_number: 2, first_run_id: 1 },
        { line_number: 3, first_run_id: 1 },
        { line_number: 4, first_run_id: 2 },
      ]);
    },
  );

  it("leaves a trailing fragment for the next run and numbers the completed line correctly", () => {
    stage(join(FIXTURES, "03-trailing-fragment/run-1"), root, "overwrite");
    expect(ingestLogs(db, { roots: [root], mode: "incremental", now }).linesStored).toBe(2);
    stage(join(FIXTURES, "03-trailing-fragment/run-2"), root, "overwrite");
    const second = ingestLogs(db, { roots: [root], mode: "incremental", now });
    expect(second).toMatchObject({ linesRead: 1, linesStored: 1, filesRewritten: 0 });
    expect(db.prepare("SELECT line_number FROM raw_lines WHERE first_run_id = 2").get()).toEqual({
      line_number: 3,
    });
  });

  it("detects a file rewritten shorter, rereads it, keeps old lines, and reports it", () => {
    stage(join(FIXTURES, "12-rewritten-file/run-1"), root, "overwrite");
    ingestLogs(db, { roots: [root], mode: "incremental", now });
    stage(join(FIXTURES, "12-rewritten-file/run-2"), root, "overwrite");
    const second = ingestLogs(db, { roots: [root], mode: "incremental", now });
    expect(second).toMatchObject({ linesRead: 2, linesStored: 1, filesRewritten: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM raw_lines").get()).toEqual({ n: 4 });
    expect(
      db.prepare("SELECT line_number, first_run_id FROM raw_lines WHERE first_run_id = 2").all(),
    ).toEqual([{ line_number: 2, first_run_id: 2 }]);
    expect(db.prepare("SELECT problem FROM ingest_report").all()).toEqual([
      { problem: "file_rewritten" },
    ]);
  });

  it("stores identical raw lines whatever the chunk size", () => {
    stage(join(FIXTURES, "08-limit-hits"), root, "replace");
    ingestLogs(db, { roots: [root], mode: "incremental", now });
    const other = openDatabase(":memory:", SCHEMA);
    ingestLogs(other, { roots: [root], mode: "incremental", now, chunkSize: 7 });
    expect(fingerprintTables(other, ["raw_lines"])).toEqual(fingerprintTables(db, ["raw_lines"]));
  });

  it("reads every root in order", () => {
    const second = mkdtempSync(join(tmpdir(), "aua-ingest-2-"));
    stage(join(FIXTURES, "01-streaming-snapshots"), root, "replace");
    stage(join(FIXTURES, "06-mixed-models"), second, "replace");
    expect(ingestLogs(db, { roots: [root, second], mode: "incremental", now })).toMatchObject({
      files: 2,
      linesStored: 10,
    });
    expect(db.prepare("SELECT root FROM source_files ORDER BY id").all()).toEqual([
      { root },
      { root: second },
    ]);
  });

  it("skips a file that can't be read, counts it, and finishes the run (D-050)", () => {
    // A session log can vanish between discovery and open: Claude Code deletes them after 30 days.
    stage(join(FIXTURES, "14-worktree-cwd"), root, "replace");
    let calls = 0;
    /**
     * Stats normally for the first file, then reports the file as gone.
     * @param path - File path.
     * @returns The real stat for the first call.
     * @throws {NodeJS.ErrnoException} ENOENT on every call after the first.
     */
    const vanishing = (path: string): ReturnType<typeof statFile> => {
      calls += 1;
      if (calls > 1) {
        const error: NodeJS.ErrnoException = new Error("ENOENT: no such file or directory");
        error.code = "ENOENT";
        throw error;
      }
      return statFile(path);
    };
    const summary = ingestLogs(db, { roots: [root], mode: "incremental", now, stat: vanishing });
    // Fixture 14 has three session logs: the first is read, the other two report as gone.
    expect(summary).toMatchObject({ unreadable: 2, linesStored: 1, files: 1 });
    expect(db.prepare("SELECT finished_at FROM ingest_runs").get()).not.toEqual({
      finished_at: null,
    });
  });

  it("counts a folder it can't list and still reads the rest (D-050)", () => {
    // A project folder can be unreadable (permissions) or deleted mid-walk; one folder shouldn't
    // cost the whole run. Injected rather than chmod'd, so the test runs on Windows too.
    stage(join(FIXTURES, "14-worktree-cwd"), root, "replace");
    const unreadable: string[] = [];
    /**
     * Lists normally, except the fixture's project folder, which can't be read.
     * @param path - Directory path.
     * @returns The real entries for every other directory.
     * @throws {NodeJS.ErrnoException} EACCES for the fixture's project folder.
     */
    const listDir = (path: string): Dirent[] => {
      if (path.endsWith("-fixture-demo")) {
        const error: NodeJS.ErrnoException = new Error("EACCES: permission denied");
        error.code = "EACCES";
        throw error;
      }
      return readdirSync(path, { withFileTypes: true });
    };
    // discoverLogFiles reports the folder it skipped.
    expect(discoverLogFiles(root, listDir, (path) => unreadable.push(path))).toEqual([]);
    expect(unreadable).toHaveLength(1);
    // Without a callback it still skips the folder rather than throwing.
    expect(discoverLogFiles(root, listDir)).toEqual([]);
    // A whole run counts it and finishes: no files read, one folder skipped.
    const summary = ingestLogs(db, { roots: [root], mode: "incremental", now, listDir });
    expect(summary).toMatchObject({ unreadable: 1, files: 0, linesStored: 0 });
    expect(db.prepare("SELECT finished_at FROM ingest_runs").get()).not.toEqual({
      finished_at: null,
    });
  });

  it("keeps files finished before an error and leaves the run unfinished", () => {
    stage(join(FIXTURES, "14-worktree-cwd"), root, "replace");
    let calls = 0;
    /**
     * Stats normally for the first file, then fails.
     * @param path - File path.
     * @returns The real stat for the first call.
     * @throws {Error} An error with no `code` on every call after the first: not a filesystem
     *   error, so ingest treats it as a bug and lets it through (D-050).
     */
    const flakyStat = (path: string): ReturnType<typeof statFile> => {
      calls += 1;
      if (calls > 1) {
        throw new Error("a bug, not a filesystem error");
      }
      return statFile(path);
    };
    expect(() =>
      ingestLogs(db, { roots: [root], mode: "incremental", now, stat: flakyStat }),
    ).toThrow("a bug, not a filesystem error");
    expect(db.prepare("SELECT COUNT(*) AS n FROM raw_lines").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT finished_at FROM ingest_runs").get()).toEqual({ finished_at: null });
  });
});
