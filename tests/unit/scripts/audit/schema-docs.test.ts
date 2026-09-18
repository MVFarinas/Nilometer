/**
 * @file Unit tests for scripts/audit/schema-docs.ts (audit check A5).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type SchemaDocsDeps,
  checkSchemaFile,
  defaultDeps,
  main,
} from "../../../../scripts/audit/schema-docs.js";

/** A fully documented migration used as the passing baseline. */
const GOOD = `-- 001: example tables.
CREATE TABLE raw_lines (
  id           INTEGER PRIMARY KEY, -- derived: row identity
  content_hash TEXT NOT NULL,       -- derived: SHA-256 of bytes

  -- a full-line comment inside a table is fine
  bytes        BLOB NOT NULL,       -- source: the exact log line
  UNIQUE (content_hash),
  CHECK (length(content_hash) = 64)
) STRICT;

-- Observed: every raw line, newest first.
CREATE VIEW recent AS SELECT * FROM raw_lines;
`;

describe("checkSchemaFile", () => {
  it("accepts a fully documented migration", () => {
    expect(checkSchemaFile("001_x.sql", GOOD)).toEqual([]);
  });

  it("reports a missing header comment", () => {
    expect(checkSchemaFile("a.sql", "CREATE VIEW v AS SELECT 1;")).toContainEqual({
      file: "a.sql",
      line: 1,
      problem: "missing header comment",
    });
  });

  it("reports an empty file as missing its header", () => {
    expect(checkSchemaFile("e.sql", "\n\n")).toEqual([
      { file: "e.sql", line: 1, problem: "missing header comment" },
    ]);
  });

  it("reports a column without a trailing comment, with its line number", () => {
    const sql = GOOD.replace(
      "bytes        BLOB NOT NULL,       -- source: the exact log line",
      "bytes BLOB NOT NULL,",
    );
    expect(checkSchemaFile("001_x.sql", sql)).toEqual([
      { file: "001_x.sql", line: 7, problem: "column without a trailing comment" },
    ]);
  });

  it("reports a view with no comment directly above it", () => {
    const sql = GOOD.replace("-- Observed: every raw line, newest first.\n", "");
    expect(checkSchemaFile("001_x.sql", sql)).toEqual([
      { file: "001_x.sql", line: 12, problem: "view without a comment above it" },
    ]);
  });

  it("reports a view on the first line as uncommented", () => {
    expect(checkSchemaFile("v.sql", "CREATE VIEW v AS SELECT 1;")).toContainEqual({
      file: "v.sql",
      line: 1,
      problem: "view without a comment above it",
    });
  });

  it("recognizes temporary tables and views, in any case", () => {
    const sql =
      "-- header\ncreate temp table t (\n  a INTEGER\n);\ncreate temporary view v as select 1;\n";
    expect(checkSchemaFile("t.sql", sql)).toEqual([
      { file: "t.sql", line: 3, problem: "column without a trailing comment" },
      { file: "t.sql", line: 5, problem: "view without a comment above it" },
    ]);
  });

  it("requires a trailing comment on ALTER TABLE ... ADD COLUMN, with or without COLUMN", () => {
    const sql =
      "-- header\nALTER TABLE t ADD COLUMN a INTEGER; -- derived: documented\nALTER TABLE t ADD COLUMN b INTEGER;\nalter table t add c TEXT;\n";
    expect(checkSchemaFile("m.sql", sql)).toEqual([
      { file: "m.sql", line: 3, problem: "added column without a trailing comment" },
      { file: "m.sql", line: 4, problem: "added column without a trailing comment" },
    ]);
  });

  it("ignores lines outside tables, such as indexes", () => {
    const sql = "-- header\nCREATE INDEX idx ON t (a);\nINSERT INTO t VALUES (1);\n";
    expect(checkSchemaFile("i.sql", sql)).toEqual([]);
  });
});

describe("main", () => {
  /**
   * Builds dependencies over an in-memory directory listing.
   * @param files - File name to contents.
   * @returns Dependencies and captured output.
   */
  function depsFor(files: Record<string, string>): { deps: SchemaDocsDeps; printed: string[] } {
    const printed: string[] = [];
    return {
      printed,
      deps: {
        listFiles: () => Object.keys(files),
        readText: (path) => files[path.split(/[\\/]/).at(-1)!]!,
        print: (line) => printed.push(line),
      },
    };
  }

  it("passes a documented schema and ignores non-SQL files", () => {
    const { deps, printed } = depsFor({ "001_x.sql": GOOD, "README.md": "notes" });
    expect(main("/schema", deps)).toBe(0);
    expect(printed).toEqual(["schema docs: 1 files checked, 0 problems"]);
  });

  it("fails and prints each problem", () => {
    const { deps, printed } = depsFor({ "001_x.sql": "CREATE TABLE t (\n  a INTEGER\n);" });
    expect(main("/schema", deps)).toBe(1);
    expect(printed).toEqual([
      "001_x.sql:1 missing header comment",
      "001_x.sql:2 column without a trailing comment",
      "schema docs: 1 files checked, 2 problems",
    ]);
  });

  it("fails an empty schema directory, which proves nothing", () => {
    const { deps } = depsFor({});
    expect(main("/schema", deps)).toBe(1);
  });
});

describe("defaultDeps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists and reads real files and prints through console.log", () => {
    const dir = mkdtempSync(join(tmpdir(), "aua-schema-docs-"));
    writeFileSync(join(dir, "001_x.sql"), GOOD);
    const deps = defaultDeps();
    expect(deps.listFiles(dir)).toEqual(["001_x.sql"]);
    expect(deps.readText(join(dir, "001_x.sql"))).toBe(GOOD);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    deps.print("line");
    expect(log).toHaveBeenCalledWith("line");
  });
});
