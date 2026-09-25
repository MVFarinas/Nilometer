/**
 * @file Saving a dated copy of the report (D-030), and with `--html` its HTML page (D-070).
 *
 * A report is recomputed from the database on every run, so a saved copy is the only record of what
 * the screen said at a given time, before later price rows, view changes, or repository re-resolution
 * (D-020, D-028) change the numbers. Copies hold personal usage and spend figures, so they go to the
 * data directory with owner-only permissions, never to the working directory (D-043). The HTML page
 * also embeds the events behind every drawn element, session IDs included, so it gets the same
 * treatment.
 *
 * Implements README "Commands" (`nilometer report --save`) and step G1.4.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type ReportInput, renderReport, reportJson } from "./render.js";

/** Folder inside the data directory that holds saved reports. */
export const REPORTS_DIR = "reports";

/** Most name variants tried for one second before giving up. */
export const MAX_NAME_ATTEMPTS = 100;

/** Where a saved report was written. */
export interface SavedReport {
  /** The rendered text, as printed. */
  readonly textPath: string;
  /** Unrounded rows and labels. */
  readonly jsonPath: string;
  /** The self-contained HTML page (D-070); present only when one was asked for. */
  readonly htmlPath?: string;
}

/**
 * Builds a saved report's file name stem in the display zone.
 * @param at - When the report was produced.
 * @param timeZone - IANA zone the report shows times in.
 * @returns `report_YYYY-MM-DD_HHMMSS`, which sorts chronologically within one zone.
 * @example
 * reportStem(new Date("2026-09-14T00:30:05Z"), "America/Chicago"); // "report_2026-09-13_193005"
 */
export function reportStem(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  /**
   * Finds one part's value.
   * @param type - Part type.
   * @returns The value.
   */
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `report_${part("year")}-${part("month")}-${part("day")}_${part("hour")}${part("minute")}${part("second")}`;
}

/**
 * Writes one file, failing instead of replacing an existing one.
 * @param path - Target path.
 * @param content - File content.
 * @returns True when written; false when the path already exists.
 * @throws {Error} For any failure other than the file already existing.
 */
function writeNew(path: string, content: string): boolean {
  try {
    // "wx" fails on an existing file, so two saves in the same second can't overwrite each other.
    writeFileSync(path, content, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

/**
 * Saves the report as text and JSON under the data directory, and optionally as an HTML page.
 *
 * All the files of one save share one stem, so a save's files can be picked out by name alone:
 * the text file claims the stem, and its twins are written under it.
 * @param dataDir - The data directory holding the database.
 * @param input - The report input, as rendered.
 * @param at - When the report was produced.
 * @param html - The rendered HTML page (D-070), written as given; no `.html` file is written when
 *   it's omitted.
 * @returns The paths written.
 * @throws {Error} If {@link MAX_NAME_ATTEMPTS} names for this second are all taken, if a twin of a
 *   newly claimed text file already exists, or if writing fails.
 */
export function saveReport(
  dataDir: string,
  input: ReportInput,
  at: Date,
  html?: string,
): SavedReport {
  const dir = join(dataDir, REPORTS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stem = reportStem(at, input.timeZone);
  const text = `${renderReport(input)}\n`;
  const json = `${JSON.stringify(reportJson(input), null, 2)}\n`;
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? stem : `${stem}-${attempt}`;
    const textPath = join(dir, `${name}.txt`);
    const jsonPath = join(dir, `${name}.json`);
    if (writeNew(textPath, text)) {
      // The text file claimed the name; its twins can't exist unless someone made them by hand.
      if (!writeNew(jsonPath, json)) {
        throw new Error(`${jsonPath} already exists though ${textPath} didn't`);
      }
      if (html === undefined) {
        return { textPath, jsonPath };
      }
      const htmlPath = join(dir, `${name}.html`);
      // Same rule as the JSON twin: a page found under a claimed stem is never replaced, since it
      // would then sit beside text it wasn't drawn from.
      if (!writeNew(htmlPath, html)) {
        throw new Error(`${htmlPath} already exists though ${textPath} didn't`);
      }
      return { textPath, jsonPath, htmlPath };
    }
  }
  throw new Error(`${MAX_NAME_ATTEMPTS} report names for ${stem} are already taken in ${dir}`);
}
