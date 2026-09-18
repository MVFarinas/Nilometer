/**
 * @file Unit tests for viewer/explain.ts (docs/development.md P7.2).
 *
 * The central test: for every metric, each number the report shows equals the sum of the events
 * `explain` lists for it (README principle 4).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../../core/db/database.js";
import {
  type ExplainGroup,
  METRIC_NAMES,
  UnknownMetricError,
  explain,
  formatLocation,
  renderExplanation,
  resum,
} from "../../../viewer/explain.js";
import { OBSERVED_VIEWS, PROJECTED_VIEWS } from "../../../viewer/queries.js";
import { ingest } from "../core/metrics/helpers.js";
import { FIXTURE_TIME_ZONE, buildReportFixture } from "./fixture.js";

describe("explain on the report fixture", () => {
  let db: Db;
  const originalTz = process.env["TZ"];

  beforeAll(() => {
    process.env["TZ"] = FIXTURE_TIME_ZONE;
    db = buildReportFixture();
  });

  afterAll(() => {
    if (originalTz === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = originalTz;
    }
  });

  it("explains a metric for every metric view the report reads", () => {
    // Headroom and peak share a table row; each other view is one metric.
    expect(METRIC_NAMES).toHaveLength(OBSERVED_VIEWS.length - 1 + PROJECTED_VIEWS.length - 1 + 1);
  });

  it.each(METRIC_NAMES)("re-sums %s from its events to exactly the reported numbers", (metric) => {
    const explanation = explain(db, metric);
    expect(explanation.groups.length).toBeGreaterThan(0);
    for (const group of explanation.groups) {
      /**
       * Rounds away floating-point noise so sums of dollar amounts compare exactly.
       * @param value - A number or null.
       * @returns The value rounded to 9 decimal places, or null.
       */
      const round = (value: number | null): number | null =>
        value === null ? null : Math.round(value * 1e9) / 1e9;
      group.measures.forEach((measure, index) => {
        expect(round(resum(group, index))).toBe(round(measure.reported));
      });
      for (const event of group.events) {
        expect(event.contributions).toHaveLength(group.measures.length);
        expect(event.location).toMatch(
          /^(unknown location|[^:]+:\d+ \(byte \d+\))(, [^:]+:\d+ \(byte \d+\))*$/,
        );
      }
    }
    const lines = renderExplanation(explanation, FIXTURE_TIME_ZONE, "", Number.POSITIVE_INFINITY);
    expect(lines.join("\n")).not.toContain("these don't match");
  });

  it("points each event at its source line", () => {
    const hits = explain(db, "limit-hits").groups[0]?.events ?? [];
    expect(hits).toHaveLength(2);
    // The first hit is the 4th line of sa.jsonl; the second, the 2nd line of sc.jsonl.
    expect(hits[0]?.location).toMatch(/^projects\/-work-app\/sa\.jsonl:4 \(byte \d+\)$/);
    expect(hits[1]?.location).toMatch(/^projects\/-work-tool\/sc\.jsonl:2 \(byte \d+\)$/);
    expect(explain(db, "not-resumed").groups[0]?.events.map((e) => e.description)).toEqual([
      // Its reset text names a date, which D-023 leaves unresolved.
      "session sc · reset unknown · no later request in the session",
    ]);
    expect(
      explain(db, "unattributed").groups.flatMap((g) => g.events.map((e) => e.contributions[0])),
    ).toEqual([2]);
    const headroom = explain(db, "headroom").groups.flatMap((g) => g.events);
    expect(headroom.every((event) => event.location.startsWith("statusline.spool.jsonl:"))).toBe(
      true,
    );
  });

  it("renders measures, events, and a note when events are cut off", () => {
    const lines = renderExplanation(explain(db, "by-model"), FIXTURE_TIME_ZONE, "", 0);
    expect(lines[0]).toBe("Explain: Claude Code tokens by model (observed)");
    expect(lines[1]).toBe("Times are in America/Chicago.");
    expect(lines).toContain("  Output tokens: report shows 3,400 · from the event below: 3,400");
    expect(lines).toContain("    1 more events not listed; --all lists every event");
    const projected = renderExplanation(explain(db, "burn-rate"), FIXTURE_TIME_ZONE, "", 5);
    expect(projected[0]).toBe("Explain: Burn rate (projected: an estimate, not an observation)");
    // UTC instants in titles are shown in the display zone.
    expect(
      projected.some((line) => line.startsWith("5-hour window resetting 2026-09-02 17:00")),
    ).toBe(true);
  });

  it("flags a number that its events don't reproduce", () => {
    const explanation = explain(db, "limit-hits");
    const group = explanation.groups[0] as ExplainGroup;
    const broken = {
      ...explanation,
      groups: [{ ...group, measures: [{ ...group.measures[0]!, reported: 5 }] }],
    };
    expect(renderExplanation(broken, "UTC", "", 5)).toContain(
      "  Interruptions: report shows 5 · from the 2 events below: 2 · these don't match",
    );
    const unknownVsZero = {
      ...explanation,
      groups: [{ ...group, measures: [{ ...group.measures[0]!, reported: null }] }],
    };
    expect(renderExplanation(unknownVsZero, "UTC", "", 5).join("\n")).toContain(
      "these don't match",
    );
  });
});

describe("explain edge cases", () => {
  it("rejects an unknown metric, naming the valid ones", () => {
    expect(() => explain(ingest({}), "savings")).toThrow(UnknownMetricError);
    expect(() => explain(ingest({}), "toString")).toThrow(
      `Unknown metric "toString"; choose one of: ${METRIC_NAMES.join(", ")}`,
    );
    expect(new UnknownMetricError("x").name).toBe("UnknownMetricError");
  });

  it("says there's no data for metrics without groups, and counts zero events as 0", () => {
    const db = ingest({});
    expect(renderExplanation(explain(db, "headroom"), "UTC", "", 5)).toEqual([
      "Explain: Last observed usage before each window's reset (observed)",
      "Times are in UTC.",
      "",
      "No data for this metric yet.",
    ]);
    expect(renderExplanation(explain(db, "limit-hits"), "UTC", "", 5)).toContain(
      "  Interruptions: report shows 0 · from the 0 events below: 0",
    );
  });

  it("lists each window's own percentage when one reading carries both windows", () => {
    // Real payloads carry both windows in one spool line. Hand-computed: the 5-hour group's event
    // is 30%, the weekly group's is 70%, and each re-sums to its reported value. Observed 2026-09-17
    // on real data: the weekly group listed the 5-hour value from the same line.
    const db = ingest({}, [
      {
        at: "2026-09-02T15:00:00Z",
        session: "sw",
        window: "five_hour",
        used: 30,
        resets: "2026-09-02T17:00:00Z",
        more: [{ window: "seven_day", used: 70, resets: "2026-09-07T00:00:00Z" }],
      },
    ]);
    for (const metric of ["headroom", "peak", "burn-rate"]) {
      const groups = explain(db, metric).groups;
      expect(
        groups.map((g) => [g.measures[0]?.reported, g.events.map((e) => e.contributions[0])]),
      ).toEqual([
        [30, [30]],
        [70, [70]],
      ]);
      const lines = renderExplanation(explain(db, metric), "UTC", "", 5).join("\n");
      expect(lines).not.toContain("these don't match");
    }
  });

  it("escapes control characters in titles, descriptions, and locations (D-050)", () => {
    // Group titles are repository paths and model names, and descriptions carry session IDs and
    // file names, all of which come from the logs rather than from Nilometer.
    const esc = String.fromCharCode(27);
    const lines = renderExplanation(
      {
        metric: "by-repo",
        title: "t",
        section: "observed",
        groups: [
          {
            title: ["/work/app", "Interruptions: 99"].join("\n"),
            measures: [{ label: "Tokens", kind: "tokens", reported: 1 }],
            events: [
              {
                at: null,
                description: `${esc}[2Kclaude-opus-5`,
                location: ["p/s.jsonl:1", "x"].join("\r"),
                contributions: [1],
              },
            ],
          },
        ],
      },
      "UTC",
      "",
      5,
    ).join("\n");
    expect(lines).not.toContain(esc);
    expect(lines).toContain("/work/app\\nInterruptions: 99");
    expect(lines).toContain("\\e[2Kclaude-opus-5");
    expect(lines).toContain("p/s.jsonl:1\\rx");
  });

  it("formats locations and treats all-null sums per measure", () => {
    expect(formatLocation({ relative_path: null, line_number: null, byte_offset: null })).toBe(
      "unknown location",
    );
    expect(formatLocation({ relative_path: "p/s.jsonl", line_number: 3, byte_offset: 120 })).toBe(
      "p/s.jsonl:3 (byte 120)",
    );
    const group: ExplainGroup = {
      title: "g",
      measures: [
        { label: "a", kind: "tokens", reported: null },
        { label: "b", kind: "tokens", reported: 0, nullIsZero: true },
        { label: "c", kind: "count", reported: 0 },
      ],
      events: [
        {
          at: null,
          description: "e",
          location: "unknown location",
          contributions: [null, null, null],
        },
      ],
    };
    expect([resum(group, 0), resum(group, 1), resum(group, 2)]).toEqual([null, 0, 0]);
  });
});
