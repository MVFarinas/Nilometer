/**
 * @file Unit tests for scripts/fidelity/loader-check.ts (audit check A6c).
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  IDEMPOTENT_TABLES,
  checkCase,
  diffValues,
  listFilesRecursive,
  main,
  stageState,
  statesOf,
} from "../../../../scripts/fidelity/loader-check.js";

/** Repository paths. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURES = join(ROOT, "fixtures");
const SCHEMA = join(ROOT, "core/schema");

/**
 * Copies fixture cases into a fresh fixtures root.
 * @param caseIds - Cases to copy.
 * @returns The new root.
 */
function copyCases(...caseIds: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "aua-loader-check-"));
  for (const caseId of caseIds) {
    cpSync(join(FIXTURES, caseId), join(root, caseId), { recursive: true });
  }
  return root;
}

describe("statesOf", () => {
  it("returns final for a single-state case", () => {
    expect(statesOf(join(FIXTURES, "01-streaming-snapshots"))).toEqual([
      { name: "final", dir: join(FIXTURES, "01-streaming-snapshots") },
    ]);
  });

  it("returns runs in numeric order, so run-10 comes after run-2", () => {
    const dir = mkdtempSync(join(tmpdir(), "aua-states-"));
    for (const run of ["run-10", "run-2", "run-1", "notes"]) {
      mkdirSync(join(dir, run));
    }
    expect(statesOf(dir).map((state) => state.name)).toEqual(["run-1", "run-2", "run-10"]);
  });
});

describe("listFilesRecursive and stageState", () => {
  it("lists nested files relative to the directory", () => {
    expect(listFilesRecursive(join(FIXTURES, "11-subagent-file", "projects"))).toEqual([
      "-fixture-demo/s11.jsonl",
      "-fixture-demo/s11/subagents/agent-a1.jsonl",
    ]);
  });

  it("overwrites in place, keeping inodes, and replace makes new files", () => {
    const root = mkdtempSync(join(tmpdir(), "aua-stage-"));
    const file = join(root, "projects/-fixture-demo/s02.jsonl");
    stageState(join(FIXTURES, "02-split-across-runs/run-1"), root, "overwrite");
    const firstInode = statSync(file).ino;
    stageState(join(FIXTURES, "02-split-across-runs/run-2"), root, "overwrite");
    expect(statSync(file).ino).toBe(firstInode);
    expect(readFileSync(file)).toEqual(
      readFileSync(join(FIXTURES, "02-split-across-runs/run-2/projects/-fixture-demo/s02.jsonl")),
    );
    stageState(join(FIXTURES, "02-split-across-runs/run-1"), root, "replace");
    expect(readFileSync(file)).toEqual(
      readFileSync(join(FIXTURES, "02-split-across-runs/run-1/projects/-fixture-demo/s02.jsonl")),
    );
  });
});

describe("diffValues", () => {
  it("returns nothing for equal values", () => {
    expect(diffValues({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toEqual([]);
  });

  it("reports differing primitives with their path", () => {
    expect(
      diffValues({ requests: [{ output_tokens: 42 }] }, { requests: [{ output_tokens: 20 }] }),
    ).toEqual(["$.requests[0].output_tokens: expected 42, got 20"]);
  });

  it("reports array length differences and compares the common prefix", () => {
    expect(diffValues([1, 2, 3], [1, 9])).toEqual([
      "$: expected 3 items, got 2",
      "$[1]: expected 2, got 9",
    ]);
  });

  it("reports missing and unexpected keys", () => {
    expect(diffValues({ a: 1, b: 2 }, { b: 2, c: 3 }, "final")).toEqual([
      "final.a: missing",
      "final.c: unexpected",
    ]);
  });

  it("reports a type mismatch between an object and an array or null", () => {
    expect(diffValues({ a: {} }, { a: [] })).toEqual(["$.a: expected {}, got []"]);
    expect(diffValues(null, {})).toEqual(["$: expected null, got {}"]);
  });
});

describe("checkCase", () => {
  it("passes a committed case with stable fingerprints", () => {
    expect(checkCase(join(FIXTURES, "12-rewritten-file"), SCHEMA, "overwrite")).toEqual({
      differences: [],
      unstableTables: [],
    });
    expect(IDEMPOTENT_TABLES).toContain("raw_lines");
  });

  it("reports a difference when expected.json is wrong", () => {
    const root = copyCases("01-streaming-snapshots");
    const path = join(root, "01-streaming-snapshots/expected.json");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace('"output_tokens": 42', '"output_tokens": 67'),
    );
    expect(checkCase(join(root, "01-streaming-snapshots"), SCHEMA, "replace").differences).toEqual([
      "final.requests[0].output_tokens: expected 67, got 42",
    ]);
  });
});

describe("main", () => {
  it("passes and summarizes when every case passes in both modes", () => {
    const printed: string[] = [];
    expect(
      main(copyCases("04-btw-replay", "03-trailing-fragment"), SCHEMA, (line) =>
        printed.push(line),
      ),
    ).toBe(0);
    expect(printed).toEqual([
      "PASS 03-trailing-fragment (overwrite)",
      "PASS 03-trailing-fragment (replace)",
      "PASS 04-btw-replay (overwrite)",
      "PASS 04-btw-replay (replace)",
      "loader fidelity: PASS (2 cases × 2 staging modes)",
    ]);
  });

  it("fails and prints each difference when a case disagrees", () => {
    const root = copyCases("06-mixed-models");
    const path = join(root, "06-mixed-models/expected.json");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        '"claude-opus-5": {\n        "requests": 1,\n        "input_tokens": 200',
        '"claude-opus-5": {\n        "requests": 1,\n        "input_tokens": 201',
      ),
    );
    const printed: string[] = [];
    expect(main(root, SCHEMA, (line) => printed.push(line))).toBe(1);
    expect(printed).toContain("FAIL 06-mixed-models (overwrite)");
    expect(printed).toContain(
      "  final.totals_by_model.claude-opus-5.input_tokens: expected 201, got 200",
    );
    expect(printed.at(-1)).toBe("loader fidelity: FAIL (2 case runs)");
  });

  it("fails when there are no cases, since nothing was checked", () => {
    expect(main(mkdtempSync(join(tmpdir(), "aua-empty-")), SCHEMA, () => undefined)).toBe(1);
  });
});
