/**
 * @file Number, time, and coverage formatting for the viewer (docs/development.md P7.1).
 *
 * The only place values are rounded (CLAUDE.md "Round only at display"). SQL returns unrounded
 * values; these functions turn each into text once. A missing value is always the word "unknown",
 * never 0 or an empty cell (add-metric §1).
 */

/** Kinds of value the viewer displays. */
export type ValueKind =
  "count" | "tokens" | "usd" | "percent" | "percentage_points" | "rate" | "duration";

/** Text shown for a value that isn't known. */
export const UNKNOWN = "unknown";

/** Integer formatter with thousands separators, independent of the machine's locale. */
const INTEGER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Up to one decimal place, trailing zero dropped (42.3, 42). */
const ONE_DECIMAL = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** Dollars and cents with thousands separators. */
const DOLLARS = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formats one value for display.
 * @param value - The unrounded value, or null/undefined when unknown.
 * @param kind - What the value measures.
 * @returns Display text; {@link UNKNOWN} for null, undefined, or a non-finite number.
 * @example
 * formatNumber(1234567, "tokens"); // "1,234,567"
 * formatNumber(0.004, "usd"); // "less than $0.01"
 * formatNumber(10090.6, "duration"); // "2 h 48 m"
 */
export function formatNumber(value: number | null | undefined, kind: ValueKind): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNKNOWN;
  }
  switch (kind) {
    case "count":
    case "tokens":
      return INTEGER.format(value);
    case "usd":
      // A non-zero amount that rounds to $0.00 would read as free; say it's under a cent instead.
      return value > 0 && value < 0.005 ? "less than $0.01" : `$${DOLLARS.format(value)}`;
    case "percent":
      return `${ONE_DECIMAL.format(value)}%`;
    case "percentage_points":
      return `${ONE_DECIMAL.format(value)} percentage points`;
    case "rate":
      return `${ONE_DECIMAL.format(value)} percentage points per hour`;
    case "duration":
      return formatDuration(value);
  }
}

/**
 * Formats a span of seconds as its two largest units.
 * @param seconds - Non-negative seconds (a negative span is shown by magnitude with a minus sign).
 * @returns E.g. `45 s`, `12 m 5 s`, `2 h 48 m`, `3 d 4 h`.
 */
export function formatDuration(seconds: number): string {
  const sign = seconds < 0 ? "-" : "";
  const total = Math.round(Math.abs(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) {
    return `${sign}${days} d ${hours} h`;
  }
  if (hours > 0) {
    return `${sign}${hours} h ${minutes} m`;
  }
  if (minutes > 0) {
    return `${sign}${minutes} m ${secs} s`;
  }
  return `${sign}${secs} s`;
}

/** Local date and time parts of an instant. */
interface LocalParts {
  /** `YYYY-MM-DD`. */
  readonly date: string;
  /** `HH:MM`, 24-hour. */
  readonly time: string;
}

/**
 * Reads an instant's local date and time in a zone.
 * @param iso - ISO-8601 instant.
 * @param timeZone - IANA zone.
 * @returns Date and time parts.
 */
function localParts(iso: string, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  /**
   * Finds one part's value.
   * @param type - Part type.
   * @returns The value.
   */
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

/**
 * Formats an instant in the display zone.
 * @param iso - ISO-8601 instant, or null.
 * @param timeZone - IANA zone.
 * @returns `YYYY-MM-DD HH:MM`, or {@link UNKNOWN}.
 */
export function formatInstant(iso: string | null | undefined, timeZone: string): string {
  if (iso === null || iso === undefined) {
    return UNKNOWN;
  }
  const { date, time } = localParts(iso, timeZone);
  return `${date} ${time}`;
}

/**
 * Formats the span a metric covers, naming the zone (README principle 5, D-007).
 * @param from - First instant covered, or null when there's no data.
 * @param to - Last instant covered, or null.
 * @param timeZone - IANA zone.
 * @returns `no data yet`, `YYYY-MM-DD HH:MM–HH:MM (zone)` within one local day, or
 *   `YYYY-MM-DD HH:MM to YYYY-MM-DD HH:MM (zone)`.
 */
export function formatCoverage(
  from: string | null | undefined,
  to: string | null | undefined,
  timeZone: string,
): string {
  if (from === null || from === undefined || to === null || to === undefined) {
    return "no data yet";
  }
  const start = localParts(from, timeZone);
  const end = localParts(to, timeZone);
  if (start.date === end.date) {
    return `${start.date} ${start.time}–${end.time} (${timeZone})`;
  }
  return `${start.date} ${start.time} to ${end.date} ${end.time} (${timeZone})`;
}
