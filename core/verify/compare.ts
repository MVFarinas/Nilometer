/**
 * @file Comparing token totals against ccusage, shared by the fixture audit and `nilometer verify`.
 *
 * The rules for "do these totals agree" live here once. The audit (check A7) applies them to the
 * committed fixtures; `verify` applies the same rules to a user's own logs on their own machine
 * (D-064). Two implementations of the same question would be free to drift, and the whole point of
 * comparing against a reference implementation is that the comparison itself is trustworthy.
 */

/** The fields compared, in the order they're reported. */
export const FIELDS = ["input", "output", "cache_read", "cache_write", "cost_usd"] as const;

/** One compared field. */
export type Field = (typeof FIELDS)[number];

/** Token totals and cost for one day and model. */
export type Totals = Record<Field, number>;

/** Totals keyed by `"<YYYY-MM-DD>|<model>"`. */
export type TotalsByDayModel = Record<string, Totals>;

/** One field that differs between the two sides. */
export interface Difference {
  /** `"<day>|<model>"`. */
  readonly key: string;
  /** Which field differs. */
  readonly field: Field;
  /** Nilometer's value. */
  readonly ours: number;
  /** ccusage's value. */
  readonly theirs: number;
}

/** ccusage's `claude daily --json --breakdown` output, as far as this reads it. */
export interface CcusageDaily {
  /** One entry per day. */
  readonly daily: readonly {
    /** `YYYY-MM-DD` in the requested timezone. */
    readonly date: string;
    /** Per-model token totals for the day. */
    readonly modelBreakdowns: readonly {
      readonly modelName: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheReadTokens: number;
      readonly cacheCreationTokens: number;
      /** USD cost at ccusage's embedded (offline) prices. */
      readonly cost: number;
    }[];
  }[];
}

/**
 * Normalizes ccusage daily JSON to per-day, per-model totals.
 * @param json - Parsed output of `ccusage claude daily --json --breakdown`.
 * @returns Totals keyed by `"<day>|<model>"`.
 */
export function normalizeCcusage(json: CcusageDaily): TotalsByDayModel {
  const result: TotalsByDayModel = {};
  for (const day of json.daily) {
    for (const model of day.modelBreakdowns) {
      result[`${day.date}|${model.modelName}`] = {
        input: model.inputTokens,
        output: model.outputTokens,
        cache_read: model.cacheReadTokens,
        // ccusage reports one cache-write total; its JSON has no 5m/1h split (skill § Comparing).
        cache_write: model.cacheCreationTokens,
        cost_usd: model.cost,
      };
    }
  }
  return result;
}

/**
 * Compares two values of a field: token counts exactly, costs within floating-point noise.
 * @param field - The field compared.
 * @param a - One value.
 * @param b - The other value.
 * @returns True when the values are equal for that field.
 */
export function sameValue(field: Field, a: number, b: number): boolean {
  if (field !== "cost_usd") {
    return a === b;
  }
  // Summing binary floats in a different order differs in the 17th digit; a millionth of a cent doesn't.
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Lists every field that differs between two totals maps.
 * @param ours - Nilometer's totals.
 * @param theirs - ccusage's totals.
 * @param fields - Fields to compare; defaults to all of them.
 * @returns Differences sorted by key, then field order.
 */
export function diffTotals(
  ours: TotalsByDayModel,
  theirs: TotalsByDayModel,
  fields: readonly Field[] = FIELDS,
): Difference[] {
  const differences: Difference[] = [];
  const keys = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])].sort();
  for (const key of keys) {
    for (const field of fields) {
      // A day/model missing on one side compares as zero, so it shows up as a difference.
      const oursValue = ours[key]?.[field] ?? 0;
      const theirsValue = theirs[key]?.[field] ?? 0;
      if (!sameValue(field, oursValue, theirsValue)) {
        differences.push({ key, field, ours: oursValue, theirs: theirsValue });
      }
    }
  }
  return differences;
}

/**
 * Takes the day out of a `"<day>|<model>"` key.
 * @param key - The key.
 * @returns The `YYYY-MM-DD` part.
 */
export function dayOf(key: string): string {
  // split always yields at least one element, so this needs no fallback.
  return key.split("|")[0] as string;
}
