/**
 * @file Unit tests for core/verify/verify.ts (D-064). ccusage is never run here: the runner is
 * injected, so these tests need no network and no npx.
 */
import { describe, expect, it } from "vitest";

import { type CcusageDaily, normalizeCcusage } from "../../../../core/verify/compare.js";
import {
  type OurTotals,
  ccusageArgs,
  compareTotals,
  ourTotals,
  runCcusage,
  runVerify,
  spawnCollecting,
  unpricedModels,
} from "../../../../core/verify/verify.js";
import { ingest, request } from "../metrics/helpers.js";

/**
 * Builds ccusage-shaped JSON for one day and model.
 * @param date - The day.
 * @param model - Model name.
 * @param out - Output tokens; the other fields are zero.
 * @returns ccusage's daily shape.
 */
function theirs(date: string, model: string, out: number): string {
  return JSON.stringify({
    daily: [
      {
        date,
        modelBreakdowns: [
          {
            modelName: model,
            inputTokens: 0,
            outputTokens: out,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cost: 0,
          },
        ],
      },
    ],
  });
}

/**
 * Wraps totals in the shape compareTotals takes.
 * @param totals - Keyed totals.
 * @param fromDeletedLogs - Responses excluded.
 * @returns Our side of the comparison.
 */
function ours(totals: Record<string, number>, fromDeletedLogs = 0): OurTotals {
  return {
    totals: Object.fromEntries(
      Object.entries(totals).map(([key, output]) => [
        key,
        { input: 0, output, cache_read: 0, cache_write: 0, cost_usd: 0 },
      ]),
    ),
    fromDeletedLogs,
  };
}

describe("ccusageArgs", () => {
  it("pins the version and asks for offline, token-priced, UTC days per model", () => {
    const args = ccusageArgs();
    expect(args[1]).toMatch(/^ccusage@\d+\.\d+\.\d+$/);
    for (const flag of ["--json", "--offline", "--breakdown", "calculate", "UTC"]) {
      expect(args).toContain(flag);
    }
  });
});

describe("compareTotals", () => {
  it("reports nothing when both sides agree", () => {
    const result = compareTotals(
      ours({ "2026-09-01|m": 10 }),
      { "2026-09-01|m": { input: 0, output: 10, cache_read: 0, cache_write: 0, cost_usd: 0 } },
      [],
      "2026-09-30",
    );
    expect(result.differences).toEqual([]);
    expect(result.comparedDays).toBe(1);
    expect(result.comparedKeys).toBe(1);
  });

  it("compares only days both sides can see, and counts the rest", () => {
    // Ingestion keeps logs Claude Code deleted (D-002), so days only this tool has are expected
    // and must not be reported as differences. A day only ccusage has is the opposite: lines
    // this tool did not read.
    const result = compareTotals(
      ours({ "2026-09-01|m": 10, "2026-08-01|m": 99 }),
      {
        "2026-09-01|m": { input: 0, output: 10, cache_read: 0, cache_write: 0, cost_usd: 0 },
        "2026-09-02|m": { input: 0, output: 7, cache_read: 0, cache_write: 0, cost_usd: 0 },
      },
      [],
      "2026-09-30",
    );
    expect(result.differences).toEqual([]);
    expect(result.comparedDays).toBe(1);
    expect(result.daysOnlyOurs).toBe(1);
    expect(result.daysOnlyTheirs).toBe(1);
  });

  it("names the field, and both values, for a real difference", () => {
    const result = compareTotals(
      ours({ "2026-09-01|m": 10 }),
      { "2026-09-01|m": { input: 0, output: 12, cache_read: 0, cache_write: 0, cost_usd: 0 } },
      [],
      "2026-09-30",
    );
    expect(result.differences).toEqual([
      { key: "2026-09-01|m", field: "output", ours: 10, theirs: 12 },
    ]);
  });

  it("never compares cost, because two price tables are a different question", () => {
    const result = compareTotals(
      ours({ "2026-09-01|m": 10 }),
      { "2026-09-01|m": { input: 0, output: 10, cache_read: 0, cache_write: 0, cost_usd: 999 } },
      [],
      "2026-09-30",
    );
    expect(result.differences).toEqual([]);
  });
});

describe("ourTotals", () => {
  it("counts a response whose log is gone, and leaves it out of the totals", () => {
    const db = ingest({
      "-p/s.jsonl": [
        request("s1", "u1", null, "2026-09-02T10:00:00Z", {
          usage: { output_tokens: 5, input_tokens: 0 },
        }),
      ],
    });
    // Present: the totals carry it.
    expect(ourTotals(db, () => true).totals["2026-09-02|claude-sonnet-5"]?.output).toBe(5);
    expect(ourTotals(db, () => true).fromDeletedLogs).toBe(0);
    // Gone: it is counted, not compared. ccusage cannot see it, so comparing it proves nothing.
    const absent = ourTotals(db, () => false);
    expect(absent.totals).toEqual({});
    expect(absent.fromDeletedLogs).toBe(1);
  });

  it("names models with no price row, so the report can say the comparison ignores them", () => {
    const db = ingest({
      "-p/s.jsonl": [
        request("s1", "u1", null, "2026-09-02T10:00:00Z", {
          usage: { output_tokens: 5, input_tokens: 0 },
        }),
      ],
    });
    expect(unpricedModels(db)).toEqual([]);
    // A model with no price row is unpriced, never zero (D-020). It still has tokens, so a token
    // comparison is unaffected — which is what the report says.
    const unknown = ingest({
      "-p/s.jsonl": [
        request("s1", "u1", null, "2026-09-02T10:00:00Z", {
          model: "claude-not-in-the-price-table",
          usage: { output_tokens: 5, input_tokens: 0 },
        }),
      ],
    });
    expect(unpricedModels(unknown)).toEqual(["claude-not-in-the-price-table"]);
  });
});

describe("compareTotals and today", () => {
  it("never compares the current day, because both sides are still being written", () => {
    // Ingestion is a snapshot; Claude Code keeps writing after it. On real data this was the whole
    // of the remaining difference, and it was the clock (D-064).
    const result = compareTotals(
      ours({ "2026-09-30|m": 10 }),
      { "2026-09-30|m": { input: 0, output: 99, cache_read: 0, cache_write: 0, cost_usd: 0 } },
      [],
      "2026-09-30",
    );
    expect(result.comparedDays).toBe(0);
    expect(result.differences).toEqual([]);
    expect(result.skippedToday).toBe("2026-09-30");
  });
});

describe("runVerify", () => {
  it("compares the injected ccusage output against the database", () => {
    const db = ingest({
      "-p/s.jsonl": [
        request("s1", "u1", null, "2026-09-02T10:00:00Z", {
          usage: { output_tokens: 5, input_tokens: 0 },
        }),
      ],
    });
    const same = runVerify({ db, runCcusage: () => theirs("2026-09-02", "claude-sonnet-5", 5) });
    expect(same.differences).toEqual([]);
    const different = runVerify({
      db,
      runCcusage: () => theirs("2026-09-02", "claude-sonnet-5", 6),
    });
    expect(different.differences).toHaveLength(1);
  });

  it("says so when ccusage returns something it cannot read", () => {
    const db = ingest({});
    expect(() => runVerify({ db, runCcusage: () => "not json" })).toThrow(/did not return JSON/);
  });

  it("normalizes ccusage's own shape the same way the audit does", () => {
    // The same function the fixture comparison uses, so the two can't drift apart.
    expect(normalizeCcusage(JSON.parse(theirs("2026-09-02", "m", 5)) as CcusageDaily)).toEqual({
      "2026-09-02|m": { input: 0, output: 5, cache_read: 0, cache_write: 0, cost_usd: 0 },
    });
  });
});

describe("runCcusage", () => {
  it("says npx is missing rather than failing obscurely", () => {
    expect(() => runCcusage({ found: () => false })).toThrow(/npx was not found/);
  });

  it("reports ccusage's own first line of error, and compares nothing", () => {
    expect(() =>
      runCcusage({
        found: () => true,
        run: () => ({ status: 1, stdout: "", stderr: "network unreachable\nstack line\n" }),
      }),
    ).toThrow(/ccusage could not be run \(network unreachable\); nothing was compared/);
  });

  it("says so when it fails with no output at all", () => {
    expect(() =>
      runCcusage({ found: () => true, run: () => ({ status: null, stdout: "", stderr: "" }) }),
    ).toThrow(/no output/);
  });

  it("returns stdout when it succeeds", () => {
    expect(
      runCcusage({ found: () => true, run: () => ({ status: 0, stdout: "{}", stderr: "" }) }),
    ).toBe("{}");
  });
});

describe("spawnCollecting", () => {
  it("collects stdout, stderr and status from a real process, without the network", () => {
    // Proves the plumbing runCcusage depends on: quoting, utf8 decoding, status, stderr. The
    // default command is npx, which would download ccusage; this runs node instead.
    const ok = spawnCollecting(["-e", "process.stdout.write('hello')"], process.execPath);
    expect(ok).toEqual({ status: 0, stdout: "hello", stderr: "" });

    const bad = spawnCollecting(
      ["-e", "process.stderr.write('nope'); process.exit(3)"],
      process.execPath,
    );
    expect(bad.status).toBe(3);
    expect(bad.stderr).toBe("nope");
  });

  it("reports a command that cannot start as a failure, not a crash", () => {
    const missing = spawnCollecting(["--version"], "definitely-not-a-command-xyz");
    expect(missing.status).not.toBe(0);
  });
});
