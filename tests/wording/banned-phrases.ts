/**
 * @file The banned-phrase list and matcher shared by the wording guards (A9 and the HTML report's
 * guard, step G1.3). A plain module, not a test file, so importing it doesn't register another
 * file's tests (CLAUDE.md "Wording is part of correctness", D-012).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
