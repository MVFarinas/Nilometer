/**
 * @file The shared test database for the HTML report (step G1.0, D-070).
 *
 * Every G1 agent tests against this one scenario, so the data layer, the charts, and the page agree
 * on what "the fixture" is. It records inputs only: each test works out its expected values by hand
 * from the table below, never by running the code under test.
 *
 * All times are 2026-09-03 UTC unless stated, and the display zone is UTC. Session `s1`:
 *
 * | Line | At | Kind | Parent | Details |
 * |---|---|---|---|---|
 * | u1 | 10:00:00 | prompt (human) | none | |
 * | r1 | 10:00:05 | request | u1 | claude-sonnet-5, input 1, output 100 |
 * | t1 | 10:00:10 | tool result | r1 | |
 * | r2 | 10:00:20 | request | t1 | claude-opus-5, input 1, output 300 |
 * | t2 | 11:57:50 | tool result | r2 | |
 * | r3 | 11:58:00 | request | t2 | claude-opus-5, input 1, output 10 |
 * | t3 | 11:59:00 | tool result | r3 | |
 * | h1 | 12:00:00 | limit hit | t3 | "You've hit your session limit · resets 1pm (UTC)", so reset 13:00:00 |
 * | u2 | 13:05:00 | prompt (human) | h1 | |
 * | r4 | 13:05:10 | request | u2 | claude-opus-5, input 1, output 50 |
 *
 * Status line readings, captured in session `s1`. Each is dated by the response behind it (D-045):
 * the latest request in the session at or before the capture.
 *
 * | Capture | five_hour used | five_hour resets | seven_day used | seven_day resets |
 * |---|---|---|---|---|
 * | 10:00:06 | 20 | 13:00:00 | 10 | 2026-09-10 00:00:00 |
 * | 10:00:21 | 60 | 13:00:00 | 12 | 2026-09-10 00:00:00 |
 * | 11:58:05 | 103 | 13:00:00 | 15 | 2026-09-10 00:00:00 |
 * | 13:05:15 | 2 | 18:00:00 | 16 | 2026-09-10 00:00:00 |
 *
 * The 103 is deliberate: readings above 100 are valid (D-068) and must draw above the 100% line.
 * No plan price is entered, so every month's plan fields are null. Prices come from the committed
 * price table (claude-sonnet-5 and claude-opus-5 are both priced).
 */
import type { Db } from "../../../core/db/database.js";
import { type Reading, hit, ingest, request, toolResult, user } from "../core/metrics/helpers.js";
import type { HtmlMeta } from "../../../viewer/html-contract.js";

/** The display zone and production time every G1 test uses. */
export const HTML_FIXTURE_META: HtmlMeta = {
  timeZone: "UTC",
  generatedAt: new Date("2026-09-03T14:00:00Z"),
};

/**
 * Builds a status line reading for session `s1` with both windows, as the table above lists them.
 * @param at - Capture time, `HH:MM:SS` on 2026-09-03 UTC.
 * @param fiveHour - five_hour `used_percentage`.
 * @param fiveHourResets - five_hour reset, `HH:MM:SS` on 2026-09-03 UTC.
 * @param sevenDay - seven_day `used_percentage`; its reset is 2026-09-10T00:00:00Z throughout.
 * @returns The reading.
 */
function reading(at: string, fiveHour: number, fiveHourResets: string, sevenDay: number): Reading {
  return {
    at: `2026-09-03T${at}Z`,
    session: "s1",
    window: "five_hour",
    used: fiveHour,
    resets: `2026-09-03T${fiveHourResets}Z`,
    more: [{ window: "seven_day", used: sevenDay, resets: "2026-09-10T00:00:00Z" }],
  };
}

/**
 * Ingests the scenario in this file's header into a fresh in-memory database.
 * @returns The database, derived and priced.
 */
export function buildHtmlFixture(): Db {
  /**
   * Places a time on the fixture day.
   * @param time - `HH:MM:SS` UTC.
   * @returns ISO-8601 UTC.
   */
  const at = (time: string): string => `2026-09-03T${time}Z`;
  return ingest(
    {
      "-fixture-html/s1.jsonl": [
        user("s1", "u1", null, at("10:00:00")),
        request("s1", "r1", "u1", at("10:00:05"), {
          model: "claude-sonnet-5",
          usage: { input_tokens: 1, output_tokens: 100 },
        }),
        toolResult("s1", "t1", "r1", at("10:00:10")),
        request("s1", "r2", "t1", at("10:00:20"), {
          model: "claude-opus-5",
          usage: { input_tokens: 1, output_tokens: 300 },
        }),
        toolResult("s1", "t2", "r2", at("11:57:50")),
        request("s1", "r3", "t2", at("11:58:00"), {
          model: "claude-opus-5",
          usage: { input_tokens: 1, output_tokens: 10 },
        }),
        toolResult("s1", "t3", "r3", at("11:59:00")),
        hit("s1", "h1", "t3", at("12:00:00"), "You've hit your session limit · resets 1pm (UTC)"),
        user("s1", "u2", "h1", at("13:05:00")),
        request("s1", "r4", "u2", at("13:05:10"), {
          model: "claude-opus-5",
          usage: { input_tokens: 1, output_tokens: 50 },
        }),
      ],
    },
    [
      reading("10:00:06", 20, "13:00:00", 10),
      reading("10:00:21", 60, "13:00:00", 12),
      reading("11:58:05", 103, "13:00:00", 15),
      reading("13:05:15", 2, "18:00:00", 16),
    ],
  );
}
