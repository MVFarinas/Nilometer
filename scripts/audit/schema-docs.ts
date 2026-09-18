/**
 * @file Schema documentation check (audit check A5, docs/development.md § Standards "SQL files").
 *
 * Every migration in `core/schema/` must:
 * 1. open with a `--` header comment naming what it creates and why;
 * 2. carry a trailing `--` comment on every column definition inside `CREATE TABLE`, naming the
 *    log or payload field it holds (`-- source: message.usage.output_tokens`) or stating that it is
 *    derived;
 * 3. put a `--` comment on the line directly above every `CREATE VIEW`, naming the metric and whether
 *    it is observed or projected;
 * 4. carry a trailing `--` comment on every `ALTER TABLE ... ADD COLUMN`, just like a column in
 *    `CREATE TABLE`, so later migrations can't add undocumented columns.
 *
 * The parser is line-based and relies on the schema convention of one column per line. A migration
 * that doesn't follow that convention fails the check, which is the point: the convention is what
 * keeps the schema reviewable.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** One documentation problem in one migration file. */
export interface SchemaProblem {
  /** Migration file name. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** What is missing. */
  readonly problem: string;
}

/** Keywords that start a table constraint rather than a column definition. */
export const CONSTRAINT_KEYWORDS: readonly string[] = [
  "PRIMARY",
  "UNIQUE",
  "FOREIGN",
  "CHECK",
  "CONSTRAINT",
];

/**
 * Checks one migration file's text.
 * @param file - File name, copied into each problem.
 * @param sql - The file's SQL text.
 * @returns Every problem found, in line order; empty when the file is fully documented.
 */
export function checkSchemaFile(file: string, sql: string): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const lines = sql.split(/\r?\n/);
  const firstContent = lines.findIndex((line) => line.trim() !== "");
  if (firstContent === -1 || !lines[firstContent]!.trim().startsWith("--")) {
    problems.push({ file, line: firstContent + 1 || 1, problem: "missing header comment" });
  }
  let inTable = false;
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const upper = line.toUpperCase();
    if (/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?TABLE\b/.test(upper)) {
      inTable = true;
      return;
    }
    if (/^CREATE\s+(TEMP\s+|TEMPORARY\s+)?VIEW\b/.test(upper)) {
      // The nearest non-blank line above must be a comment describing the view.
      const above = lines
        .slice(0, index)
        .reverse()
        .find((candidate) => candidate.trim() !== "");
      if (above === undefined || !above.trim().startsWith("--")) {
        problems.push({ file, line: index + 1, problem: "view without a comment above it" });
      }
      return;
    }
    if (/^ALTER\s+TABLE\b.*\bADD\s+(COLUMN\s+)?/.test(upper)) {
      if (!line.includes("--")) {
        problems.push({
          file,
          line: index + 1,
          problem: "added column without a trailing comment",
        });
      }
      return;
    }
    if (!inTable) {
      return;
    }
    // A line starting with ")" closes the column list (e.g. ");" or ") STRICT;").
    if (line.startsWith(")")) {
      inTable = false;
      return;
    }
    // Blank lines and full-line comments inside a table are allowed and need nothing.
    if (line === "" || line.startsWith("--")) {
      return;
    }
    const firstWord = upper.split(/[\s(]/)[0] ?? "";
    if (CONSTRAINT_KEYWORDS.includes(firstWord)) {
      return;
    }
    if (!line.includes("--")) {
      problems.push({ file, line: index + 1, problem: "column without a trailing comment" });
    }
  });
  return problems;
}

/** Dependencies of {@link main}. */
export interface SchemaDocsDeps {
  /** Lists file names in a directory. */
  readonly listFiles: (dir: string) => string[];
  /** Reads a file's text. */
  readonly readText: (path: string) => string;
  /** Writes one output line. */
  readonly print: (line: string) => void;
}

/**
 * Checks every `.sql` file in a schema directory and prints the result.
 * @param schemaDir - Directory holding migration files.
 * @param deps - Filesystem access and output.
 * @returns Exit code 0 when every file is documented and at least one exists, otherwise 1.
 */
export function main(schemaDir: string, deps: SchemaDocsDeps): number {
  const files = deps
    .listFiles(schemaDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const problems = files.flatMap((file) =>
    checkSchemaFile(file, deps.readText(join(schemaDir, file))),
  );
  for (const problem of problems) {
    deps.print(`${problem.file}:${problem.line} ${problem.problem}`);
  }
  deps.print(`schema docs: ${files.length} files checked, ${problems.length} problems`);
  // An empty schema directory proves nothing, so it never passes.
  return files.length > 0 && problems.length === 0 ? 0 : 1;
}

/**
 * Builds the real dependencies used by the command-line entry point.
 * @returns Dependencies backed by the filesystem and stdout.
 */
export function defaultDeps(): SchemaDocsDeps {
  return {
    listFiles: (dir) => readdirSync(dir),
    readText: (path) => readFileSync(path, "utf8"),
    print: (line) => {
      console.log(line);
    },
  };
}
