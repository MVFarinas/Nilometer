/**
 * @file Audit check A9: everything the viewer renders is ASCII (D-063).
 *
 * A Windows console on a legacy code page decodes UTF-8 as CP437 or CP850, so a middle dot or an
 * en dash in ordinary output arrives as mojibake — observed on a supported platform, where a
 * coverage line read "02:27ΓÇô02:29". The tool either stays inside ASCII or asks every Windows user
 * to run `chcp 65001` first, which is handing them the problem.
 *
 * Only Nilometer's own wording is checked. Repository names, model names and file paths come from
 * the user's logs and may hold anything; the fixtures this renders over are all ASCII, so a
 * non-ASCII character in the output is the tool's own.
 */
import { describe, expect, it } from "vitest";

import { METRIC_NAMES, explain, renderExplanation } from "../../viewer/explain.js";
import { loadObserved, loadProjected } from "../../viewer/queries.js";
import { type ReportInput, renderReport, reportJson } from "../../viewer/render.js";
import { ingest } from "../unit/core/metrics/helpers.js";
import { FIXTURE_TIME_ZONE, buildReportFixture } from "../unit/viewer/fixture.js";

/**
 * Finds characters a legacy Windows console would garble.
 * @param text - Rendered output.
 * @returns One entry per distinct non-ASCII character, with its code point and a line of context.
 */
function nonAscii(text: string): string[] {
  const found = new Map<string, string>();
  for (const line of text.split("\n")) {
    for (const char of line) {
      const code = char.codePointAt(0) ?? 0;
      if (code > 0x7f && !found.has(char)) {
        found.set(char, `U+${code.toString(16).toUpperCase().padStart(4, "0")} in: ${line.trim()}`);
      }
    }
  }
  return [...found.values()];
}

describe("everything the viewer prints is ASCII", () => {
  it("finds the characters it is looking for", () => {
    // The guard's own check: it has to see a middle dot and an en dash when they are there.
    expect(nonAscii("a · b")).toHaveLength(1);
    expect(nonAscii("09:00–14:00")[0]).toContain("U+2013");
    expect(nonAscii("plain ascii, nothing here")).toEqual([]);
  });

  it("holds for the report, its JSON, and every explain view", () => {
    for (const db of [ingest({}), buildReportFixture()]) {
      const input: ReportInput = {
        observed: loadObserved(db),
        projected: loadProjected(db),
        timeZone: FIXTURE_TIME_ZONE,
        lastIngestAt: "2026-09-13T00:00:00Z",
        databasePath: "/home/example/.local/share/nilometer/usage.db",
        home: "/home/example",
      };
      expect(nonAscii(renderReport(input))).toEqual([]);
      expect(nonAscii(JSON.stringify(reportJson(input)))).toEqual([]);
      for (const metric of METRIC_NAMES) {
        const lines = renderExplanation(explain(db, metric), FIXTURE_TIME_ZONE, "", 50);
        expect(nonAscii(lines.join("\n"))).toEqual([]);
      }
    }
  });
});
