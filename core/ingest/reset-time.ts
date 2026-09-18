/**
 * @file Resolving a limit hit's reset text to a UTC instant (D-023).
 *
 * Claude Code writes the reset time as wall-clock text in a named zone: "6:10am (<IANA zone>)".
 * The text has no date, so the instant is the first matching wall-clock minute at or after the hit.
 * Scanning whole UTC minutes, rather than converting local time to UTC arithmetically, gives one
 * answer at DST changes without special cases: a repeated local time matches its first occurrence,
 * and a skipped local time never matches that day, so the next day's occurrence is found.
 */

/** Reset text this module understands: `H[:MM]am|pm (Zone)`, case-insensitive. */
const RESET_TEXT = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^()]+)\)$/i;

/** How far ahead of the hit the scan looks. A time of day recurs within 24 hours; DST adds at most one more. */
export const RESET_SEARCH_MINUTES = 48 * 60;

/** One minute in milliseconds. */
const MINUTE_MS = 60_000;

/**
 * Builds a formatter that reads the 24-hour wall-clock hour and minute in a zone.
 * @param zone - IANA zone name as written in the log.
 * @returns The formatter, or null when the runtime doesn't know the zone.
 */
function wallClockFormatter(zone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    // An unknown zone throws RangeError; the reset stays unknown rather than guessed.
    return null;
  }
}

/**
 * Reads the wall-clock hour and minute of an instant.
 * @param formatter - From {@link wallClockFormatter}.
 * @param ms - Epoch milliseconds.
 * @returns Hour 0–23 and minute 0–59 as the zone shows them.
 */
function wallClock(formatter: Intl.DateTimeFormat, ms: number): { hour: number; minute: number } {
  let hour = -1;
  let minute = -1;
  for (const part of formatter.formatToParts(ms)) {
    if (part.type === "hour") {
      hour = Number(part.value);
    } else if (part.type === "minute") {
      minute = Number(part.value);
    }
  }
  return { hour, minute };
}

/**
 * Resolves reset text to the UTC instant it names.
 * @param resetText - The limit hit's reset text (`events.reset_text`), or null.
 * @param hitUtc - The hit's UTC timestamp (`YYYY-MM-DDTHH:MM:SS.sssZ`), or null when it didn't parse.
 * @returns `YYYY-MM-DDTHH:MM:00.000Z`, or null when either input is missing, the hit time doesn't
 *   parse, the text isn't a 12-hour time with a zone, the hour or minute is out of range, the zone
 *   is unknown, or no match is found within {@link RESET_SEARCH_MINUTES}.
 * @example
 * resolveResetTime("6:10am (UTC)", "2026-09-01T03:00:00.000Z"); // "2026-09-01T06:10:00.000Z"
 */
export function resolveResetTime(resetText: string | null, hitUtc: string | null): string | null {
  if (resetText === null || hitUtc === null) {
    return null;
  }
  const match = RESET_TEXT.exec(resetText.trim());
  if (match === null) {
    return null;
  }
  const hour12 = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (hour12 < 1 || hour12 > 12 || minute > 59) {
    return null;
  }
  const formatter = wallClockFormatter((match[4] as string).trim());
  if (formatter === null) {
    return null;
  }
  // 12am is hour 0 and 12pm is hour 12; every other pm hour adds 12.
  const hour = (hour12 % 12) + ((match[3] as string).toLowerCase() === "pm" ? 12 : 0);
  // Start at the hit's own minute: text shows minutes only, so a reset in the hit's minute is that minute.
  const start = Math.floor(Date.parse(hitUtc) / MINUTE_MS) * MINUTE_MS;
  if (Number.isNaN(start)) {
    return null;
  }
  for (let step = 0; step <= RESET_SEARCH_MINUTES; step += 1) {
    const ms = start + step * MINUTE_MS;
    const clock = wallClock(formatter, ms);
    if (clock.hour === hour && clock.minute === minute) {
      return new Date(ms).toISOString();
    }
  }
  return null;
}
