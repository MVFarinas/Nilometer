/**
 * @file Combining machines end to end (D-101 to D-103, steps G7.1 to G7.3).
 *
 * Each "machine" is a home directory with its own fixture logs, its own Claude Code config and its own
 * database, sharing one folder as a sync provider would. The reference is independent of the export
 * code: one machine holding every machine's logs locally. Merging has to give that machine's views,
 * in any order, without storing a line twice, and never take another account's records.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { type Db, openDatabase } from "../../../../core/db/database.js";
import { DATABASE_FILE, runIngestCommand } from "../../../../core/ingest/command.js";
import { SPOOL_FILE } from "../../../../core/ingest/ingest.js";
import { FOLDER_DIR, MACHINE_FILE } from "../../../../core/machines/folder.js";
import { readThisMachine, setFolder } from "../../../../core/machines/machines.js";
import { loadHtmlData } from "../../../../viewer/html-data.js";
import { renderHtmlReport } from "../../../../viewer/html.js";
import { loadObserved, loadProjected } from "../../../../viewer/queries.js";
import { LABELS, renderObserved, renderProjected } from "../../../../viewer/render.js";
import { ROOT, epoch, hit, request, toolResult, user } from "../metrics/helpers.js";

/** The account every machine but one is logged in to. */
const ACCOUNT = "11111111-2222-4333-8444-555555555555";

/**
 * A fixed clock.
 * @returns 2026-09-20T00:00:00Z.
 */
const now = (): Date => new Date("2026-09-20T00:00:00Z");

/** One simulated machine. */
interface Machine {
  /** Its home directory. */
  readonly home: string;
  /** Its data directory. */
  readonly dataDir: string;
}

/**
 * Spool lines for one session's readings, in the hook's format.
 * @param session - session_id.
 * @param readings - Capture time, five-hour percentage and reset, ISO-8601.
 * @returns The spool file's contents.
 */
function spool(session: string, readings: readonly [string, number, string][]): string {
  return readings
    .map(([at, used, resets]) => {
      const payload = {
        session_id: session,
        transcript_path: "/synthetic-root/transcripts/-fixture-demo/session.jsonl",
        cwd: "/synthetic-root/project",
        model: { id: "claude-sonnet-4-6", display_name: "Sonnet" },
        cost: { total_cost_usd: 0.5, total_duration_ms: 1000 },
        rate_limits: { five_hour: { used_percentage: used, resets_at: epoch(resets) } },
      };
      const line = {
        captured_at_s: epoch(at),
        hook_version: 1,
        payload_b64: Buffer.from(JSON.stringify(payload)).toString("base64"),
      };
      return `${JSON.stringify(line)}\n`;
    })
    .join("");
}

/**
 * A session whose limit hit is read through its parent links: a tool result, then an attachment line
 * the walk passes (D-021, D-076), the hit, and Claude Code's logged continuation after the reset
 * (D-077). Fixture logs don't link a hit to its parent this way.
 */
const LINKED = [
  user("link-s", "link-u", null, "2026-09-12T10:00:00Z"),
  request("link-s", "link-r", "link-u", "2026-09-12T10:00:05Z"),
  toolResult("link-s", "link-t", "link-r", "2026-09-12T10:00:10Z"),
  {
    type: "attachment",
    sessionId: "link-s",
    uuid: "link-a",
    parentUuid: "link-t",
    timestamp: "2026-09-12T10:00:20Z",
    attachment: { type: "total_tokens_reminder", text: "synthetic prompt" },
  },
  hit(
    "link-s",
    "link-h",
    "link-a",
    "2026-09-12T10:00:30Z",
    "You've hit your session limit · resets 11am (UTC)",
  ),
  user("link-s", "link-c", "link-h", "2026-09-12T11:00:02Z", {
    isMeta: true,
    origin: { kind: "auto-continuation" },
  }),
  request("link-s", "link-r2", "link-c", "2026-09-12T11:00:05Z"),
]
  .map((line) => `${JSON.stringify(line)}\n`)
  .join("");

/** Machine B's readings, in a session of its own. */
const B_SPOOL = spool("bbbbbbbb-0000-4000-8000-000000000001", [
  ["2026-09-12T10:00:00Z", 10, "2026-09-12T14:00:00Z"],
  ["2026-09-12T11:00:00Z", 25, "2026-09-12T14:00:00Z"],
  ["2026-09-12T12:00:00Z", 40, "2026-09-12T14:00:00Z"],
]);

/**
 * Makes a machine: a home with the given fixture cases' logs, an optional spool, and a Claude Code
 * config logged in to an account.
 * @param cases - Fixture cases whose logs this machine holds.
 * @param options - Its spool, and its account (null for none).
 * @param options.spool - Spool file contents.
 * @param options.account - The account ID; null writes no config.
 * @param options.logs - One more session log's contents, written beside the fixtures'.
 * @returns The machine.
 */
function machine(
  cases: readonly string[],
  options: { spool?: string; account?: string | null; logs?: string } = {},
): Machine {
  const home = mkdtempSync(join(tmpdir(), "aua-machine-"));
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  for (const id of cases) {
    cpSync(join(ROOT, "fixtures", id, "projects"), join(home, ".claude", "projects"), {
      recursive: true,
    });
  }
  if (options.logs !== undefined) {
    writeFileSync(
      join(home, ".claude", "projects", "-fixture-demo", "synthetic-links.jsonl"),
      options.logs,
    );
  }
  const dataDir = join(home, ".local", "share", "nilometer");
  mkdirSync(dataDir, { recursive: true });
  if (options.spool !== undefined) {
    writeFileSync(join(dataDir, SPOOL_FILE), options.spool);
  }
  const account = options.account === undefined ? ACCOUNT : options.account;
  if (account !== null) {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: account, emailAddress: "x@example.com" } }),
    );
  }
  return { home, dataDir };
}

/**
 * Opens a machine's database.
 * @param m - The machine.
 * @returns The open database; close it after use.
 */
function open(m: Machine): Db {
  return openDatabase(join(m.dataDir, DATABASE_FILE), join(ROOT, "core/schema"));
}

/**
 * Points a machine at a folder.
 * @param m - The machine.
 * @param folder - The shared folder.
 * @param label - Its name.
 */
function join_(m: Machine, folder: string, label: string): void {
  const db = open(m);
  try {
    setFolder(db, folder, label);
  } finally {
    db.close();
  }
}

/**
 * Runs one ingest on a machine, as `nilometer ingest` does.
 * @param m - The machine.
 * @returns The outcome.
 */
function ingest(m: Machine): ReturnType<typeof runIngestCommand> {
  return runIngestCommand({ home: m.home, env: {}, full: false, packageRoot: ROOT, now });
}

/** Every view a report or page reads, with columns that name a file, a path or a row left out. */
const VIEWS: Record<string, string> = {
  requests:
    "SELECT dedup_key, model, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_write_unsplit_tokens, speed, session_id, timestamp_utc, is_sidechain FROM requests_dedup ORDER BY dedup_key, timestamp_utc",
  readings:
    "SELECT window, reset_at_utc, used_percentage, session_id, captured_at_s, observed_at_utc, observed_via, after_reset, stale FROM window_readings ORDER BY 1, 2, 5, 4",
  byModel: "SELECT * FROM obs_usage_by_model ORDER BY model",
  limitHits: "SELECT * FROM obs_limit_hits",
  lockouts:
    "SELECT interval_number, locked_from_utc, locked_until_utc, hits, next_request_at_utc, lockout_seconds, auto_continuations, sessions, refused_requests FROM obs_lockout_intervals ORDER BY 1",
  lockoutTime: "SELECT * FROM obs_lockout_time",
  notResumed: "SELECT * FROM obs_sessions_not_resumed",
  midTask: "SELECT * FROM obs_mid_task_interruptions",
  peaks:
    "SELECT window, reset_at_utc, peak_used_percentage, peak_reading_at_utc, readings, window_open FROM obs_window_peak ORDER BY 1, 2",
  listPrice: "SELECT * FROM proj_api_list_price",
  burnRate: "SELECT * FROM proj_burn_rate ORDER BY 1, 2, 3",
  coverage: "SELECT * FROM source_coverage",
  classes: "SELECT class, COUNT(*) AS n FROM parsed_lines GROUP BY 1 ORDER BY 1",
  events:
    "SELECT class, error, window, reset_text, reset_at_utc, quota_window, quota_resets_at_utc, fallback_model, COUNT(*) AS n FROM events GROUP BY 1, 2, 3, 4, 5, 6, 7, 8 ORDER BY 1, 2, 3, 4, 5, 6, 7, 8",
  problems: "SELECT problem, COUNT(*) AS n FROM line_problems GROUP BY 1 ORDER BY 1",
  positions:
    "SELECT session_id, position, attachments_passed FROM logged_limit_hits ORDER BY session_id, timestamp_utc",
  continuations: "SELECT session_id, continued_at_utc FROM auto_continuation_marks ORDER BY 1, 2",
};

/**
 * Reads every view in {@link VIEWS}.
 * @param m - The machine.
 * @returns Each view's rows.
 */
function views(m: Machine): Record<string, unknown[]> {
  const db = open(m);
  try {
    return Object.fromEntries(
      Object.entries(VIEWS).map(([name, sql]) => [name, db.prepare(sql).all()]),
    );
  } finally {
    db.close();
  }
}

/**
 * Reads a machine's per-machine usage rows.
 * @param m - The machine.
 * @returns Label, whether it's this machine, requests and share, by machine.
 */
function byMachine(m: Machine): { label: string; own: number; requests: number; share: number }[] {
  const db = open(m);
  try {
    return db
      .prepare(
        "SELECT o.machine_label AS label, o.is_this_machine AS own, o.requests, p.share_of_recorded AS share FROM obs_usage_by_machine o JOIN proj_api_list_price_by_machine p USING (machine_id) ORDER BY label",
      )
      .all() as { label: string; own: number; requests: number; share: number }[];
  } finally {
    db.close();
  }
}

/**
 * Makes an empty shared folder.
 * @returns Its path.
 */
function folder(): string {
  return mkdtempSync(join(tmpdir(), "aua-synced-"));
}

/** Machine A's logs: streaming snapshots, limit hits, quota fields. */
const A_CASES = ["01-streaming-snapshots", "08-limit-hits", "20-limit-quota-fields"];
/** Machine B's logs: mixed models, retry notices, a subagent file. */
const B_CASES = ["06-mixed-models", "15-retry-notices", "11-subagent-file"];
/** Machine E's logs: report edges and a model fallback. */
const E_CASES = ["17-report-edges", "22-model-refusal-fallback"];

describe("combining machines", () => {
  it("gives each machine the views of one machine holding every machine's logs", () => {
    const shared = folder();
    const a = machine(A_CASES);
    const b = machine(B_CASES, { spool: B_SPOOL, logs: LINKED });
    join_(a, shared, "Desk");
    join_(b, shared, "Laptop");
    ingest(a);
    const bOutcome = ingest(b);
    const aOutcome = ingest(a);
    const reference = machine([...A_CASES, ...B_CASES], { spool: B_SPOOL, logs: LINKED });
    ingest(reference);
    expect(views(a)).toEqual(views(reference));
    // The linked session's hit is read as mid-task through the attachment on both, and continued.
    expect(views(a)["positions"]).toContainEqual({
      session_id: "link-s",
      position: "mid_task",
      attachments_passed: 1,
    });
    expect(views(a)["continuations"]).toHaveLength(1);
    expect(views(b)).toEqual(views(reference));
    expect(aOutcome.machines).toMatchObject({
      kind: "done",
      imported: { machines: [{ label: "Laptop", status: "merged" }], ignored: 0 },
    });
    expect(bOutcome.machines).toMatchObject({
      kind: "done",
      imported: { machines: [{ label: "Desk", status: "merged" }] },
    });
    // Shares of recorded usage, by machine, adding up to 1 on both machines.
    const shares = byMachine(a);
    expect(shares.map((r) => [r.label, r.own])).toEqual([
      ["Desk", 1],
      ["Laptop", 0],
    ]);
    expect(shares.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1, 12);
    expect(byMachine(b).map((r) => [r.label, r.own, r.requests])).toEqual(
      shares.map((r) => [r.label, 1 - r.own, r.requests]),
    );
  });

  it("gives the same views whichever machine is read first", () => {
    const b = machine(B_CASES, { spool: B_SPOOL });
    const e = machine(E_CASES);
    const exports = folder();
    join_(b, exports, "B");
    join_(e, exports, "E");
    ingest(b);
    ingest(e);
    const ids = readdirSync(join(exports, FOLDER_DIR));
    const orders = [ids, [...ids].reverse()];
    const results = orders.map((order) => {
      const a = machine(A_CASES);
      const shared = folder();
      join_(a, shared, "A");
      // One machine's files arrive, an ingest runs, then the other's: as a sync provider might deliver them.
      for (const id of order) {
        cpSync(join(exports, FOLDER_DIR, id), join(shared, FOLDER_DIR, id), { recursive: true });
        ingest(a);
      }
      return views(a);
    });
    const reference = machine([...A_CASES, ...B_CASES, ...E_CASES], { spool: B_SPOOL });
    ingest(reference);
    expect(results[0]).toEqual(views(reference));
    expect(results[1]).toEqual(results[0]);
  });

  it("stores nothing twice when a machine writes its export again, or comes back with a new database", () => {
    const shared = folder();
    const a = machine(A_CASES);
    const b = machine(B_CASES, { spool: B_SPOOL });
    join_(a, shared, "A");
    join_(b, shared, "B");
    ingest(b);
    ingest(a);
    const before = views(a);
    // B's files are deleted from the folder; its next ingest writes every month again.
    const db = open(b);
    const bId = readThisMachine(db)?.machineId ?? "";
    db.close();
    rmSync(join(shared, FOLDER_DIR, bId), { recursive: true });
    ingest(b);
    expect(ingest(a).machines).toMatchObject({
      imported: { machines: [{ status: "merged", linesStored: 0 }] },
    });
    // B's database is deleted: it comes back as a new machine with the same lines.
    rmSync(join(b.dataDir, DATABASE_FILE));
    join_(b, shared, "B again");
    ingest(b);
    const again = ingest(a);
    expect(again.machines).toMatchObject({ kind: "done" });
    const found = again.machines.kind === "done" ? again.machines.imported.machines : [];
    expect(found.map((m) => [m.label, m.linesStored])).toEqual(
      expect.arrayContaining([
        ["B", 0],
        ["B again", 0],
      ]),
    );
    expect(views(a)).toEqual(before);
  });

  it("refuses another account's machine, a forged or newer description, and ignores debris", () => {
    const shared = folder();
    const a = machine(A_CASES);
    const other = machine(B_CASES, { account: "99999999-2222-4333-8444-555555555555" });
    join_(a, shared, "A");
    join_(other, shared, "Someone else");
    ingest(other);
    ingest(a);
    const alone = machine(A_CASES);
    ingest(alone);
    // Another account's lines are never merged.
    expect(views(a)).toEqual(views(alone));
    const base = join(shared, FOLDER_DIR);
    const otherId = readdirSync(base).find((name) =>
      readFileSync(join(base, name, MACHINE_FILE), "utf8").includes("Someone else"),
    );
    const info = JSON.parse(readFileSync(join(base, otherId ?? "", MACHINE_FILE), "utf8")) as {
      accountHash: string;
    };
    const aInfo = readdirSync(base)
      .filter((name) => name !== otherId)
      .map(
        (name) =>
          JSON.parse(readFileSync(join(base, name, MACHINE_FILE), "utf8")) as {
            accountHash: string;
          },
      )[0];
    expect(info.accountHash).not.toBe(aInfo?.accountHash);
    // A description naming another machine than its folder, and one from a newer format.
    const forged = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const newer = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
    for (const [id, body] of [
      [forged, { ...aInfo, format: 1, machineId: newer, label: "Forged" }],
      [newer, { ...aInfo, format: 2, machineId: newer, label: "Newer" }],
    ] as const) {
      mkdirSync(join(base, id));
      writeFileSync(join(base, id, MACHINE_FILE), JSON.stringify(body));
    }
    // A machine that's merged, with debris beside its files.
    const debris = "aaaaaaaa-bbbb-4ccc-8ddd-000000000000";
    mkdirSync(join(base, debris));
    writeFileSync(
      join(base, debris, MACHINE_FILE),
      JSON.stringify({ ...aInfo, format: 1, machineId: debris, label: "Debris" }),
    );
    writeFileSync(join(base, debris, "logs-2026-09 (1).jsonl.gz"), gzipSync("x\n"));
    writeFileSync(join(base, debris, ".logs-2026-09.jsonl.gz.icloud"), "");
    writeFileSync(join(base, debris, "logs-2026-09.jsonl.gz"), gzipSync("{}\n").subarray(0, 8));
    writeFileSync(join(base, debris, "readings-2026-09.jsonl.gz"), gzipSync('{"no":"origin"}\n'));
    mkdirSync(join(base, "notes"));
    const outcome = ingest(a);
    expect(outcome.machines.kind === "done" && outcome.machines.imported).toMatchObject({
      // The truncated file, two names that aren't exports, and a folder that isn't a machine.
      ignored: 4,
    });
    const found = outcome.machines.kind === "done" ? outcome.machines.imported.machines : [];
    expect(Object.fromEntries(found.map((m) => [m.label ?? m.machineId, m.reason]))).toEqual({
      Debris: null,
      [forged]: "its machine.json names a different machine than its folder",
      [newer]: "it was written by a newer Nilometer (format 2); update this one",
      "Someone else": "it's logged in to a different Claude account",
    });
    expect(views(a)).toEqual(views(alone));
    const db = open(a);
    const rejected = db
      .prepare("SELECT detail FROM ingest_report WHERE problem = 'machine_line_rejected'")
      .all();
    db.close();
    expect(rejected).toEqual([
      { detail: "1 lines from another machine were too long or carried no origin; not stored" },
    ]);
  });

  it("writes nothing and merges nothing without an account, and says when the folder is gone", () => {
    const shared = folder();
    const a = machine(A_CASES);
    const loggedOut = machine(B_CASES, { account: null });
    join_(a, shared, "A");
    join_(loggedOut, shared, "Logged out");
    ingest(a);
    const outcome = ingest(loggedOut);
    expect(outcome.machines).toMatchObject({
      kind: "done",
      exported: { reason: "Claude Code's config file wasn't found" },
      imported: {
        machines: [
          {
            label: "A",
            status: "refused",
            reason: "this machine's account is unknown: Claude Code's config file wasn't found",
          },
        ],
      },
    });
    rmSync(shared, { recursive: true });
    expect(ingest(a).machines).toEqual({ kind: "folder_missing", folder: shared });
  });

  it("sends only allowlisted fields: no text, paths or working directories", () => {
    const shared = folder();
    const b = machine(B_CASES, { spool: B_SPOOL });
    join_(b, shared, "B");
    ingest(b);
    const [id] = readdirSync(join(shared, FOLDER_DIR));
    const dir = join(shared, FOLDER_DIR, id ?? "");
    const keys = new Set<string>();
    /**
     * Collects every key path in a value.
     * @param value - The value.
     * @param path - Its path so far.
     */
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item) => walk(item, `${path}[]`));
      } else if (typeof value === "object" && value !== null) {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(`${path}.${key}`);
          walk(inner, `${path}.${key}`);
        }
      }
    };
    let text = "";
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".gz"))) {
      const lines = gunzipSync(readFileSync(join(dir, name))).toString("utf8");
      text += lines;
      for (const line of lines.split("\n").filter((l) => l !== "")) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        walk(parsed, name.startsWith("logs") ? "log" : "spool");
        if (typeof parsed["payload_b64"] === "string") {
          walk(
            JSON.parse(Buffer.from(parsed["payload_b64"], "base64").toString("utf8")),
            "payload",
          );
        }
      }
    }
    // Nothing a person or a model wrote, and no path.
    for (const canary of [
      "synthetic prompt",
      "synthetic reply",
      "/synthetic-root",
      "-fixture-demo",
      "cwd",
    ]) {
      expect(text).not.toContain(canary);
    }
    const allowed =
      /^(log\.(type|subtype|sessionId|timestamp|version|isSidechain|uuid|parentUuid|isMeta|isApiErrorMessage|apiErrorStatus|requestId|originalModel|fallbackModel|apiRefusalCategory|nilometerLine|error(\.(status|isNetworkDown|rateLimits))?|quotaLimits(\.(rateLimitType|resetsAt))?|origin(\.kind)?|attachment(\.(type|commandMode))?|message(\.(id|model|usage(\..+)?|content(\[\]\.type)?))?)|spool\.(captured_at_s|hook_version|payload_b64|nilometerLine)|payload\.(session_id|version|rate_limits(\..+)?|model(\.id)?|cost(\.total_cost_usd)?))$/;
    expect([...keys].filter((key) => !allowed.test(key))).toEqual([]);
  });

  it("shows each machine in the text report and on the page, with the same numbers", () => {
    const shared = folder();
    const a = machine(A_CASES);
    const b = machine(B_CASES, { spool: B_SPOOL });
    join_(a, shared, "Desk");
    join_(b, shared, "Laptop");
    ingest(b);
    ingest(a);
    const db = open(a);
    try {
      const observed = loadObserved(db);
      const projected = loadProjected(db);
      expect(observed.combining).toBe(true);
      const text = [
        ...renderObserved(observed, "UTC"),
        ...renderProjected(projected, "UTC", observed.combining),
      ].join("\n");
      const data = loadHtmlData(db, { timeZone: "UTC", generatedAt: now() });
      const page = renderHtmlReport(data);
      for (const heading of [LABELS.byMachine, LABELS.apiListPriceByMachine, LABELS.elsewhere]) {
        expect(text).toContain(heading);
        expect(page).toContain(heading.replaceAll("'", "&#39;"));
      }
      // Number for number: each machine's requests and price, as both print them.
      expect(data.machines.map((m) => [m.label, m.isThisMachine, m.requests])).toEqual(
        observed.byMachine.map((m) => [m.machine_label, m.is_this_machine === 1, m.requests]),
      );
      expect(data.machinePrices.map((m) => m.listPriceUsd)).toEqual(
        projected.apiListPriceByMachine.map((m) => m.list_price_usd),
      );
      expect(text).toMatch(/Desk \(this machine\)/);
      expect(page).toContain("Desk (this machine)");
      // Every request is behind exactly one machine, and the page lists each one's requests.
      expect(data.machines.reduce((n, m) => n + m.events.length, 0)).toBe(
        observed.byMachine.reduce((n, m) => n + m.requests, 0),
      );
      // The other machine's requests have no repository here.
      expect(observed.byRepo.filter((r) => r.repo_kind === "other_machine")).toHaveLength(1);
      expect(text).toContain(LABELS.otherMachines);
    } finally {
      db.close();
    }
  });
});
