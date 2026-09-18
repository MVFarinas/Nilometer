/**
 * @file The one screen: observed sections first, projections in a separate labeled section (docs/development.md P7.1).
 *
 * Wording is part of correctness (CLAUDE.md): labels state what was measured, projections say
 * "projected" in the label itself, caveats sit next to their numbers, and nothing is advice. Every
 * label lives in {@link LABELS}, which the JSON output carries too, so the banned-phrase test (A9)
 * reads every label once. Numbers are rounded only through viewer/format.ts.
 */
import {
  UNKNOWN,
  type ValueKind,
  formatCoverage,
  formatInstant,
  formatNumber,
  printable,
} from "./format.js";
import type {
  ApiListPriceRow,
  BurnRateRow,
  ModelRow,
  ObservedReport,
  ProjectedReport,
  RepoRow,
} from "./queries.js";

/** Every heading, column name, and caveat the report prints. */
export const LABELS = {
  title: "Claude subscription usage",
  observed: "OBSERVED",
  projected: "PROJECTED: estimates derived from the observations above, not observations",
  interruptions: "Interruptions",
  limitHits: "Rate-limit interruptions",
  midTask: "Mid-task interruptions (the stopped request was answering a tool result)",
  lockout: "Elapsed lockout time (limit hit to reset, overlapping hits counted once)",
  resetToNextRequest: "reset to next Claude Code request",
  notResumed: "Sessions with no further request after a limit hit",
  autoResumeCaveat:
    "A session that continued after its reset may have been resumed automatically; these counts are requests, not who made them.",
  windows: "Usage windows",
  noReadings:
    "No status line readings yet. Readings are recorded only when Claude Code runs in a terminal; the VS Code extension doesn't run the status line.",
  windowsCaveat:
    "Last observed usage is a lower bound: usage after the last Claude Code turn isn't seen.",
  unattributed: "Usage rise with no Claude Code request between readings",
  unattributedCaveat:
    "A lower bound: usage elsewhere at the same time as Claude Code requests can't be separated. Claude Code on another machine counts here too.",
  byModel: "Claude Code tokens by model",
  byRepo: "Claude Code tokens by repository",
  burnRate: "Burn rate",
  burnRatePremise:
    "Premise: each window's usage started at 0% when it began, and its average rate since then continues.",
  apiListPrice: "Observed tokens at API list price, by month",
  apiListPriceScope:
    "Covers Claude Code only: web, mobile, and Claude Design usage leaves no token records.",
  columns: {
    window: "Window",
    resets: "Resets",
    lastUsage: "Last observed usage",
    readingAt: "Reading at",
    peak: "Peak",
    readings: "Readings",
    status: "Status",
    rise: "Rise with no request",
    pairs: "Reading pairs",
    pairsWithoutRequests: "Pairs with no request",
    pairsFalling: "Pairs where usage fell",
    model: "Model",
    repository: "Repository",
    kind: "Kind",
    requests: "Requests",
    input: "Input",
    output: "Output",
    cacheRead: "Cache read",
    cacheWrite5m: "Cache write 5m",
    cacheWrite1h: "Cache write 1h",
    cacheWriteUnsplit: "Cache write, no duration",
    month: "Month",
    apiListPrice: "At API list price",
    planPrice: "Plan price entered",
    priced: "Priced requests",
    unpriced: "Unpriced requests",
    covers: "Covers",
  },
} as const;

/** Inputs to {@link renderReport} and {@link reportJson}. */
export interface ReportInput {
  /** Observed rows. */
  readonly observed: ObservedReport;
  /** Projected rows. */
  readonly projected: ProjectedReport;
  /** IANA zone every time is shown in. */
  readonly timeZone: string;
  /** When the last ingest finished, or null. */
  readonly lastIngestAt: string | null;
  /** The database the report was read from. */
  readonly databasePath: string;
  /** The user's home directory, shown as `~` in paths so a shared screen doesn't carry it. */
  readonly home: string;
}

/** Column alignment. */
type Align = "left" | "right";

/**
 * Lays out rows as a text table with a header and a rule.
 * @param headers - Column names.
 * @param rawRows - Cell text per row; control characters in them are escaped (D-050).
 * @param align - Alignment per column; numbers are right-aligned.
 * @returns Lines, each indented by two spaces.
 */
export function renderTable(
  headers: readonly string[],
  rawRows: readonly (readonly string[])[],
  align: readonly Align[],
): string[] {
  // Cells hold model names and repository paths from the logs, so escape before measuring (D-050).
  const rows = rawRows.map((row) => row.map(printable));
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  /**
   * Pads one row's cells to the column widths.
   * @param cells - Cell text.
   * @returns The joined line.
   */
  const line = (cells: readonly string[]): string =>
    `  ${cells
      .map((cell, column) =>
        align[column] === "right"
          ? cell.padStart(widths[column] ?? 0)
          : cell.padEnd(widths[column] ?? 0),
      )
      .join("  ")
      .trimEnd()}`;
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];
}

/**
 * Counts something with its singular or plural noun.
 * @param count - How many.
 * @param singular - Noun for exactly one.
 * @param pluralForm - Noun otherwise.
 * @returns E.g. `1 hit`, `3 hits`, `unknown hits`.
 */
export function plural(
  count: number | null | undefined,
  singular: string,
  pluralForm: string,
): string {
  return `${formatNumber(count, "count")} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Shortens a path under the home directory to start with `~`.
 * @param path - Any path.
 * @param home - The home directory; an empty string leaves paths unchanged.
 * @returns `~` or `~/rest` (`~\rest` for a Windows path) under home, otherwise the path itself.
 */
export function displayPath(path: string, home: string): string {
  if (home === "") {
    return path;
  }
  // A Windows home (`C:\Users\<name>`) also matches with `/` separators, which git uses for repository
  // roots, and with a lowercase drive letter, which some Claude Code logs use (D-049). Both changes
  // keep the length, so the remainder is sliced from the original path.
  const windows = /^[A-Za-z]:[\\/]/.test(home);
  /**
   * Spells a path for comparison with the home directory.
   * @param value - A path.
   * @returns On Windows, the path with an uppercase drive letter and `/` separators; elsewhere unchanged.
   */
  const comparable = (value: string): string =>
    windows ? `${value.charAt(0).toUpperCase()}${value.slice(1)}`.replaceAll("\\", "/") : value;
  const [p, h] = [comparable(path), comparable(home)];
  if (p !== h && !p.startsWith(`${h}/`)) {
    return path;
  }
  return `~${path.slice(home.length)}`;
}

/**
 * Names a rate-limit window for display.
 * @param window - Payload window key.
 * @returns `5-hour`, `weekly`, or the key itself.
 */
export function windowName(window: string): string {
  return window === "five_hour" ? "5-hour" : window === "seven_day" ? "weekly" : window;
}

/**
 * Names how a repository was resolved (D-010).
 * @param kind - `repo_kind` from the view.
 * @returns Display text.
 */
export function repoKindName(kind: string): string {
  switch (kind) {
    case "repo":
      return "git repository";
    case "not_git":
      return "not a git repository";
    case "missing":
      return "directory no longer exists";
    default:
      return "not resolved yet";
  }
}

/**
 * Formats a span without the zone, for table cells under a heading that names it.
 * @param from - First instant.
 * @param to - Last instant.
 * @param timeZone - IANA zone.
 * @returns `YYYY-MM-DD HH:MM to YYYY-MM-DD HH:MM`.
 */
function span(from: string | null, to: string | null, timeZone: string): string {
  return `${formatInstant(from, timeZone)} to ${formatInstant(to, timeZone)}`;
}

/**
 * Formats a number, shortening the call sites.
 * @param value - Value.
 * @param kind - Kind.
 * @returns Display text.
 */
const n = (value: number | null | undefined, kind: ValueKind): string => formatNumber(value, kind);

/**
 * Renders the token table shared by the model and repository sections.
 * @param first - Leading columns' headers.
 * @param rows - Rows with their leading cells.
 * @returns Table lines.
 */
function tokenTable(
  first: readonly string[],
  rows: readonly { lead: readonly string[]; row: ModelRow | RepoRow }[],
): string[] {
  const c = LABELS.columns;
  return renderTable(
    [
      ...first,
      c.requests,
      c.input,
      c.output,
      c.cacheRead,
      c.cacheWrite5m,
      c.cacheWrite1h,
      c.cacheWriteUnsplit,
    ],
    rows.map(({ lead, row }) => [
      ...lead,
      n(row.requests, "count"),
      n(row.input_tokens, "tokens"),
      n(row.output_tokens, "tokens"),
      n(row.cache_read_tokens, "tokens"),
      n(row.cache_write_5m_tokens, "tokens"),
      n(row.cache_write_1h_tokens, "tokens"),
      n(row.cache_write_unsplit_tokens, "tokens"),
    ]),
    [
      ...first.map((): Align => "left"),
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
      "right",
    ],
  );
}

/**
 * Renders the observed sections.
 * @param observed - Observed rows.
 * @param timeZone - Display zone.
 * @param home - Home directory to show as `~` in repository paths.
 * @returns Lines.
 */
export function renderObserved(observed: ObservedReport, timeZone: string, home = ""): string[] {
  const { limitHits: hits, midTask, lockout, notResumed } = observed;
  const logs = formatCoverage(hits.covers_from, hits.covers_to, timeZone);
  const statusLine = formatCoverage(
    hits.status_line_covers_from,
    hits.status_line_covers_to,
    timeZone,
  );
  const c = LABELS.columns;
  const lines = [
    LABELS.observed,
    "",
    LABELS.interruptions,
    `  Covers: session logs ${logs}; status line ${statusLine}`,
    `  ${LABELS.limitHits}: ${n(hits.hits, "count")}`,
    `    5-hour window: ${n(hits.five_hour_hits, "count")} | weekly window: ${n(hits.seven_day_hits, "count")} | window unknown: ${n(hits.unknown_window_hits, "count")}`,
    `    From the session logs: ${n(hits.logged_hits, "count")} | seen only in the status line: ${n(hits.status_line_only_hits, "count")}`,
    `  ${LABELS.midTask}: ${n(midTask.mid_task, "count")}`,
    `    At the start of a turn: ${n(midTask.turn_start, "count")} | position unknown: ${n(midTask.position_unknown, "count")}`,
    `  ${LABELS.lockout}: ${n(lockout.lockout_seconds, "duration")} across ${plural(lockout.intervals, "lockout", "lockouts")}`,
    `    Hits with an unknown reset time, not included: ${n(lockout.hits_with_unknown_reset, "count")}`,
    ...observed.lockoutIntervals.map(
      (interval) =>
        `    ${span(interval.locked_from_utc, interval.locked_until_utc, timeZone)}: ${n(interval.lockout_seconds, "duration")}, ${plural(interval.hits, "hit", "hits")}; ${LABELS.resetToNextRequest}: ${
          interval.next_request_at_utc === null
            ? "no request after the reset in the logs"
            : n(interval.reset_to_next_request_seconds, "duration")
        }`,
    ),
    `  ${LABELS.notResumed}: ${n(notResumed.sessions_not_resumed, "count")} of ${plural(notResumed.sessions_with_hits, "session", "sessions")} with a hit`,
    `    Reset came after the logs end: ${n(notResumed.reset_after_coverage, "count")} | reset time unknown: ${n(notResumed.reset_unknown, "count")}`,
    `    ${LABELS.autoResumeCaveat}`,
    "",
    LABELS.windows,
    `  Covers: status line ${statusLine}. Readings start when the collector is installed.`,
  ];
  if (observed.windows.length === 0) {
    lines.push(`  ${LABELS.noReadings}`);
  } else {
    lines.push(
      ...renderTable(
        [c.window, c.resets, c.lastUsage, c.readingAt, c.peak, c.readings, c.status],
        observed.windows.map((w) => [
          windowName(w.window),
          formatInstant(w.reset_at_utc, timeZone),
          n(w.last_used_percentage, "percent"),
          formatInstant(w.last_reading_at_utc, timeZone),
          n(w.peak_used_percentage, "percent"),
          n(w.readings, "count"),
          w.window_open === 1 ? "open" : "reset",
        ]),
        ["left", "left", "right", "left", "right", "right", "left"],
      ),
      `  ${LABELS.windowsCaveat}`,
    );
    const afterReset = observed.windows.reduce((sum, w) => sum + w.readings_after_reset, 0);
    if (afterReset > 0) {
      lines.push(
        `  Readings captured after their window's reset, not counted: ${n(afterReset, "count")}`,
      );
    }
  }
  lines.push("", LABELS.unattributed, `  Covers: status line ${statusLine}`);
  if (observed.unattributed.length === 0) {
    lines.push(`  ${LABELS.noReadings}`);
  } else {
    lines.push(
      ...renderTable(
        [c.window, c.resets, c.rise, c.pairs, c.pairsWithoutRequests, c.pairsFalling],
        observed.unattributed.map((u) => [
          windowName(u.window),
          formatInstant(u.reset_at_utc, timeZone),
          n(u.unattributed_percentage_points, "percentage_points"),
          n(u.pairs, "count"),
          n(u.pairs_without_requests, "count"),
          n(u.decreasing_pairs, "count"),
        ]),
        ["left", "left", "right", "right", "right", "right"],
      ),
      `  ${LABELS.unattributedCaveat}`,
    );
  }
  const modelCoverage = observed.byModel[0];
  lines.push(
    "",
    LABELS.byModel,
    `  Covers: session logs ${formatCoverage(modelCoverage?.covers_from, modelCoverage?.covers_to, timeZone)}`,
  );
  if (observed.byModel.length === 0) {
    lines.push("  No Claude Code requests in the logs yet.");
  } else {
    lines.push(
      ...tokenTable(
        [c.model],
        observed.byModel.map((row) => ({ lead: [row.model], row })),
      ),
    );
    const unkeyed = observed.byModel.reduce((sum, row) => sum + row.unkeyed_requests, 0);
    const untimed = observed.byModel.reduce((sum, row) => sum + row.requests_without_timestamp, 0);
    if (unkeyed > 0) {
      lines.push(
        `  Requests without a message or request ID, kept as written: ${n(unkeyed, "count")}`,
      );
    }
    if (untimed > 0) {
      lines.push(`  Requests without a readable timestamp: ${n(untimed, "count")}`);
    }
    lines.push(
      "",
      LABELS.byRepo,
      `  Covers: session logs ${formatCoverage(modelCoverage?.covers_from, modelCoverage?.covers_to, timeZone)}`,
      ...tokenTable(
        [c.repository, c.kind],
        observed.byRepo.map((row) => ({
          lead: [
            row.repository === null
              ? `${UNKNOWN} (no working directory)`
              : displayPath(row.repository, home),
            repoKindName(row.repo_kind),
          ],
          row,
        })),
      ),
    );
  }
  return lines;
}

/**
 * Describes one window's burn rate projection.
 * @param row - A `proj_burn_rate` row.
 * @param timeZone - Display zone.
 * @returns One line.
 */
export function describeBurnRate(row: BurnRateRow, timeZone: string): string {
  const lead = `  ${windowName(row.window)} window resetting ${formatInstant(row.reset_at_utc, timeZone)}: ${n(row.last_used_percentage, "percent")} at ${formatInstant(row.last_reading_at_utc, timeZone)}`;
  if (row.limit_reached === 1) {
    return `${lead}; limit reached at that reading.`;
  }
  const rate = `projected ${n(row.projected_percentage_points_per_hour, "rate")}`;
  if (row.projected_limit_at_utc === null) {
    return `${lead}; ${rate}; projected limit time unknown.`;
  }
  const when = row.projected_limit_before_reset === 1 ? "before the reset" : "after the reset";
  return `${lead}; ${rate}; limit projected for ${formatInstant(row.projected_limit_at_utc, timeZone)}, ${when}.`;
}

/**
 * Formats the plan price cell.
 * @param row - A `proj_api_list_price` row.
 * @returns Name and price, or "none entered".
 */
function planCell(row: ApiListPriceRow): string {
  return row.plan_name === null
    ? "none entered"
    : `${row.plan_name}, ${n(row.plan_usd_per_month, "usd")} per month`;
}

/**
 * Renders the projected sections.
 * @param projected - Projected rows.
 * @param timeZone - Display zone.
 * @returns Lines.
 */
export function renderProjected(projected: ProjectedReport, timeZone: string): string[] {
  const c = LABELS.columns;
  const open = projected.burnRate.filter((row) => row.window_open === 1);
  const first = projected.burnRate[0];
  const lines = [
    LABELS.projected,
    "",
    LABELS.burnRate,
    `  Covers: status line ${formatCoverage(first?.covers_from, first?.covers_to, timeZone)}`,
    `  ${LABELS.burnRatePremise}`,
    ...(open.length === 0
      ? ["  No open usage window in the status line readings."]
      : open.map((row) => describeBurnRate(row, timeZone))),
    "",
    LABELS.apiListPrice,
    `  Months in ${timeZone}. ${LABELS.apiListPriceScope}`,
  ];
  const months = projected.apiListPrice;
  if (months.length === 0) {
    lines.push("  No Claude Code requests in the logs yet.");
    return lines;
  }
  lines.push(
    ...renderTable(
      [c.month, c.apiListPrice, c.planPrice, c.priced, c.unpriced, c.covers],
      months.map((row) => [
        row.month,
        n(row.api_list_price_usd, "usd"),
        planCell(row),
        n(row.priced_requests, "count"),
        n(row.unpriced_requests, "count"),
        span(row.covers_from, row.covers_to, timeZone),
      ]),
      ["left", "right", "left", "right", "right", "left"],
    ),
  );
  const beforeVerified = months.reduce((sum, row) => sum + row.priced_before_verified_requests, 0);
  const verifiedOn = months
    .map((row) => row.verified_on)
    .filter((d) => d !== null)
    .sort()
    .at(-1);
  if (beforeVerified > 0 && verifiedOn !== undefined) {
    lines.push(
      `  Rates were read from Anthropic's pricing page on ${verifiedOn}; ${n(beforeVerified, "count")} requests dated before that are priced at those rates.`,
    );
  }
  const lowerBound = months.reduce((sum, row) => sum + row.lower_bound_requests, 0);
  if (lowerBound > 0) {
    lines.push(
      `  Requests with cache writes of unrecorded duration, priced at the 5-minute rate (their cost is a lower bound): ${n(lowerBound, "count")}`,
    );
  }
  if (months.some((row) => row.unpriced_requests > 0)) {
    lines.push(
      "  Unpriced requests have no verified rate and are left out of the amounts, not counted as $0.",
    );
  }
  if (months.every((row) => row.plan_name === null)) {
    lines.push(
      "  To show a plan price beside these amounts: plan-price set <YYYY-MM> <usd> --name <plan>",
    );
  }
  return lines;
}

/**
 * Renders the whole screen.
 * @param input - Rows, zone, and ingest facts.
 * @returns The report text, lines joined with newlines.
 */
export function renderReport(input: ReportInput): string {
  const header = [
    LABELS.title,
    `Times are in ${input.timeZone}. Last ingest: ${input.lastIngestAt === null ? "none yet" : formatInstant(input.lastIngestAt, input.timeZone)}. Database: ${displayPath(input.databasePath, input.home)}`,
    "",
  ];
  // A first run has nothing to report; say what produces the numbers instead of printing empty
  // sections. `--json` is unchanged, so anything reading this programmatically still sees the
  // same shape (R2.5).
  if (hasNoData(input.observed)) {
    return [...header, ...renderFirstRun()].join("\n");
  }
  return [
    ...header,
    ...renderObserved(input.observed, input.timeZone, input.home),
    "",
    ...renderProjected(input.projected, input.timeZone),
  ].join("\n");
}

/**
 * Reports whether nothing has been recorded yet: no status line readings and no requests.
 * @param observed - The observed report.
 * @returns True when neither source has produced a row.
 */
export function hasNoData(observed: ObservedReport): boolean {
  return observed.windows.length === 0 && observed.byModel.length === 0;
}

/**
 * What to do next, shown instead of a page of empty sections on a first run.
 *
 * Every section of the report says "no data yet" on its own, which is correct and useless: a new
 * user reads forty lines to learn that nothing happened, and nothing tells them the two sources
 * arrive separately or that readings need a terminal. This replaces the sections until there is
 * something to show (R2.5).
 * @returns Lines for stdout.
 */
export function renderFirstRun(): string[] {
  return [
    "Nothing has been recorded yet.",
    "",
    "Two sources feed this report, and they arrive separately:",
    "  Session logs hold tokens, models, and repositories. `init` read whatever was already there,",
    "    and `nilometer ingest` reads what Claude Code writes from now on.",
    "  Status line readings hold the plan's usage percentages and its limits. They are written only",
    "    while Claude Code runs in a terminal; the VS Code extension doesn't run the status line.",
    "",
    "Use Claude Code in a terminal, then run `nilometer ingest` and this report again.",
    "Usage percentages cover the time since the hook was installed; tokens cover every log still on disk.",
  ];
}

/**
 * Builds the `--json` output: unrounded rows, kept in separate observed and projected objects,
 * with the labels the table uses.
 * @param input - Rows, zone, and ingest facts.
 * @returns A JSON-serializable object.
 */
export function reportJson(input: ReportInput): object {
  return {
    timeZone: input.timeZone,
    lastIngestAt: input.lastIngestAt,
    databasePath: input.databasePath,
    // Unrounded, unshortened values: JSON is for tools, and a path under ~ would need expanding back.
    labels: LABELS,
    observed: input.observed,
    projected: input.projected,
  };
}
