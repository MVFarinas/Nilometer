/**
 * @file Audit check A9: no banned phrase in anything the viewer renders (docs/development.md P7.1, CLAUDE.md, D-012).
 *
 * The phrase list is read from the two documents that define it: CLAUDE.md's "Banned framings"
 * paragraph and the add-metric skill's wording checklist. Editing either document changes this
 * test, so the list can't drift from the rules. The viewer runs on every fixture case, an empty
 * database, and the report fixture, and both the table and the `--json` output (which carries
 * every label) are checked.
 */
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Db, openDatabase } from "../../core/db/database.js";
import { ensureDerived } from "../../core/ingest/derive.js";
import { ingestLogs } from "../../core/ingest/ingest.js";
import { loadPriceTable, syncPrices } from "../../core/pricing/prices.js";
import { stageState, statesOf } from "../../scripts/fidelity/loader-check.js";
import { loadObserved, loadProjected } from "../../viewer/queries.js";
import { LABELS, type ReportInput, renderReport, reportJson } from "../../viewer/render.js";
import { METRIC_NAMES, explain, renderExplanation } from "../../viewer/explain.js";
import { ingest, request } from "../unit/core/metrics/helpers.js";
import { bannedPhrases, findBanned } from "./banned-phrases.js";
import { FIXTURE_TIME_ZONE, buildReportFixture } from "../unit/viewer/fixture.js";

/** Repository root. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Builds a report input over a database.
 * @param db - Database.
 * @returns The input, as the CLI would assemble it.
 */
function inputFor(db: Db): ReportInput {
  return {
    observed: loadObserved(db),
    projected: loadProjected(db),
    timeZone: FIXTURE_TIME_ZONE,
    lastIngestAt: "2026-09-13T00:00:00.000Z",
    databasePath: "/home/example/.local/share/nilometer/usage.db",
    home: "/home/example",
    // A missing hook, so the warning's wording is checked too (D-081).
    missingHookPath: "/home/example/nilometer/hooks/statusline.sh",
  };
}

/**
 * Ingests every state of a fixture case, in order, into a fresh database.
 * @param caseDir - The case directory.
 * @returns The database after the last state.
 */
function ingestCase(caseDir: string): Db {
  const db = openDatabase(":memory:", join(ROOT, "core/schema"));
  const root = mkdtempSync(join(tmpdir(), "aua-wording-"));
  for (const state of statesOf(caseDir)) {
    stageState(state.dir, root, "overwrite");
    ingestLogs(db, {
      roots: [root],
      mode: "incremental",
      now: () => new Date("2026-09-13T00:00:00Z"),
    });
  }
  ensureDerived(db);
  syncPrices(db, loadPriceTable(join(ROOT, "core/pricing/prices.json")));
  return db;
}

describe("A9: banned phrases in viewer output", () => {
  const originalTz = process.env["TZ"];
  const phrases = bannedPhrases();

  beforeAll(() => {
    process.env["TZ"] = FIXTURE_TIME_ZONE;
  });

  afterAll(() => {
    if (originalTz === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = originalTz;
    }
  });

  it("reads every phrase from CLAUDE.md and the add-metric skill", () => {
    expect([...phrases].sort()).toEqual([
      "cheaper by",
      "efficiency",
      "productivity",
      "recommend",
      "savings",
      "score",
      "time lost",
      "verdict",
      "wasted",
      "would have spent",
      "you should switch plans",
    ]);
  });

  it("finds a phrase at a word start in any case, across line breaks, and nowhere else", () => {
    expect(findBanned("Time\n  Lost: 3 h", phrases)).toEqual(["time lost"]);
    expect(findBanned("We recommended it", phrases)).toEqual(["recommend"]);
    expect(findBanned("underscore and scores", phrases)).toEqual(["score"]);
    expect(findBanned("elapsed lockout time", phrases)).toEqual([]);
  });

  const cases = readdirSync(join(ROOT, "fixtures")).filter((name) =>
    statSync(join(ROOT, "fixtures", name)).isDirectory(),
  );

  it.each(cases)("renders fixture %s without a banned phrase, as a table and as JSON", (caseId) => {
    const input = inputFor(ingestCase(join(ROOT, "fixtures", caseId)));
    expect(findBanned(renderReport(input), phrases)).toEqual([]);
    expect(findBanned(JSON.stringify(reportJson(input)), phrases)).toEqual([]);
  });

  it("renders the empty database and the report fixture without a banned phrase", () => {
    for (const db of [ingest({}), buildReportFixture()]) {
      const input = inputFor(db);
      expect(findBanned(renderReport(input), phrases)).toEqual([]);
      expect(findBanned(JSON.stringify(reportJson(input)), phrases)).toEqual([]);
    }
  });

  it("renders weekly crossings without a banned phrase, both levels and the caveat (D-087)", () => {
    // No fixture case reaches 75% weekly, so the crossing lines only render here; the third
    // reading, 60 after 95, is stale (D-089), so its count line renders too.
    const crossed = ingest(
      {},
      [80, 95, 60].map((used, i) => ({
        at: `2026-09-0${String(i + 3)}T12:00:00Z`,
        session: "s",
        window: "seven_day",
        used,
        resets: "2026-09-08T00:00:00Z",
      })),
    );
    const input = inputFor(crossed);
    const text = renderReport(input);
    expect(text).toContain("90% first read");
    expect(text).toContain(LABELS.staleReadings);
    expect(findBanned(text, phrases)).toEqual([]);
    expect(findBanned(JSON.stringify(reportJson(input)), phrases)).toEqual([]);
    const headroom = renderExplanation(explain(crossed, "headroom"), FIXTURE_TIME_ZONE, "", 50);
    expect(headroom.join("\n")).toContain("stale reading, not used");
    expect(findBanned(headroom.join("\n"), phrases)).toEqual([]);
  });

  it("renders every explain view without a banned phrase, a changed reading's too (D-086)", () => {
    // A value that changed after the session's last request: its own wording in explain.
    const changed = ingest(
      { "-p/s.jsonl": [request("s", "r1", null, "2026-09-01T10:00:00Z")] },
      [20, 40].map((used, i) => ({
        at: `2026-09-01T1${String(i)}:00:05Z`,
        session: "s",
        window: "five_hour",
        used,
        resets: "2026-09-01T14:00:00Z",
      })),
    );
    const text = renderExplanation(explain(changed, "peak"), FIXTURE_TIME_ZONE, "", 50).join("\n");
    expect(text).toContain("changed since the session's last request");
    for (const db of [changed, buildReportFixture()]) {
      for (const metric of METRIC_NAMES) {
        const lines = renderExplanation(explain(db, metric), FIXTURE_TIME_ZONE, "", 50);
        expect(findBanned(lines.join("\n"), phrases)).toEqual([]);
      }
    }
  });
});
