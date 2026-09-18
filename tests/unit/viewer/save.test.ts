/**
 * @file Unit tests for viewer/save.ts (D-030).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_POSIX_MODES } from "../../setup/platform.js";

import { loadObserved, loadProjected } from "../../../viewer/queries.js";
import { type ReportInput, renderReport, reportJson } from "../../../viewer/render.js";
import { MAX_NAME_ATTEMPTS, REPORTS_DIR, reportStem, saveReport } from "../../../viewer/save.js";
import { FIXTURE_TIME_ZONE, buildReportFixture } from "./fixture.js";

/** When the saves in these tests happen: 2026-09-14 00:30:05 UTC is 2026-09-13 19:30:05 CDT. */
const AT = new Date("2026-09-14T00:30:05Z");

describe("reportStem", () => {
  it("names the report by its local date and time, sortable", () => {
    expect(reportStem(AT, FIXTURE_TIME_ZONE)).toBe("report_2026-09-13_193005");
    expect(reportStem(AT, "UTC")).toBe("report_2026-09-14_003005");
    // Midnight is hour 00, not 24.
    expect(reportStem(new Date("2026-09-14T00:00:00Z"), "UTC")).toBe("report_2026-09-14_000000");
  });
});

describe("saveReport", () => {
  let input: ReportInput;
  const originalTz = process.env["TZ"];

  beforeAll(() => {
    process.env["TZ"] = FIXTURE_TIME_ZONE;
    const db = buildReportFixture();
    input = {
      observed: loadObserved(db),
      projected: loadProjected(db),
      timeZone: FIXTURE_TIME_ZONE,
      lastIngestAt: "2026-09-13T00:00:00.000Z",
      databasePath: "/home/example/.local/share/nilometer/usage.db",
      home: "/home/example",
    };
  });

  afterAll(() => {
    if (originalTz === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = originalTz;
    }
  });

  it.skipIf(!HAS_POSIX_MODES)(
    "writes the printed text and the JSON, readable only by the owner",
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), "aua-save-"));
      const saved = saveReport(dataDir, input, AT);
      expect(saved).toEqual({
        textPath: join(dataDir, REPORTS_DIR, "report_2026-09-13_193005.txt"),
        jsonPath: join(dataDir, REPORTS_DIR, "report_2026-09-13_193005.json"),
      });
      expect(readFileSync(saved.textPath, "utf8")).toBe(`${renderReport(input)}\n`);
      expect(JSON.parse(readFileSync(saved.jsonPath, "utf8"))).toEqual(
        JSON.parse(JSON.stringify(reportJson(input))),
      );
      expect(statSync(saved.textPath).mode & 0o777).toBe(0o600);
      expect(statSync(saved.jsonPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(dataDir, REPORTS_DIR)).mode & 0o777).toBe(0o700);
    },
  );

  it("never overwrites: a second save in the same second gets -2", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aua-save-"));
    const first = saveReport(dataDir, input, AT);
    writeFileSync(first.textPath, "kept");
    const second = saveReport(dataDir, input, AT);
    expect(second.textPath).toBe(join(dataDir, REPORTS_DIR, "report_2026-09-13_193005-2.txt"));
    expect(readFileSync(first.textPath, "utf8")).toBe("kept");
  });

  it("refuses when a JSON copy exists without its text, or every name is taken", () => {
    const orphan = mkdtempSync(join(tmpdir(), "aua-save-"));
    mkdirSync(join(orphan, REPORTS_DIR));
    writeFileSync(join(orphan, REPORTS_DIR, "report_2026-09-13_193005.json"), "{}");
    expect(() => saveReport(orphan, input, AT)).toThrow(
      /report_2026-09-13_193005\.json already exists/,
    );

    const full = mkdtempSync(join(tmpdir(), "aua-save-"));
    mkdirSync(join(full, REPORTS_DIR));
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
      const name =
        attempt === 1 ? "report_2026-09-13_193005" : `report_2026-09-13_193005-${attempt}`;
      writeFileSync(join(full, REPORTS_DIR, `${name}.txt`), "");
    }
    expect(() => saveReport(full, input, AT)).toThrow(`${MAX_NAME_ATTEMPTS} report names`);
  });

  // A read-only folder needs POSIX modes.
  it.skipIf(!HAS_POSIX_MODES)("passes other write failures through", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "aua-save-"));
    mkdirSync(join(dataDir, REPORTS_DIR));
    chmodSync(join(dataDir, REPORTS_DIR), 0o500);
    try {
      expect(() => saveReport(dataDir, input, AT)).toThrow(/EACCES/);
    } finally {
      chmodSync(join(dataDir, REPORTS_DIR), 0o700);
    }
  });
});
