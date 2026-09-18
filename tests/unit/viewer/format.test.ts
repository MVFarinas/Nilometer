/**
 * @file Unit tests for viewer/format.ts (docs/development.md P7.1).
 */
import { describe, expect, it } from "vitest";

import {
  UNKNOWN,
  formatCoverage,
  formatDuration,
  formatInstant,
  formatNumber,
  printable,
} from "../../../viewer/format.js";

describe("printable", () => {
  it("writes control characters as escapes and leaves ordinary text alone (D-050)", () => {
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    expect(printable("claude-opus-5")).toBe("claude-opus-5");
    expect(printable(["a", "b"].join("\n"))).toBe("a\\nb");
    expect(printable(["a", "b"].join("\r"))).toBe("a\\rb");
    expect(printable(["a", "b"].join("\t"))).toBe("a\\tb");
    expect(printable(`${esc}[2K`)).toBe("\\e[2K");
    expect(printable(`x${bel}`)).toBe("x\\x07");
    // Non-ASCII text is not a control character and stays as written.
    expect(printable("Fariñas · 日本")).toBe("Fariñas · 日本");
  });
});

describe("formatNumber", () => {
  it.each([
    [null, "tokens"],
    [undefined, "usd"],
    [Number.NaN, "percent"],
    [Number.POSITIVE_INFINITY, "duration"],
  ] as const)("shows %s as unknown, never 0", (value, kind) => {
    expect(formatNumber(value, kind)).toBe(UNKNOWN);
  });

  it.each([
    [0, "count", "0"],
    [1234, "count", "1,234"],
    [1234567.6, "tokens", "1,234,568"],
    [0, "usd", "$0.00"],
    [0.004, "usd", "less than $0.01"],
    [0.005, "usd", "$0.01"],
    [1234.567, "usd", "$1,234.57"],
    [42, "percent", "42%"],
    [42.34, "percent", "42.3%"],
    [100, "percent", "100%"],
    [7.5, "percentage_points", "7.5 percentage points"],
    [10, "rate", "10 percentage points per hour"],
    [10090.6, "duration", "2 h 48 m"],
  ] as const)("formats %s as %s", (value, kind, text) => {
    expect(formatNumber(value, kind)).toBe(text);
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0 s"],
    [44.6, "45 s"],
    [60, "1 m 0 s"],
    [725, "12 m 5 s"],
    [3600, "1 h 0 m"],
    [86_399.6, "1 d 0 h"],
    [273_600, "3 d 4 h"],
    [-90, "-1 m 30 s"],
  ])("formats %s seconds as %s", (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });
});

describe("formatInstant", () => {
  it("shows an instant in the display zone, or unknown", () => {
    // 2026-09-03 17:05 UTC is 12:05 CDT (UTC−5).
    expect(formatInstant("2026-09-03T17:05:00.000Z", "America/Chicago")).toBe("2026-09-03 12:05");
    expect(formatInstant("2026-09-03T00:30:00.000Z", "America/Chicago")).toBe("2026-09-02 19:30");
    expect(formatInstant(null, "UTC")).toBe(UNKNOWN);
    expect(formatInstant(undefined, "UTC")).toBe(UNKNOWN);
  });
});

describe("formatCoverage", () => {
  it("names the zone and collapses a span within one local day", () => {
    expect(
      formatCoverage("2026-09-03T14:00:00.000Z", "2026-09-03T20:15:00.000Z", "America/Chicago"),
    ).toBe("2026-09-03 09:00 to 15:15 (America/Chicago)");
  });

  it("spells out both dates across days and months", () => {
    // 2026-09-04 03:00 UTC is still 09-03 locally, so this span is two local days, not three.
    expect(
      formatCoverage("2026-07-19T13:00:00.000Z", "2026-09-04T03:00:00.000Z", "America/Chicago"),
    ).toBe("2026-07-19 08:00 to 2026-09-03 22:00 (America/Chicago)");
  });

  it("says there's no data when either end is missing", () => {
    expect(formatCoverage(null, null, "UTC")).toBe("no data yet");
    expect(formatCoverage("2026-09-03T14:00:00.000Z", undefined, "UTC")).toBe("no data yet");
  });
});
