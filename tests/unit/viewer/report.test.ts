/**
 * @file Unit tests for viewer/report.ts (docs/development.md P7.1).
 */
import { chmodSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HAS_POSIX_MODES } from "../../setup/platform.js";

import { runIngestCommand } from "../../../core/ingest/command.js";
import { NoDatabaseError, loadReport, withReportDatabase } from "../../../viewer/report.js";

/** Repository root. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("loadReport", () => {
  it("refuses a data directory without a database, creating nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "aua-report-"));
    const options = {
      home,
      env: {},
      dataDirOverride: join(home, "data"),
      packageRoot: ROOT,
      timeZone: "UTC",
    };
    expect(() => loadReport(options)).toThrow(NoDatabaseError);
    expect(() => loadReport(options)).toThrow(
      `No database at ${join(home, "data", "usage.db")}; run init or ingest first`,
    );
    expect(existsSync(join(home, "data"))).toBe(false);
    expect(new NoDatabaseError("/x").name).toBe("NoDatabaseError");
  });

  it.skipIf(!HAS_POSIX_MODES)(
    "tightens a world-readable install before reading, with or without a callback (D-043)",
    () => {
      const home = mkdtempSync(join(tmpdir(), "aua-report-"));
      const env = { CLAUDE_CONFIG_DIR: join(ROOT, "fixtures", "06-mixed-models") };
      runIngestCommand({
        home,
        env,
        full: false,
        packageRoot: ROOT,
        now: () => new Date("2026-09-13T00:00:00Z"),
      });
      const dataDir = join(home, ".local", "share", "nilometer");
      const options = { home, env: {}, packageRoot: ROOT, timeZone: "UTC" };
      chmodSync(join(dataDir, "usage.db"), 0o644);
      // No callback: the default ignores the list, and the file is still tightened.
      loadReport(options);
      expect(statSync(join(dataDir, "usage.db")).mode & 0o777).toBe(0o600);
      chmodSync(join(dataDir, "usage.db"), 0o644);
      expect(withReportDatabase(options, () => "read")).toBe("read");
      expect(statSync(join(dataDir, "usage.db")).mode & 0o777).toBe(0o600);
      chmodSync(join(dataDir, "usage.db"), 0o644);
      const seen: (readonly string[])[] = [];
      loadReport(options, (tightened) => seen.push(tightened));
      expect(seen).toEqual([[join(dataDir, "usage.db")]]);
    },
  );

  it("reads a database made by ingest, with the zone and home it was given", () => {
    const home = mkdtempSync(join(tmpdir(), "aua-report-"));
    const env = { CLAUDE_CONFIG_DIR: join(ROOT, "fixtures", "06-mixed-models") };
    runIngestCommand({
      home,
      env,
      full: false,
      packageRoot: ROOT,
      now: () => new Date("2026-09-13T00:00:00Z"),
    });
    const input = loadReport({ home, env: {}, packageRoot: ROOT, timeZone: "UTC" });
    expect(input.databasePath).toBe(join(home, ".local", "share", "nilometer", "usage.db"));
    expect(input.home).toBe(home);
    expect(input.timeZone).toBe("UTC");
    expect(input.lastIngestAt).toBe("2026-09-13T00:00:00.000Z");
    expect(input.observed.byModel.map((row) => row.model).sort()).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
  });
});
