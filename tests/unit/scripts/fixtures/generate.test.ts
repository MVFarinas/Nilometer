/**
 * @file Unit tests for scripts/fixtures/generate.ts (docs/development.md P2.1).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CWD,
  FIXTURE_VERSION,
  PROJECT_DIR,
  SONNET,
  assistantLine,
  buildCases,
  main,
  retryNoticeLine,
  sessionPath,
  streamingSnapshots,
  syntheticLine,
  systemLine,
  toJsonl,
  usage,
  userLine,
  writeCase,
} from "../../../../scripts/fixtures/generate.js";

/** The committed fixtures directory. */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../../fixtures");

/** Common line fields used across tests. */
const BASE = { session: "s", uuid: "u", ts: "2026-09-01T00:00:00.000Z" };

describe("usage", () => {
  it("writes the split cache-creation form with totals when no unsplit value is given", () => {
    expect(usage({ input: 1, output: 2, cacheRead: 3, cache5m: 4, cache1h: 5 })).toEqual({
      input_tokens: 1,
      cache_creation_input_tokens: 9,
      cache_read_input_tokens: 3,
      output_tokens: 2,
      service_tier: "standard",
      cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 4 },
      iterations: [{ type: "message" }],
    });
  });

  it("writes only cache_creation_input_tokens in the unsplit form", () => {
    const result = usage({ input: 1, output: 2, cacheRead: 0, unsplit: 400 });
    expect(result["cache_creation_input_tokens"]).toBe(400);
    expect(result).not.toHaveProperty("cache_creation");
  });

  it("omits token counts that aren't given, so fixtures can exercise missing fields", () => {
    const result = usage({});
    expect(result).not.toHaveProperty("input_tokens");
    expect(result).not.toHaveProperty("output_tokens");
    expect(result).not.toHaveProperty("cache_read_input_tokens");
    expect(result["cache_creation"]).toEqual({
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    });
  });

  it("appends extra iterations after the message iteration", () => {
    const result = usage({ extraIterations: [{ type: "advisor" }] });
    expect(result["iterations"]).toEqual([{ type: "message" }, { type: "advisor" }]);
  });
});

describe("line builders", () => {
  it("builds a user line with the envelope in Claude Code's key order", () => {
    expect(Object.keys(userLine(BASE))).toEqual([
      "parentUuid",
      "isSidechain",
      "userType",
      "cwd",
      "sessionId",
      "version",
      "gitBranch",
      "type",
      "message",
      "uuid",
      "timestamp",
    ]);
    expect(userLine({ ...BASE, cwd: "/x", sidechain: true })).toMatchObject({
      cwd: "/x",
      isSidechain: true,
      version: FIXTURE_VERSION,
    });
  });

  it("builds an assistant line with IDs, default model, and default stop reason", () => {
    const line = assistantLine({ ...BASE, messageId: "m", requestId: "r", usage: { output: 1 } });
    expect(line).toMatchObject({ requestId: "r", type: "assistant", cwd: DEFAULT_CWD });
    expect(line["message"]).toMatchObject({ id: "m", model: SONNET, stop_reason: "end_turn" });
  });

  it("omits IDs that aren't given and keeps an explicit null stop reason", () => {
    const line = assistantLine({ ...BASE, usage: {}, stopReason: null, model: "claude-opus-5" });
    expect(line).not.toHaveProperty("requestId");
    expect(line["message"]).not.toHaveProperty("id");
    expect(line["message"]).toMatchObject({ stop_reason: null, model: "claude-opus-5" });
  });

  it("builds streaming snapshots that differ only in output tokens and UUID", () => {
    const [first, second] = streamingSnapshots({ ...BASE, messageId: "m", usage: { input: 1 } }, [
      5, 9,
    ]);
    expect(first!["uuid"]).toBe("u-1");
    expect(second!["uuid"]).toBe("u-2");
    expect((first!["message"] as { usage: { output_tokens: number } }).usage.output_tokens).toBe(5);
    expect((second!["message"] as { usage: { output_tokens: number } }).usage.output_tokens).toBe(9);
  });

  it("builds a synthetic line with error fields only when given", () => {
    const full = syntheticLine({
      ...BASE,
      text: "t",
      error: "rate_limit",
      status: 429,
      apiError: true,
      messageId: "m",
      requestId: "r",
    });
    expect(full).toMatchObject({ error: "rate_limit", apiErrorStatus: 429, isApiErrorMessage: true });
    expect(full["message"]).toMatchObject({ id: "m", model: "<synthetic>" });
    const bare = syntheticLine({ ...BASE, text: "t" });
    for (const key of ["error", "apiErrorStatus", "isApiErrorMessage", "requestId"]) {
      expect(bare).not.toHaveProperty(key);
    }
    expect(bare["message"]).not.toHaveProperty("id");
  });

  it("builds a retry notice with the observed fields", () => {
    expect(retryNoticeLine(BASE, 429, null)).toMatchObject({
      type: "system",
      subtype: "api_error",
      source: "request_retry",
      error: { status: 429, rateLimits: null },
    });
  });

  it("builds a system line with the given subtype", () => {
    expect(systemLine(BASE, "turn_duration")).toMatchObject({
      type: "system",
      subtype: "turn_duration",
    });
  });
});

describe("toJsonl", () => {
  it("writes objects and arrays as compact JSON and raw strings verbatim, one per line", () => {
    expect(toJsonl([{ a: 1 }, [1, 2], "{broken"])).toBe('{"a":1}\n[1,2]\n{broken\n');
  });
});

describe("sessionPath", () => {
  it("puts single-state logs directly under projects/", () => {
    expect(sessionPath("projects", "s1")).toBe(`projects/${PROJECT_DIR}/s1.jsonl`);
  });

  it("nests projects/ under a run directory so each run works as CLAUDE_CONFIG_DIR", () => {
    expect(sessionPath("run-2", "s1")).toBe(`run-2/projects/${PROJECT_DIR}/s1.jsonl`);
  });
});

describe("buildCases", () => {
  const cases = buildCases();

  it("has unique, sorted case IDs, each with at least one file", () => {
    const ids = cases.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(cases.every((fixture) => Object.keys(fixture.files).length > 0)).toBe(true);
  });

  it("is deterministic: two builds are identical", () => {
    expect(buildCases()).toEqual(cases);
  });

  it("matches the committed log trees byte-for-byte, so regenerating leaves no diff", () => {
    for (const fixture of cases) {
      for (const [relative, content] of Object.entries(fixture.files)) {
        expect(readFileSync(join(FIXTURES, fixture.id, relative), "utf8")).toBe(content);
      }
    }
  });

  it("has a hand-written expected.json and README.md for every case", () => {
    for (const fixture of cases) {
      expect(existsSync(join(FIXTURES, fixture.id, "expected.json"))).toBe(true);
      expect(existsSync(join(FIXTURES, fixture.id, "README.md"))).toBe(true);
    }
  });

  it("leaves the trailing fragment in case 03 run-1 without a newline", () => {
    const fixture = cases.find((c) => c.id === "03-trailing-fragment")!;
    const run1 = fixture.files[sessionPath("run-1", "s03")]!;
    expect(run1.endsWith("\n")).toBe(false);
  });

  it("makes case 02 run-1 a strict prefix of run-2", () => {
    const fixture = cases.find((c) => c.id === "02-split-across-runs")!;
    const run1 = fixture.files[sessionPath("run-1", "s02")]!;
    const run2 = fixture.files[sessionPath("run-2", "s02")]!;
    expect(run2.startsWith(run1)).toBe(true);
    expect(run2.length).toBeGreaterThan(run1.length);
  });

  it("uses only placeholder paths, never a real home directory", () => {
    const text = cases.flatMap((fixture) => Object.values(fixture.files)).join("");
    expect(text).not.toMatch(/\/Users\/|\/home\//);
  });
});

describe("writeCase and main", () => {
  it("replaces generated trees but keeps hand-written files", () => {
    const root = mkdtempSync(join(tmpdir(), "aua-fixtures-test-"));
    const caseDir = join(root, "01-x");
    mkdirSync(join(caseDir, "run-1", "stale"), { recursive: true });
    writeFileSync(join(caseDir, "run-1", "stale", "old.jsonl"), "old\n");
    writeFileSync(join(caseDir, "expected.json"), "{}");
    writeFileSync(join(caseDir, "README.md"), "# x");
    writeCase(root, { id: "01-x", files: { "projects/p/s.jsonl": "new\n" } });
    expect(existsSync(join(caseDir, "run-1"))).toBe(false);
    expect(readFileSync(join(caseDir, "projects/p/s.jsonl"), "utf8")).toBe("new\n");
    expect(readFileSync(join(caseDir, "expected.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(caseDir, "README.md"), "utf8")).toBe("# x");
  });

  it("writes every case and prints one summary line", () => {
    const root = mkdtempSync(join(tmpdir(), "aua-fixtures-main-"));
    const printed: string[] = [];
    const ids = main(root, (line) => printed.push(line));
    expect(ids).toEqual(buildCases().map((fixture) => fixture.id));
    expect(readdirSync(root).sort()).toEqual([...ids].sort());
    expect(printed).toEqual([`generated ${ids.length} fixture cases in ${root}`]);
  });
});
