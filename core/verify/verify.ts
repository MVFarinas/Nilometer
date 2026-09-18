/**
 * @file `nilometer verify`: check a user's own numbers against ccusage, on their own machine.
 *
 * The audit compares Nilometer against ccusage on committed fixtures (check A7), which proves the
 * reading rules on data everyone can see. It cannot prove them on anyone's real logs. This runs the
 * same comparison where the logs actually are, and reports a verdict and any differing days —
 * never a path, a repository name, a session id, or anything a prompt was in — so the result can be
 * sent to someone without sending the data (D-064).
 *
 * Two deliberate limits:
 * - **Tokens, not cost.** Cost depends on both tools' price tables agreeing; a model with no price
 *   row here would report a difference that is not a reading mistake.
 * - **Only days both sides can see.** Ingestion keeps raw lines after Claude Code deletes a log
 *   (D-002), so Nilometer legitimately holds days ccusage cannot read. Those are counted and
 *   explained, never reported as differences.
 */
import { spawnSync } from "node:child_process";

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Db } from "../db/database.js";
import { commandFound, invocation } from "../util/commands.js";
import {
  type CcusageDaily,
  type Difference,
  type Field,
  type TotalsByDayModel,
  dayOf,
  diffTotals,
  normalizeCcusage,
} from "./compare.js";

/** The fields compared: tokens only, for the reason in this file's header. */
export const VERIFIED_FIELDS: readonly Field[] = ["input", "output", "cache_read", "cache_write"];

/** What `verify` found. */
export interface VerifyResult {
  /** Days both sides could read, and so actually compared. */
  readonly comparedDays: number;
  /** Day-and-model pairs compared. */
  readonly comparedKeys: number;
  /** Days only Nilometer has, because the logs behind them are gone from disk (D-002). */
  readonly daysOnlyOurs: number;
  /** Days only ccusage reported, which would mean lines this tool did not read. */
  readonly daysOnlyTheirs: number;
  /** Differing fields, within the compared days. */
  readonly differences: readonly Difference[];
  /** Models Nilometer has no price row for; they do not affect a token comparison. */
  readonly unpricedModels: readonly string[];
  /** Requests left out because the log they came from is gone from disk (D-002). */
  readonly fromDeletedLogs: number;
}

/** Nilometer's own totals, and what had to be left out of them. */
export interface OurTotals {
  /** Totals keyed by `"<day>|<model>"`, from requests whose log is still on disk. */
  readonly totals: TotalsByDayModel;
  /** Requests skipped because the log they came from is gone, so ccusage cannot see them. */
  readonly fromDeletedLogs: number;
}

/**
 * Reads Nilometer's own per-day, per-model token totals, from logs that still exist.
 *
 * Ingestion keeps raw lines after Claude Code deletes a log (D-002), which is the point of the
 * database. ccusage reads the files that are there now. Comparing a request whose log is gone
 * against a tool that cannot see it reports a difference that is the design working: on a real
 * machine that was 23 of 79 files and 1,281 requests, enough to bury any real fault. So those
 * requests are excluded and counted instead.
 * @param db - Open, migrated database.
 * @param exists - Whether a path is on disk; injected so tests need no filesystem.
 * @returns Totals for responses ccusage can still see, and how many were left out.
 */
export function ourTotals(db: Db, exists: (path: string) => boolean = existsSync): OurTotals {
  // Which logs are still on disk. ccusage reads those; the database also holds ones it can't.
  const files = db
    .prepare("SELECT id, root, relative_path AS relativePath FROM source_files")
    .all() as {
    id: number;
    root: string;
    relativePath: string;
  }[];
  db.exec("CREATE TEMP TABLE IF NOT EXISTS verify_present_files (id INTEGER PRIMARY KEY)");
  db.exec("DELETE FROM verify_present_files");
  const remember = db.prepare("INSERT INTO verify_present_files (id) VALUES (?)");
  for (const file of files) {
    if (exists(join(file.root, file.relativePath))) {
      remember.run(file.id);
    }
  }

  // A response counts if ANY copy of it is still on disk, not just the copy dedup kept. One
  // response is written to several lines and sometimes several files, and the largest-output
  // winner can sit in a file that has since gone while a surviving copy is what ccusage reads.
  // On a real machine that was 802 responses: excluding them made this tool look short by a third
  // of a day.
  const visible = `
    SELECT DISTINCT r.raw_line_id, r.dedup_key
      FROM requests r
      JOIN raw_lines l ON l.id = r.raw_line_id
     WHERE l.source_file_id IN (SELECT id FROM verify_present_files)`;
  const rows = db
    .prepare(
      `WITH visible AS (${visible})
       SELECT substr(d.timestamp_utc, 1, 10) AS day, d.model,
              SUM(d.input_tokens) AS input, SUM(d.output_tokens) AS output,
              SUM(d.cache_read_tokens) AS cache_read,
              SUM(COALESCE(d.cache_write_5m_tokens, 0) + COALESCE(d.cache_write_1h_tokens, 0)
                  + COALESCE(d.cache_write_unsplit_tokens, 0)) AS cache_write
         FROM requests_dedup d
        WHERE d.timestamp_utc IS NOT NULL
          AND (d.raw_line_id IN (SELECT raw_line_id FROM visible)
               OR (d.dedup_key IS NOT NULL
                   AND d.dedup_key IN (SELECT dedup_key FROM visible WHERE dedup_key IS NOT NULL)))
        GROUP BY day, d.model`,
    )
    .all() as {
    day: string;
    model: string;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  }[];

  const gone = db
    .prepare(
      `WITH visible AS (${visible})
       SELECT COUNT(*) AS n FROM requests_dedup d
        WHERE d.raw_line_id NOT IN (SELECT raw_line_id FROM visible)
          AND (d.dedup_key IS NULL
               OR d.dedup_key NOT IN (SELECT dedup_key FROM visible WHERE dedup_key IS NOT NULL))`,
    )
    .get() as { n: number };

  const totals: TotalsByDayModel = {};
  for (const row of rows) {
    totals[`${row.day}|${row.model}`] = {
      input: row.input,
      output: row.output,
      cache_read: row.cache_read,
      cache_write: row.cache_write,
      // Not compared; present so the shape matches.
      cost_usd: 0,
    };
  }
  return { totals, fromDeletedLogs: gone.n };
}

/**
 * Lists models with requests but no price row, so the report can say the comparison ignored them.
 * @param db - Open, migrated database.
 * @returns Model names, sorted.
 */
export function unpricedModels(db: Db): string[] {
  return (
    db.prepare("SELECT DISTINCT model FROM unpriced_requests ORDER BY model").all() as {
      model: string;
    }[]
  ).map((row) => row.model);
}

/**
 * Compares Nilometer's totals against ccusage's, over the days both sides can see.
 * @param ours - From {@link ourTotals}.
 * @param theirs - From `normalizeCcusage`.
 * @param unpriced - From {@link unpricedModels}.
 * @returns What matched, what didn't, and what could not be compared.
 */
export function compareTotals(
  ours: OurTotals,
  theirs: TotalsByDayModel,
  unpriced: readonly string[] = [],
): VerifyResult {
  const ourTotalsByKey = ours.totals;
  const ourDays = new Set(Object.keys(ourTotalsByKey).map(dayOf));
  const theirDays = new Set(Object.keys(theirs).map(dayOf));
  const shared = new Set([...ourDays].filter((day) => theirDays.has(day)));

  /**
   * Keeps only the entries on days both sides can see.
   * @param totals - One side's totals.
   * @returns The same totals, restricted to shared days.
   */
  const onSharedDays = (totals: TotalsByDayModel): TotalsByDayModel =>
    Object.fromEntries(Object.entries(totals).filter(([key]) => shared.has(dayOf(key))));

  const oursShared = onSharedDays(ourTotalsByKey);
  const theirsShared = onSharedDays(theirs);
  return {
    comparedDays: shared.size,
    comparedKeys: new Set([...Object.keys(oursShared), ...Object.keys(theirsShared)]).size,
    daysOnlyOurs: [...ourDays].filter((day) => !theirDays.has(day)).length,
    daysOnlyTheirs: [...theirDays].filter((day) => !ourDays.has(day)).length,
    differences: diffTotals(oursShared, theirsShared, VERIFIED_FIELDS),
    unpricedModels: [...unpriced],
    fromDeletedLogs: ours.fromDeletedLogs,
  };
}

/** Everything {@link runVerify} needs, injected so tests never reach the network. */
export interface VerifyDeps {
  /** Runs ccusage and returns its stdout, or throws with a reason a user can act on. */
  readonly runCcusage: () => string;
  /** The open database to read Nilometer's own totals from. */
  readonly db: Db;
}

/**
 * Runs the comparison end to end.
 * @param deps - How to reach ccusage, and the database to read.
 * @returns What matched and what didn't.
 * @throws {Error} If ccusage cannot be run or its output cannot be parsed; the message says which.
 */
export function runVerify(deps: VerifyDeps): VerifyResult {
  const stdout = deps.runCcusage();
  let parsed: CcusageDaily;
  try {
    parsed = JSON.parse(stdout) as CcusageDaily;
  } catch {
    throw new Error("ccusage did not return JSON this understands; nothing was compared");
  }
  return compareTotals(ourTotals(deps.db), normalizeCcusage(parsed), unpricedModels(deps.db));
}

/** The ccusage release compared against; pinned so two runs compare the same way. */
export const CCUSAGE_VERSION = "20.0.20";

/**
 * Arguments for the pinned ccusage.
 * @returns `npx` arguments: pinned version, JSON, token-based pricing, offline, UTC days.
 */
export function ccusageArgs(): string[] {
  // --mode calculate ignores legacy costUSD fields; --offline freezes its embedded price table.
  return [
    "-y",
    `ccusage@${CCUSAGE_VERSION}`,
    "claude",
    "daily",
    "--json",
    "--mode",
    "calculate",
    "--offline",
    "-z",
    "UTC",
    "--breakdown",
  ];
}

/** What one ccusage run returned. */
export interface CcusageRun {
  /** Exit status; anything but 0 is a failure. */
  readonly status: number | null;
  /** Standard output. */
  readonly stdout: string;
  /** Standard error, used for the failure message. */
  readonly stderr: string;
}

/** Injected so the failure paths can be tested without npx or the network. */
export interface CcusageRunDeps {
  /** Whether a command can be started; defaults to the real lookup. */
  readonly found?: (command: string) => boolean;
  /** Runs npx with the given arguments; defaults to the real spawn. */
  readonly run?: (args: readonly string[]) => CcusageRun;
}

/**
 * Spawns a command and collects what it returned, the Windows-safe way (D-051).
 *
 * With its default command this is the one thing in the installed tool that reaches the network,
 * because `npx` fetches ccusage. The command is a parameter so the plumbing — quoting, encoding,
 * status, stderr — can be proven against a local process instead of the network.
 * @param args - Arguments for the command.
 * @param command - What to run; defaults to npx.
 * @returns What it returned.
 */
export function spawnCollecting(args: readonly string[], command = "npx"): CcusageRun {
  const started = invocation(command, args);
  const result = spawnSync(started.command, started.args, {
    shell: started.shell,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

/**
 * Runs the pinned ccusage and returns its stdout.
 *
 * This is the one thing in the installed tool that uses the network: `npx` fetches ccusage if it
 * isn't cached. Nothing else in Nilometer does, and `verify` is the only command that calls it.
 * @param deps - Injected lookup and spawn, so the failure paths are testable offline.
 * @returns ccusage's stdout.
 * @throws {Error} If npx can't be found or ccusage exits non-zero, with what it printed.
 */
export function runCcusage(deps: CcusageRunDeps = {}): string {
  const found = deps.found ?? commandFound;
  // The function itself, not a wrapper: a wrapper would be a branch nothing offline can reach.
  const run = deps.run ?? spawnCollecting;
  if (!found("npx")) {
    throw new Error("npx was not found, so ccusage could not be run; nothing was compared");
  }
  const result = run(ccusageArgs());
  if (result.status !== 0) {
    const reason = (result.stderr || "no output").trim().split("\n")[0];
    throw new Error(`ccusage could not be run (${reason}); nothing was compared`);
  }
  return result.stdout;
}
