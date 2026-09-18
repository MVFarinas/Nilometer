/**
 * @file Audit check A9: no banned phrase in anything the viewer renders (docs/development.md P7.1, CLAUDE.md, D-012).
 *
 * The phrase list is read from the two documents that define it: CLAUDE.md's "Banned framings"
 * paragraph and the add-metric skill's wording checklist. Editing either document changes this
 * test, so the list can't drift from the rules. The viewer runs on every fixture case, an empty
 * database, and the report fixture, and both the table and the `--json` output (which carries
 * every label) are checked.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
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
import { type ReportInput, renderReport, reportJson } from "../../viewer/render.js";
import { ingest } from "../unit/core/metrics/helpers.js";
import { FIXTURE_TIME_ZONE, buildReportFixture } from "../unit/viewer/fixture.js";

/** Repository root. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Reads the banned phrases from CLAUDE.md and the add-metric skill.
 * @returns Lowercase phrases, each listed once.
 */
export function bannedPhrases(): string[] {
  const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
  // The paragraph goes on to name the approved wording ("Use the README's wording instead"), which
  // must not be read as banned.
  const framings = /Banned framings:([\s\S]*?)(?:Use the README|\n\n)/.exec(claude)?.[1] ?? "";
  const fromClaude = [...framings.matchAll(/\*([^*]+)\*/g)].map((m) => m[1] as string);
  const skill = readFileSync(join(ROOT, ".claude/skills/add-metric/SKILL.md"), "utf8");
  const checklist = /No banned phrasing[^:]*:\s*\*([^*]+)\*/.exec(skill)?.[1] ?? "";
  const fromSkill = checklist.split(",").map((phrase) => phrase.trim());
  return [...new Set([...fromClaude, ...fromSkill].map((phrase) => phrase.toLowerCase()))];
}

/**
 * Finds banned phrases in text. A phrase matches at a word start, in any case, so "recommended"
 * and "Savings" are caught too.
 * @param text - Rendered output.
 * @param phrases - From {@link bannedPhrases}.
 * @returns The phrases found.
 */
export function findBanned(text: string, phrases: readonly string[]): string[] {
  return phrases.filter((phrase) =>
    new RegExp(
      `\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}`,
      "i",
    ).test(text),
  );
}

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
});
