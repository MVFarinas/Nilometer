/**
 * @file Unit tests for the parts of core/machines that combine.test.ts doesn't reach end to end: the
 * account read, labels and descriptions, the scrub's edge cases, and setup and leaving (G7).
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { openDatabase } from "../../../../core/db/database.js";
import { claudeConfigPath, hashAccount, readAccount } from "../../../../core/machines/account.js";
import {
  FOLDER_DIR,
  cleanLabel,
  exportFileName,
  parseExportFileName,
  parseMachineInfo,
} from "../../../../core/machines/folder.js";
import { originOf } from "../../../../core/machines/import.js";
import {
  MachinesError,
  leaveFolder,
  readThisMachine,
  setFolder,
} from "../../../../core/machines/machines.js";
import {
  lineOrigin,
  scrubLine,
  scrubLogLine,
  scrubSpoolLine,
} from "../../../../core/machines/scrub.js";
import type { ObservedReport } from "../../../../viewer/queries.js";
import { latestWeekText } from "../../../../viewer/render.js";
import { ROOT } from "../metrics/helpers.js";

/**
 * A fresh in-memory database.
 * @returns The database.
 */
const fresh = () => openDatabase(":memory:", join(ROOT, "core/schema"));

describe("the account", () => {
  it("finds Claude Code's config in CLAUDE_CONFIG_DIR's first entry, else the home directory", () => {
    expect(claudeConfigPath({}, "/h")).toBe(join("/h", ".claude.json"));
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: " " }, "/h")).toBe(join("/h", ".claude.json"));
    expect(claudeConfigPath({ CLAUDE_CONFIG_DIR: "~/a, /b" }, "/h")).toBe(
      join("/h", "a", ".claude.json"),
    );
  });

  it("keeps only a hash, and says why there is none", () => {
    const ok = readAccount("x", () => JSON.stringify({ oauthAccount: { accountUuid: "u-1" } }));
    expect(ok).toEqual({ kind: "ok", accountHash: hashAccount("u-1") });
    expect(hashAccount("u-1")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAccount("u-1")).not.toBe(hashAccount("u-2"));
    expect(readAccount("x", () => "{")).toEqual({
      kind: "none",
      reason: "Claude Code's config file isn't valid JSON",
    });
    for (const text of ["[]", "{}", '{"oauthAccount":{"accountUuid":""}}', '{"oauthAccount":7}']) {
      expect(readAccount("x", () => text)).toEqual({
        kind: "none",
        reason: "Claude Code isn't logged in to a Claude account here",
      });
    }
  });
});

describe("the folder's names and descriptions", () => {
  it("names export files by kind and month, and reads back only those names", () => {
    expect(exportFileName("log", "2026-11")).toBe("logs-2026-11.jsonl.gz");
    expect(exportFileName("spool", "2026-11")).toBe("readings-2026-11.jsonl.gz");
    expect(parseExportFileName("readings-2026-11.jsonl.gz")).toEqual({
      kind: "spool",
      month: "2026-11",
    });
    for (const name of [
      "logs-2026-13.jsonl.gz",
      "logs-2026-11 (1).jsonl.gz",
      "logs-2026-11.jsonl",
    ]) {
      expect(parseExportFileName(name)).toBeNull();
    }
  });

  it("takes a label of 1 to 60 printable characters", () => {
    expect(cleanLabel("  Desk  ")).toBe("Desk");
    for (const bad of ["", "   ", "x".repeat(61), "a\u001b[2Jb"]) {
      expect(cleanLabel(bad)).toBeNull();
    }
  });

  it("refuses a description with any field missing or wrong", () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const good = {
      format: 1,
      machineId: id,
      label: "Desk",
      accountHash: "a".repeat(64),
      exportedAt: "2026-11-07T00:00:00Z",
      nilometerVersion: "0.3.0",
    };
    expect(parseMachineInfo(JSON.stringify(good), id)).toEqual({ kind: "ok", info: good });
    const reasons = [
      ["not json", "its machine.json isn't valid JSON"],
      ["[1]", "its machine.json isn't an object"],
      [JSON.stringify({ ...good, format: "1" }), "its machine.json has no format number"],
      [JSON.stringify({ ...good, label: " Desk" }), "its machine.json has no usable label"],
      [JSON.stringify({ ...good, label: 3 }), "its machine.json has no usable label"],
      [JSON.stringify({ ...good, accountHash: "x" }), "its machine.json has no account"],
      [JSON.stringify({ ...good, exportedAt: "soon" }), "its machine.json has no export time"],
      [
        JSON.stringify({ ...good, nilometerVersion: 1 }),
        "its machine.json has no Nilometer version",
      ],
    ];
    for (const [text, reason] of reasons) {
      expect(parseMachineInfo(text ?? "", id)).toEqual({ kind: "bad", reason });
    }
  });

  it("reads a line's origin only when it's 32 hex characters", () => {
    expect(originOf(Buffer.from(`{"nilometerLine":"${"0".repeat(32)}"}`))).toBe("0".repeat(32));
    for (const line of ["{", "[]", '{"nilometerLine":"xyz"}']) {
      expect(originOf(Buffer.from(line))).toBeNull();
    }
  });
});

describe("the scrub", () => {
  it("keeps structure and drops text, with odd field types kept as written but never as text", () => {
    expect(
      scrubLogLine({
        type: "user",
        cwd: "/srv/project",
        gitBranch: "secret-branch",
        message: { role: "user", content: [{ type: "tool_result", content: "output" }, "loose"] },
        origin: "typed",
        attachment: { type: "file", content: "file text", commandMode: "x" },
        quotaLimits: 5,
        toolUseResult: { stdout: "output" },
      }),
    ).toEqual({
      type: "user",
      message: { content: [{ type: "tool_result" }, null] },
      origin: "",
      attachment: { type: "file", commandMode: "x" },
      quotaLimits: 5,
    });
    expect(scrubLogLine({ message: "text" })).toEqual({ message: "" });
    expect(scrubLogLine({ message: 3 })).toEqual({ message: 3 });
    expect(scrubLogLine({ message: { content: 4 } })).toEqual({ message: { content: 4 } });
    expect(
      scrubLogLine({ error: { status: 429, formatted: "words", rateLimits: { a: 1 } } }),
    ).toEqual({
      error: { status: 429, rateLimits: {} },
    });
    expect(scrubLogLine({ error: { rateLimits: null } })).toEqual({ error: { rateLimits: null } });
    // Claude Code's own error notice keeps its text: it's where older hits wrote their reset.
    const notice = [{ type: "text", text: "You've hit your session limit · resets 6:10am" }];
    expect(
      scrubLogLine({ isApiErrorMessage: true, error: "rate_limit", message: { content: notice } }),
    ).toEqual({ isApiErrorMessage: true, error: "rate_limit", message: { content: notice } });
  });

  it("keeps a spool line's readings without its paths, and sends no undecodable line", () => {
    const payload = {
      session_id: "s",
      transcript_path: "/p",
      cwd: "/c",
      model: "m",
      rate_limits: {},
    };
    const line = Buffer.from(
      JSON.stringify({
        captured_at_s: 1,
        hook_version: 1,
        payload_b64: Buffer.from(JSON.stringify(payload)).toString("base64"),
      }),
    );
    const scrubbed = scrubSpoolLine(line);
    expect(
      JSON.parse(Buffer.from(String(scrubbed?.["payload_b64"]), "base64").toString("utf8")),
    ).toEqual({ session_id: "s", rate_limits: {}, model: "" });
    expect(scrubSpoolLine(Buffer.from("{"))).toBeNull();
    expect(scrubLine("spool", Buffer.from("{"), "o")).toBeNull();
    expect(scrubLine("log", Buffer.from("not json"), "o")).toBeNull();
    expect(JSON.parse(scrubLine("log", Buffer.from('{"type":"x"}'), "o") ?? "")).toEqual({
      type: "x",
      nilometerLine: "o",
    });
    expect(lineOrigin("a", "b")).toMatch(/^[0-9a-f]{32}$/);
    expect(lineOrigin("a", "b")).not.toBe(lineOrigin("a2", "b"));
  });
});

describe("setup and leaving", () => {
  it("names the machine once, keeps its ID, and refuses a missing folder or a bad name", () => {
    const db = fresh();
    const dir = mkdtempSync(join(tmpdir(), "aua-folder-"));
    expect(readThisMachine(db)).toBeNull();
    const first = setFolder(db, dir, undefined, () => "id-1");
    expect(first).toEqual({ machineId: "id-1", label: "This machine", folder: dir });
    expect(setFolder(db, dir, "Desk", () => "id-2")).toEqual({
      machineId: "id-1",
      label: "Desk",
      folder: dir,
    });
    expect(setFolder(db, dir, undefined).label).toBe("Desk");
    expect(() => setFolder(db, join(dir, "missing"), undefined)).toThrow(MachinesError);
    expect(() => setFolder(db, dir, "")).toThrow(
      "a machine's name must be 1 to 60 characters, with no control characters",
    );
  });

  it("leaves the folder, removing this machine's records only when asked", () => {
    const db = fresh();
    expect(leaveFolder(db, true)).toEqual({ folder: null, removed: null });
    const dir = mkdtempSync(join(tmpdir(), "aua-folder-"));
    setFolder(db, dir, "Desk", () => "id-1");
    expect(leaveFolder(db, false)).toEqual({ folder: dir, removed: null });
    expect(readThisMachine(db)?.folder).toBeNull();
    setFolder(db, dir, undefined);
    const own = join(dir, FOLDER_DIR, "id-1");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "machine.json"), "{}");
    expect(leaveFolder(db, true)).toEqual({ folder: dir, removed: own });
    expect(existsSync(own)).toBe(false);
  });

  it("says so when this machine's records can't be removed", () => {
    const db = fresh();
    const dir = mkdtempSync(join(tmpdir(), "aua-folder-"));
    setFolder(db, dir, "Desk", () => "id-1");
    expect(() => leaveFolder(db, true, () => false)).toThrow(
      `couldn't remove ${join(dir, FOLDER_DIR, "id-1")}; delete it by hand`,
    );
  });
});

describe("the latest weekly window's line", () => {
  it("names the window and the account's last reading in it, or nothing without one", () => {
    const row = {
      week_starts_at_utc: "2026-10-31T21:00:00.000Z",
      week_reset_at_utc: "2026-11-07T21:00:00.000Z",
    };
    const windows = [
      { window: "five_hour", reset_at_utc: row.week_reset_at_utc, last_used_percentage: 99 },
      { window: "seven_day", reset_at_utc: row.week_reset_at_utc, last_used_percentage: 46 },
    ] as unknown as ObservedReport["windows"];
    expect(latestWeekText(row, { windows }, "UTC")).toBe(
      "Latest weekly window: 2026-10-31 21:00 to 2026-11-07 21:00. The account's last reading in that window: 46%.",
    );
    expect(latestWeekText(undefined, { windows }, "UTC")).toBeNull();
    expect(latestWeekText({ ...row, week_reset_at_utc: null }, { windows }, "UTC")).toBeNull();
  });
});
