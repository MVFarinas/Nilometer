/**
 * @file A limit hit's position, looked up past attachment lines (D-076, step G2.3).
 *
 * One session per case, each written by hand. Expected positions follow D-021's rule at the line
 * the walk stops on, and D-076's classification of which attachment types it walks past
 * (`attachment_walk` in 022_attachment_walk.sql). `passed` is how many attachment lines it walked.
 *
 * | Session | Chain from the hit up | Position | Passed |
 * |---|---|---|---|
 * | s1 | total_tokens_reminder, tool result | mid_task | 1 |
 * | s2 | edited_text_file, queued_command (task notification), prompt | turn_start | 2 |
 * | s3 | queued_command typed by a human, tool result | unknown: a human message stops it | 0 |
 * | s4 | a type no one has classified, tool result | unknown: unlisted stops it | 0 |
 * | s5 | total_tokens_reminder, meta user line | unknown: D-021 leaves meta unknown | 1 |
 * | s6 | a parent uuid not in the logs | unknown | 0 |
 * | s7 | tool result, directly | mid_task, as D-021 always read it | 0 |
 * | s8 | two attachments that are each other's parent | unknown, stopped at 50 steps | 50 |
 */
import { describe, expect, it } from "vitest";

import { hit, ingest, request, toolResult, user } from "./helpers.js";

/** Every hit's text: a 5-hour limit reset an hour later. */
const LIMIT = "You've hit your session limit · resets 11am (UTC)";

/**
 * Builds an attachment line, as Claude Code writes one between a request and what it answered.
 * @param session - Session ID.
 * @param uuid - The line's uuid.
 * @param parent - Its parent's uuid.
 * @param attachment - The `attachment` object: its `type` and any fields the rule reads.
 * @returns The log line.
 */
function attachment(
  session: string,
  uuid: string,
  parent: string,
  attachment: Record<string, unknown>,
): object {
  return {
    type: "attachment",
    sessionId: session,
    uuid,
    parentUuid: parent,
    timestamp: "2026-09-01T10:00:20Z",
    attachment,
  };
}

/**
 * The opening request every session's chain starts from.
 * @param session - Session ID.
 * @returns A prompt and the request answering it.
 */
function opening(session: string): object[] {
  return [
    user(session, `${session}-u`, null, "2026-09-01T10:00:00Z"),
    request(session, `${session}-r`, `${session}-u`, "2026-09-01T10:00:05Z"),
  ];
}

describe("the position walk past attachment lines (D-076)", () => {
  const db = ingest({
    "-p/s1.jsonl": [
      ...opening("s1"),
      toolResult("s1", "s1-t", "s1-r", "2026-09-01T10:00:10Z"),
      attachment("s1", "s1-a", "s1-t", { type: "total_tokens_reminder", text: "x" }),
      hit("s1", "s1-h", "s1-a", "2026-09-01T10:00:30Z", LIMIT),
    ],
    "-p/s2.jsonl": [
      user("s2", "s2-u", null, "2026-09-01T10:00:00Z"),
      attachment("s2", "s2-q", "s2-u", {
        type: "queued_command",
        commandMode: "task-notification",
      }),
      attachment("s2", "s2-e", "s2-q", { type: "edited_text_file", filename: "f" }),
      hit("s2", "s2-h", "s2-e", "2026-09-01T10:00:30Z", LIMIT),
    ],
    "-p/s3.jsonl": [
      ...opening("s3"),
      toolResult("s3", "s3-t", "s3-r", "2026-09-01T10:00:10Z"),
      attachment("s3", "s3-q", "s3-t", {
        type: "queued_command",
        commandMode: "prompt",
        origin: { kind: "human" },
      }),
      hit("s3", "s3-h", "s3-q", "2026-09-01T10:00:30Z", LIMIT),
    ],
    "-p/s4.jsonl": [
      ...opening("s4"),
      toolResult("s4", "s4-t", "s4-r", "2026-09-01T10:00:10Z"),
      attachment("s4", "s4-n", "s4-t", { type: "a_type_from_the_future" }),
      hit("s4", "s4-h", "s4-n", "2026-09-01T10:00:30Z", LIMIT),
    ],
    "-p/s5.jsonl": [
      user("s5", "s5-m", null, "2026-09-01T10:00:00Z", { isMeta: true }),
      attachment("s5", "s5-a", "s5-m", { type: "total_tokens_reminder", text: "x" }),
      hit("s5", "s5-h", "s5-a", "2026-09-01T10:00:30Z", LIMIT),
    ],
    "-p/s6.jsonl": [hit("s6", "s6-h", "not-in-the-logs", "2026-09-01T10:00:30Z", LIMIT)],
    "-p/s7.jsonl": [
      ...opening("s7"),
      toolResult("s7", "s7-t", "s7-r", "2026-09-01T10:00:10Z"),
      hit("s7", "s7-h", "s7-t", "2026-09-01T10:00:30Z", LIMIT),
    ],
    "-p/s8.jsonl": [
      attachment("s8", "s8-a", "s8-b", { type: "total_tokens_reminder", text: "x" }),
      attachment("s8", "s8-b", "s8-a", { type: "total_tokens_reminder", text: "x" }),
      hit("s8", "s8-h", "s8-a", "2026-09-01T10:00:30Z", LIMIT),
    ],
  });

  /** Each session's hit: its position and how many attachment lines the walk passed. */
  const rows = Object.fromEntries(
    (
      db
        .prepare(
          "SELECT session_id, position, attachments_passed FROM logged_limit_hits ORDER BY session_id",
        )
        .all() as { session_id: string; position: string; attachments_passed: number }[]
    ).map((row) => [row.session_id, [row.position, row.attachments_passed]]),
  );

  it("walks past metadata to the tool result or prompt the request answered", () => {
    expect(rows["s1"]).toEqual(["mid_task", 1]);
    // A task notification is automatic, so the walk passes it as it passes the file notice.
    expect(rows["s2"]).toEqual(["turn_start", 2]);
  });

  it("stops at a human's queued message and at a type no one has classified", () => {
    expect(rows["s3"]).toEqual(["unknown", 0]);
    // A type a future Claude Code adds can only leave a hit unknown, never make it mid-task.
    expect(rows["s4"]).toEqual(["unknown", 0]);
  });

  it("keeps D-021's rule where the walk stops: a meta line and a missing parent are unknown", () => {
    expect(rows["s5"]).toEqual(["unknown", 1]);
    expect(rows["s6"]).toEqual(["unknown", 0]);
    // With no attachment in between, nothing changes from D-021.
    expect(rows["s7"]).toEqual(["mid_task", 0]);
  });

  it("stops a loop of uuids after 50 steps instead of walking forever", () => {
    expect(rows["s8"]).toEqual(["unknown", 50]);
  });

  it("carries the walk into the interruption events and counts", () => {
    const counts = db.prepare("SELECT * FROM obs_mid_task_interruptions").get() as {
      mid_task: number;
      turn_start: number;
      position_unknown: number;
    };
    // s1 and s7 mid-task; s2 a turn start; s3, s4, s5, s6, s8 unknown.
    expect([counts.mid_task, counts.turn_start, counts.position_unknown]).toEqual([2, 1, 5]);
    const passed = db
      .prepare("SELECT SUM(attachments_passed) AS n FROM obs_limit_hits_events")
      .get() as { n: number };
    // 1 + 2 + 0 + 0 + 1 + 0 + 0 + 50 = 54.
    expect(passed.n).toBe(54);
  });

  it("lists every attachment type seen in real logs on 2026-10-13, and only queued_command by its fields", () => {
    const types = db.prepare("SELECT attachment_type, rule FROM attachment_walk").all() as {
      attachment_type: string;
      rule: string;
    }[];
    expect(types).toHaveLength(37);
    expect(types.filter((t) => t.rule === "by_fields").map((t) => t.attachment_type)).toEqual([
      "queued_command",
    ]);
  });
});
