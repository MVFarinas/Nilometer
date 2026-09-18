/**
 * @file Unit tests for core/install/private-files.ts (D-043).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAN_SYMLINK, HAS_POSIX_MODES } from "../../../setup/platform.js";

import {
  DATA_DIR_FILES,
  deleteDataFiles,
  describeTightened,
  ensurePrivateDir,
  ensurePrivateFile,
  hasPosixModes,
  securePrivateDataDir,
  tightenMode,
} from "../../../../core/install/private-files.js";

/**
 * Creates a fresh directory for one test.
 * @returns Its path.
 */
function fresh(): string {
  return mkdtempSync(join(tmpdir(), "aua-private-"));
}

/**
 * Reads a path's permission bits.
 * @param path - File or directory.
 * @returns The mode's low 9 bits.
 */
function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("tightenMode", () => {
  it.skipIf(!HAS_POSIX_MODES)("removes group and other bits, keeping the owner's", () => {
    const dir = fresh();
    const file = join(dir, "f");
    writeFileSync(file, "x");
    chmodSync(file, 0o644);
    expect(tightenMode(file)).toBe(true);
    expect(mode(file)).toBe(0o600);
    chmodSync(file, 0o755);
    expect(tightenMode(file)).toBe(true);
    expect(mode(file)).toBe(0o700);
    chmodSync(dir, 0o755);
    expect(tightenMode(dir)).toBe(true);
    expect(mode(dir)).toBe(0o700);
  });

  it.skipIf(!HAS_POSIX_MODES || !CAN_SYMLINK)(
    "never loosens, and skips missing paths and symbolic links",
    () => {
      const dir = fresh();
      const file = join(dir, "f");
      writeFileSync(file, "x");
      chmodSync(file, 0o400);
      expect(tightenMode(file)).toBe(false);
      expect(mode(file)).toBe(0o400);
      expect(tightenMode(join(dir, "missing"))).toBe(false);
      const target = join(fresh(), "not-ours");
      writeFileSync(target, "x");
      chmodSync(target, 0o644);
      symlinkSync(target, join(dir, "link"));
      expect(tightenMode(join(dir, "link"))).toBe(false);
      // chmod through the link would have changed a file Nilometer doesn't own.
      expect(mode(target)).toBe(0o644);
    },
  );
});

describe("ensurePrivateDir and ensurePrivateFile", () => {
  it.skipIf(!HAS_POSIX_MODES)(
    "create owner-only paths, including nested directories, and report creation",
    () => {
      const base = fresh();
      const dir = join(base, "a", "b");
      expect(ensurePrivateDir(dir)).toBe(true);
      expect(mode(dir)).toBe(0o700);
      expect(ensurePrivateDir(dir)).toBe(false);
      const file = join(dir, "usage.db");
      expect(ensurePrivateFile(file)).toBe(true);
      expect(mode(file)).toBe(0o600);
      expect(ensurePrivateFile(file)).toBe(false);
    },
  );

  it.skipIf(!HAS_POSIX_MODES)("reports an unexpected creation failure", () => {
    const dir = fresh();
    chmodSync(dir, 0o500);
    try {
      expect(() => ensurePrivateFile(join(dir, "usage.db"))).toThrow(/EACCES/);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe("securePrivateDataDir", () => {
  it.skipIf(!HAS_POSIX_MODES)(
    "creates a missing data directory owner-only with nothing to report",
    () => {
      const dataDir = join(fresh(), "nilometer");
      expect(securePrivateDataDir(dataDir)).toEqual([]);
      expect(mode(dataDir)).toBe(0o700);
    },
  );

  it.skipIf(!HAS_POSIX_MODES)(
    "tightens an existing install: the directory, every known file, and saved reports",
    () => {
      const dataDir = join(fresh(), "nilometer");
      mkdirSync(join(dataDir, "reports"), { recursive: true });
      chmodSync(dataDir, 0o755);
      chmodSync(join(dataDir, "reports"), 0o755);
      for (const name of ["usage.db", "statusline.spool.jsonl", "install-record.json"]) {
        writeFileSync(join(dataDir, name), "x");
        chmodSync(join(dataDir, name), 0o644);
      }
      writeFileSync(join(dataDir, "reports", "report_2026-09-13_120000.txt"), "x");
      chmodSync(join(dataDir, "reports", "report_2026-09-13_120000.txt"), 0o644);
      expect(securePrivateDataDir(dataDir)).toEqual([
        dataDir,
        join(dataDir, "usage.db"),
        join(dataDir, "statusline.spool.jsonl"),
        join(dataDir, "install-record.json"),
        join(dataDir, "reports"),
        join(dataDir, "reports", "report_2026-09-13_120000.txt"),
      ]);
      expect(mode(dataDir)).toBe(0o700);
      for (const name of DATA_DIR_FILES.filter((n) => existsSync(join(dataDir, n)))) {
        expect(mode(join(dataDir, name))).toBe(0o600);
      }
      // Already private: nothing to report the second time.
      expect(securePrivateDataDir(dataDir)).toEqual([]);
    },
  );

  it.skipIf(!HAS_POSIX_MODES)(
    "leaves a shared folder's own permissions alone when it holds no Nilometer file",
    () => {
      const shared = fresh();
      chmodSync(shared, 0o755);
      writeFileSync(join(shared, "someone-elses.txt"), "x");
      chmodSync(join(shared, "someone-elses.txt"), 0o644);
      expect(securePrivateDataDir(shared)).toEqual([]);
      expect(mode(shared)).toBe(0o755);
      expect(mode(join(shared, "someone-elses.txt"))).toBe(0o644);
    },
  );

  it.skipIf(!HAS_POSIX_MODES || !CAN_SYMLINK)("doesn't follow a symlinked reports folder", () => {
    const dataDir = join(fresh(), "nilometer");
    mkdirSync(dataDir, { mode: 0o700 });
    const elsewhere = fresh();
    chmodSync(elsewhere, 0o755);
    symlinkSync(elsewhere, join(dataDir, "reports"));
    expect(securePrivateDataDir(dataDir)).toEqual([]);
    expect(mode(elsewhere)).toBe(0o755);
  });
});

describe("describeTightened", () => {
  it("says nothing when nothing changed, and counts paths otherwise", () => {
    expect(describeTightened([])).toBeNull();
    expect(describeTightened(["/d"])).toBe(
      "Made Nilometer's data owner-only: 1 path was readable by other accounts on this computer.",
    );
  });
});

describe("on a platform without POSIX modes (D-049)", () => {
  it("never tightens or reports a change, and still creates what's missing", () => {
    // Runs everywhere by passing the platform: Windows ignores modes, so claiming to tighten would be false.
    expect([hasPosixModes("win32"), hasPosixModes("darwin"), hasPosixModes("linux")]).toEqual([
      false,
      true,
      true,
    ]);
    const dir = fresh();
    const file = join(dir, "usage.db");
    writeFileSync(file, "x");
    chmodSync(file, 0o644);
    const before = mode(file);
    expect(tightenMode(file, "win32")).toBe(false);
    expect(securePrivateDataDir(dir, "win32")).toEqual([]);
    expect(mode(file)).toBe(before);
    const created = join(fresh(), "new", "nilometer");
    expect(securePrivateDataDir(created, "win32")).toEqual([]);
    expect(existsSync(created)).toBe(true);
    expect(ensurePrivateDir(join(created, "reports"), "win32")).toBe(true);
    expect(ensurePrivateFile(join(created, "usage.db"), "win32")).toBe(true);
    expect(existsSync(join(created, "usage.db"))).toBe(true);
  });
});

describe("deleteDataFiles", () => {
  it("removes only what Nilometer wrote, and the directory when nothing else is left (R2.5)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aua-delete-"));
    for (const name of ["usage.db", "usage.db-wal", "statusline.spool.jsonl", "statusline.sh"]) {
      writeFileSync(join(dir, name), "x");
    }
    mkdirSync(join(dir, "reports"));
    writeFileSync(join(dir, "reports", "2026-09-18.txt"), "a saved report");
    const result = deleteDataFiles(dir);
    expect(result.removed.sort()).toEqual([
      "reports",
      "statusline.sh",
      "statusline.spool.jsonl",
      "usage.db",
      "usage.db-wal",
    ]);
    expect(result.kept).toEqual([]);
    expect(result.directoryRemoved).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves a file Nilometer didn't write, and the directory holding it", () => {
    // A user can point --data-dir at a folder that holds other things; deleting a directory for
    // its name would take those too (D-043 leaves shared folders alone).
    const dir = mkdtempSync(join(tmpdir(), "aua-delete-shared-"));
    writeFileSync(join(dir, "usage.db"), "x");
    writeFileSync(join(dir, "notes.txt"), "mine");
    const result = deleteDataFiles(dir);
    expect(result.removed).toEqual(["usage.db"]);
    expect(result.kept).toEqual(["notes.txt"]);
    expect(result.directoryRemoved).toBe(false);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  it("reports nothing removed for a directory that isn't there", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "aua-delete-none-")), "gone");
    expect(deleteDataFiles(missing)).toEqual({ removed: [], directoryRemoved: false, kept: [] });
  });
});
