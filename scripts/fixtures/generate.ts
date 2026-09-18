/**
 * @file Generates the synthetic session-log fixtures under `fixtures/` (docs/development.md P2.1).
 *
 * Every line follows the shape Claude Code writes (observed 2026-09-12; `ingest-session-logs`
 * skill § Fields), but every ID, path, timestamp, and token count is invented. Output is fully
 * deterministic: no clocks, no randomness. Running the generator twice leaves no git diff.
 *
 * Only the log trees (`projects/`, `run-N/`) are generated. Each case's `expected.json` and
 * `README.md` are written by hand, so the expected results never come from code under test.
 * See fixtures/README.md for the rules those results follow.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Claude Code version stamped on every generated line (a real version string, invented use). */
export const FIXTURE_VERSION = "2.1.269";

/** Encoded project directory name, as Claude Code derives it from the working directory. */
export const PROJECT_DIR = "-fixture-demo";

/** Working directory recorded on generated lines unless a case overrides it. */
export const DEFAULT_CWD = "/fixture/demo";

/** Default model for generated requests. */
export const SONNET = "claude-sonnet-5";

/** Token counts for one `message.usage` object. */
export interface UsageSpec {
  /** `input_tokens`; omitted from the object when undefined. */
  readonly input?: number;
  /** `output_tokens`; omitted from the object when undefined. */
  readonly output?: number;
  /** `cache_read_input_tokens`; omitted when undefined. */
  readonly cacheRead?: number;
  /** `cache_creation.ephemeral_5m_input_tokens` (split form). */
  readonly cache5m?: number;
  /** `cache_creation.ephemeral_1h_input_tokens` (split form). */
  readonly cache1h?: number;
  /** When set, writes only `cache_creation_input_tokens` (older logs without the split object). */
  readonly unsplit?: number;
  /** Extra `iterations[]` entries after the default message iteration. */
  readonly extraIterations?: readonly Record<string, unknown>[];
}

/**
 * Builds a `message.usage` object.
 * @param spec - Token counts; missing counts are omitted, so fixtures can exercise missing fields.
 * @returns A usage object shaped like Claude Code's.
 */
export function usage(spec: UsageSpec): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // Assignment order mirrors real logs, which keeps generated lines easy to compare by eye.
  if (spec.input !== undefined) result["input_tokens"] = spec.input;
  if (spec.unsplit !== undefined) {
    result["cache_creation_input_tokens"] = spec.unsplit;
  } else {
    result["cache_creation_input_tokens"] = (spec.cache5m ?? 0) + (spec.cache1h ?? 0);
  }
  if (spec.cacheRead !== undefined) result["cache_read_input_tokens"] = spec.cacheRead;
  if (spec.output !== undefined) result["output_tokens"] = spec.output;
  result["service_tier"] = "standard";
  if (spec.unsplit === undefined) {
    result["cache_creation"] = {
      ephemeral_1h_input_tokens: spec.cache1h ?? 0,
      ephemeral_5m_input_tokens: spec.cache5m ?? 0,
    };
  }
  result["iterations"] = [{ type: "message" }, ...(spec.extraIterations ?? [])];
  return result;
}

/** Fields shared by every generated line. */
export interface LineBase {
  /** `sessionId`. */
  readonly session: string;
  /** `uuid`. */
  readonly uuid: string;
  /** `timestamp` (raw string, so fixtures can include unparseable values). */
  readonly ts: string;
  /** `cwd`; defaults to {@link DEFAULT_CWD}. */
  readonly cwd?: string;
  /** `isSidechain`; defaults to false. */
  readonly sidechain?: boolean;
}

/**
 * Builds the envelope fields every log line carries, in Claude Code's key order.
 * @param base - Session, UUID, timestamp, and optional cwd and sidechain flag.
 * @returns The leading envelope fields.
 */
function envelope(base: LineBase): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: base.sidechain ?? false,
    userType: "external",
    cwd: base.cwd ?? DEFAULT_CWD,
    sessionId: base.session,
    version: FIXTURE_VERSION,
    gitBranch: "main",
  };
}

/**
 * Builds a user prompt line.
 * @param base - Common line fields.
 * @returns A `type: "user"` line object.
 */
export function userLine(base: LineBase): Record<string, unknown> {
  return {
    ...envelope(base),
    type: "user",
    message: { role: "user", content: "synthetic prompt" },
    uuid: base.uuid,
    timestamp: base.ts,
  };
}

/** Inputs for {@link assistantLine}. */
export interface AssistantSpec extends LineBase {
  /** `message.id`; omitted when undefined. */
  readonly messageId?: string;
  /** `requestId`; omitted when undefined. */
  readonly requestId?: string;
  /** `message.model`; defaults to {@link SONNET}. */
  readonly model?: string;
  /** Token counts. */
  readonly usage: UsageSpec;
  /** `message.stop_reason`; defaults to `end_turn`. */
  readonly stopReason?: string | null;
}

/**
 * Builds an assistant response line with usage.
 * @param spec - IDs, model, token counts, and common fields.
 * @returns A `type: "assistant"` line object.
 */
export function assistantLine(spec: AssistantSpec): Record<string, unknown> {
  const message: Record<string, unknown> = {};
  if (spec.messageId !== undefined) message["id"] = spec.messageId;
  message["type"] = "message";
  message["role"] = "assistant";
  message["model"] = spec.model ?? SONNET;
  message["content"] = [{ type: "text", text: "synthetic reply" }];
  message["stop_reason"] = spec.stopReason === undefined ? "end_turn" : spec.stopReason;
  message["usage"] = usage(spec.usage);
  const line: Record<string, unknown> = { ...envelope(spec), message };
  if (spec.requestId !== undefined) line["requestId"] = spec.requestId;
  line["type"] = "assistant";
  line["uuid"] = spec.uuid;
  line["timestamp"] = spec.ts;
  return line;
}

/**
 * Builds several streaming snapshots of one response: identical except for the output count.
 * @param spec - The response; its `usage.output` is ignored.
 * @param outputs - Output token count for each snapshot, in write order.
 * @returns One line object per snapshot, with UUIDs suffixed `-1`, `-2`, ...
 */
export function streamingSnapshots(
  spec: AssistantSpec,
  outputs: readonly number[],
): Record<string, unknown>[] {
  return outputs.map((output, index) =>
    assistantLine({ ...spec, uuid: `${spec.uuid}-${index + 1}`, usage: { ...spec.usage, output } }),
  );
}

/** Inputs for {@link syntheticLine}. */
export interface SyntheticSpec extends LineBase {
  /** Message text shown to the user. */
  readonly text: string;
  /** Top-level `error`; omitted when undefined. */
  readonly error?: string;
  /** `apiErrorStatus`; omitted when undefined. */
  readonly status?: number;
  /** `isApiErrorMessage`; omitted when undefined. */
  readonly apiError?: boolean;
  /** `message.id`; omitted when undefined. */
  readonly messageId?: string;
  /** `requestId`; omitted when undefined. */
  readonly requestId?: string;
}

/**
 * Builds a `<synthetic>` assistant line, the shape Claude Code writes for limit hits and API errors.
 * @param spec - Text, error fields, and common fields.
 * @returns A synthetic assistant line object with zero usage.
 */
export function syntheticLine(spec: SyntheticSpec): Record<string, unknown> {
  const message: Record<string, unknown> = {};
  if (spec.messageId !== undefined) message["id"] = spec.messageId;
  message["type"] = "message";
  message["role"] = "assistant";
  message["model"] = "<synthetic>";
  message["content"] = [{ type: "text", text: spec.text }];
  message["stop_reason"] = "stop_sequence";
  // Real synthetic lines carry a zero usage object, which is exactly what makes them look like requests.
  message["usage"] = usage({ input: 0, output: 0, cacheRead: 0 });
  const line: Record<string, unknown> = { ...envelope(spec), message };
  if (spec.requestId !== undefined) line["requestId"] = spec.requestId;
  line["type"] = "assistant";
  line["uuid"] = spec.uuid;
  line["timestamp"] = spec.ts;
  if (spec.error !== undefined) line["error"] = spec.error;
  if (spec.status !== undefined) line["apiErrorStatus"] = spec.status;
  if (spec.apiError !== undefined) line["isApiErrorMessage"] = spec.apiError;
  return line;
}

/**
 * Builds a `system`/`api_error` retry notice (D-019).
 * @param base - Common line fields.
 * @param status - `error.status`.
 * @param rateLimits - `error.rateLimits`; null in every observed line so far.
 * @returns A retry notice line object.
 */
export function retryNoticeLine(
  base: LineBase,
  status: number,
  rateLimits: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    ...envelope(base),
    type: "system",
    subtype: "api_error",
    level: "error",
    error: {
      message: "Request failed",
      formatted: `API Error: ${status}`,
      status,
      isNetworkDown: false,
      rateLimits,
    },
    retryInMs: 1000,
    retryAttempt: 1,
    maxRetries: 10,
    source: "request_retry",
    uuid: base.uuid,
    timestamp: base.ts,
  };
}

/**
 * Builds a system line with a subtype that ingestion ignores.
 * @param base - Common line fields.
 * @param subtype - The `subtype` value.
 * @returns A system line object.
 */
export function systemLine(base: LineBase, subtype: string): Record<string, unknown> {
  return { ...envelope(base), type: "system", subtype, uuid: base.uuid, timestamp: base.ts };
}

/**
 * Serializes lines as JSONL: one compact JSON value per line, each ending in `\n`.
 * @param lines - Line objects, or raw strings written verbatim (for malformed lines).
 * @returns The file contents.
 */
export function toJsonl(lines: readonly (Record<string, unknown> | unknown[] | string)[]): string {
  return lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join("");
}

/** One generated fixture case. */
export interface FixtureCase {
  /** Directory name under `fixtures/`, prefixed with the skill's case number. */
  readonly id: string;
  /** Files to write, keyed by path relative to the case directory. */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Returns a session log path under a state directory.
 * @param state - `projects` for single-state cases, or `run-1`, `run-2`.
 * @param session - Session ID, used as the file name.
 * @returns Relative file path.
 */
export function sessionPath(state: string, session: string): string {
  // Multi-run states nest a projects/ directory so each state works as CLAUDE_CONFIG_DIR.
  // "/" on every platform: these are fixture-relative names, matching what discovery stores (D-049).
  const root = state === "projects" ? "projects" : `${state}/projects`;
  return `${root}/${PROJECT_DIR}/${session}.jsonl`;
}

/** Day used by most fixtures. */
const DAY = "2026-09-01";

/**
 * Builds a timestamp on the fixture day.
 * @param time - `HH:MM:SS`.
 * @returns An ISO-8601 UTC timestamp with milliseconds.
 */
function at(time: string): string {
  return `${DAY}T${time}.000Z`;
}

/**
 * Builds every fixture case. Token counts are small and distinct so expected totals can be added
 * up by hand.
 * @returns All cases, in case-number order.
 */
export function buildCases(): FixtureCase[] {
  const s01 = "s01";
  const response01 = {
    session: s01,
    uuid: "u01-a",
    ts: at("10:00:02"),
    messageId: "msg_01a",
    requestId: "req_01a",
    usage: { input: 10, cacheRead: 1000, cache5m: 0, cache1h: 200 },
  };

  const response02 = {
    session: "s02",
    uuid: "u02-a",
    ts: at("10:00:02"),
    messageId: "msg_02a",
    requestId: "req_02a",
    usage: { input: 10, cacheRead: 500, cache5m: 0, cache1h: 0 },
  };
  const lines02 = [
    userLine({ session: "s02", uuid: "u02-0", ts: at("10:00:00") }),
    ...streamingSnapshots(response02, [5, 20, 42]),
  ];

  const lines03Complete = [
    userLine({ session: "s03", uuid: "u03-0", ts: at("10:00:00") }),
    assistantLine({
      session: "s03",
      uuid: "u03-a",
      ts: at("10:00:01"),
      messageId: "msg_03a",
      requestId: "req_03a",
      usage: { input: 2, output: 9, cacheRead: 0 },
    }),
  ];
  const line03b = JSON.stringify(
    assistantLine({
      session: "s03",
      uuid: "u03-b",
      ts: at("10:00:05"),
      messageId: "msg_03b",
      requestId: "req_03b",
      usage: { input: 3, output: 11, cacheRead: 0 },
    }),
  );

  const lines12Run1 = [
    assistantLine({ session: "s12", uuid: "u12-a", ts: at("10:00:01"), messageId: "msg_12a", requestId: "req_12a", usage: { input: 1, output: 10, cacheRead: 0 } }),
    assistantLine({ session: "s12", uuid: "u12-b", ts: at("10:00:02"), messageId: "msg_12b", requestId: "req_12b", usage: { input: 2, output: 20, cacheRead: 0 } }),
    assistantLine({ session: "s12", uuid: "u12-c", ts: at("10:00:03"), messageId: "msg_12c", requestId: "req_12c", usage: { input: 3, output: 30, cacheRead: 0 } }),
  ];

  const retryBase = { session: "s15", cwd: DEFAULT_CWD };

  return [
    {
      id: "01-streaming-snapshots",
      files: {
        [sessionPath("projects", s01)]: toJsonl([
          userLine({ session: s01, uuid: "u01-0", ts: at("10:00:00") }),
          ...streamingSnapshots(response01, [5, 20, 42]),
          userLine({ session: s01, uuid: "u01-1", ts: at("10:01:00") }),
          assistantLine({
            session: s01,
            uuid: "u01-b",
            ts: at("10:01:02"),
            messageId: "msg_01b",
            requestId: "req_01b",
            usage: { input: 3, output: 7, cacheRead: 1200, cache5m: 0, cache1h: 0 },
          }),
        ]),
      },
    },
    {
      id: "02-split-across-runs",
      files: {
        // run-1 is written while the response is still streaming: only the first two snapshots exist.
        [sessionPath("run-1", "s02")]: toJsonl(lines02.slice(0, 3)),
        [sessionPath("run-2", "s02")]: toJsonl(lines02),
      },
    },
    {
      id: "03-trailing-fragment",
      files: {
        // A scan landing mid-write sees the first 40 bytes of the next line, with no newline yet.
        [sessionPath("run-1", "s03")]: `${toJsonl(lines03Complete)}${line03b.slice(0, 40)}`,
        [sessionPath("run-2", "s03")]: toJsonl([...lines03Complete, line03b]),
      },
    },
    {
      id: "04-btw-replay",
      files: {
        [sessionPath("projects", "s04")]: toJsonl([
          userLine({ session: "s04", uuid: "u04-0", ts: at("10:00:00") }),
          assistantLine({ session: "s04", uuid: "u04-a", ts: at("10:00:02"), messageId: "msg_04a", requestId: "req_04a", usage: { input: 4, output: 30, cacheRead: 0 } }),
          // A /btw side question replays the parent response under a new requestId (ccusage#913).
          assistantLine({ session: "s04", uuid: "u04-r", ts: at("10:00:09"), messageId: "msg_04a", requestId: "req_04z", sidechain: true, usage: { input: 4, output: 30, cacheRead: 0 } }),
        ]),
      },
    },
    {
      id: "05-missing-ids",
      files: {
        [sessionPath("projects", "s05")]: toJsonl([
          assistantLine({ session: "s05", uuid: "u05-1", ts: at("10:00:01"), requestId: "req_05a", usage: { input: 1, output: 4, cacheRead: 0 } }),
          assistantLine({ session: "s05", uuid: "u05-2", ts: at("10:00:02"), requestId: "req_05a", usage: { input: 1, output: 8, cacheRead: 0 } }),
          assistantLine({ session: "s05", uuid: "u05-3", ts: at("10:00:03"), messageId: "msg_05b", usage: { input: 1, output: 6, cacheRead: 0 } }),
          assistantLine({ session: "s05", uuid: "u05-4", ts: at("10:00:04"), usage: { input: 1, output: 2, cacheRead: 0 } }),
          assistantLine({ session: "s05", uuid: "u05-5", ts: at("10:00:05"), usage: { input: 1, output: 3, cacheRead: 0 } }),
        ]),
      },
    },
    {
      id: "06-mixed-models",
      files: {
        [sessionPath("projects", "s06")]: toJsonl([
          assistantLine({ session: "s06", uuid: "u06-a", ts: at("10:00:01"), messageId: "msg_06a", requestId: "req_06a", usage: { input: 100, output: 10, cacheRead: 0 } }),
          assistantLine({ session: "s06", uuid: "u06-b", ts: at("10:00:02"), messageId: "msg_06b", requestId: "req_06b", model: "claude-opus-5", usage: { input: 200, output: 50, cacheRead: 0 } }),
          assistantLine({ session: "s06", uuid: "u06-c", ts: at("10:00:03"), messageId: "msg_06c", requestId: "req_06c", model: "claude-haiku-4-5-20251001", usage: { input: 20, output: 5, cacheRead: 0 } }),
          assistantLine({ session: "s06", uuid: "u06-d", ts: at("10:00:04"), messageId: "msg_06d", requestId: "req_06d", usage: { input: 50, output: 15, cacheRead: 0 } }),
        ]),
      },
    },
    {
      id: "07-utc-midnight",
      files: {
        [sessionPath("projects", "s07")]: toJsonl([
          assistantLine({ session: "s07", uuid: "u07-a", ts: "2026-09-01T23:59:58.000Z", messageId: "msg_07a", requestId: "req_07a", usage: { input: 1, output: 10, cacheRead: 0 } }),
          assistantLine({ session: "s07", uuid: "u07-b", ts: "2026-09-02T00:00:03.000Z", messageId: "msg_07b", requestId: "req_07b", usage: { input: 2, output: 20, cacheRead: 0 } }),
          // +02:00 offset: 01:30 local on Sept 2 is 23:30 UTC on Sept 1.
          assistantLine({ session: "s07", uuid: "u07-c", ts: "2026-09-02T01:30:00.000+02:00", messageId: "msg_07c", requestId: "req_07c", usage: { input: 3, output: 30, cacheRead: 0 } }),
        ]),
      },
    },
    {
      id: "08-limit-hits",
      files: {
        [sessionPath("projects", "s08")]: toJsonl([
          userLine({ session: "s08", uuid: "u08-0", ts: at("10:00:00") }),
          assistantLine({ session: "s08", uuid: "u08-a", ts: at("10:00:02"), messageId: "msg_08a", requestId: "req_08a", stopReason: "tool_use", usage: { input: 5, output: 12, cacheRead: 0 } }),
          syntheticLine({ session: "s08", uuid: "u08-l1", ts: at("10:00:05"), messageId: "msg_08l1", requestId: "req_08l1", apiError: true, error: "rate_limit", status: 429, text: "You've hit your session limit · resets 6:10am (UTC)" }),
          syntheticLine({ session: "s08", uuid: "u08-l2", ts: at("11:00:00"), messageId: "msg_08l2", requestId: "req_08l2", apiError: true, error: "rate_limit", status: 429, text: "You've hit your weekly limit · resets Sep 5, 9am (UTC)" }),
          syntheticLine({ session: "s08", uuid: "u08-l3", ts: at("12:00:00"), messageId: "msg_08l3", requestId: "req_08l3", apiError: true, error: "rate_limit", status: 429, text: "5-hour limit reached ∙ resets 2am" }),
          syntheticLine({ session: "s08", uuid: "u08-l4", ts: at("13:00:00"), messageId: "msg_08l4", requestId: "req_08l4", apiError: true, error: "rate_limit", status: 429, text: "Usage limit reached" }),
        ]),
      },
    },
    {
      id: "09-api-errors",
      files: {
        [sessionPath("projects", "s09")]: toJsonl([
          syntheticLine({ session: "s09", uuid: "u09-1", ts: at("10:00:01"), apiError: true, error: "server_error", status: 529, text: "API Error: 529 Overloaded. This is a server-side issue, usually temporary." }),
          syntheticLine({ session: "s09", uuid: "u09-2", ts: at("10:00:02"), apiError: true, error: "billing_error", status: 402, text: "API Error: 402" }),
          syntheticLine({ session: "s09", uuid: "u09-3", ts: at("10:00:03"), apiError: true, text: "API Error: unknown" }),
          syntheticLine({ session: "s09", uuid: "u09-4", ts: at("10:00:04"), text: "No response requested." }),
          assistantLine({ session: "s09", uuid: "u09-a", ts: at("10:00:05"), messageId: "msg_09a", requestId: "req_09a", usage: { input: 1, output: 3, cacheRead: 0 } }),
        ]),
      },
    },
    {
      id: "10-malformed-lines",
      files: {
        [sessionPath("projects", "s10")]: toJsonl([
          assistantLine({ session: "s10", uuid: "u10-a", ts: at("10:00:01"), messageId: "msg_10a", requestId: "req_10a", usage: { input: 1, output: 5, cacheRead: 0 } }),
          '{"type":"assistant","message":',
          [1, 2, 3],
          assistantLine({ session: "s10", uuid: "u10-b", ts: at("10:00:04"), messageId: "msg_10b", requestId: "req_10b", usage: { input: 2, output: 6, cacheRead: 0 } }),
        ]),
      },
    },
    {
      id: "11-subagent-file",
      files: {
        [sessionPath("projects", "s11")]: toJsonl([
          userLine({ session: "s11", uuid: "u11-0", ts: at("10:00:00") }),
          assistantLine({ session: "s11", uuid: "u11-a", ts: at("10:00:02"), messageId: "msg_11a", requestId: "req_11a", usage: { input: 10, output: 20, cacheRead: 0 } }),
        ]),
        [join("projects", PROJECT_DIR, "s11", "subagents", "agent-a1.jsonl")]: toJsonl([
          userLine({ session: "s11", uuid: "u11-s0", ts: at("10:00:03"), sidechain: true }),
          assistantLine({ session: "s11", uuid: "u11-s", ts: at("10:00:04"), messageId: "msg_11s", requestId: "req_11s", sidechain: true, usage: { input: 30, output: 40, cacheRead: 0 } }),
        ]),
      },
    },
    {
      id: "12-rewritten-file",
      files: {
        [sessionPath("run-1", "s12")]: toJsonl(lines12Run1),
        // Rewritten shorter between runs (e.g. compaction): msg_12b and msg_12c are gone from disk.
        [sessionPath("run-2", "s12")]: toJsonl([
          lines12Run1[0]!,
          assistantLine({ session: "s12", uuid: "u12-d", ts: at("10:05:00"), messageId: "msg_12d", requestId: "req_12d", usage: { input: 4, output: 5, cacheRead: 0 } }),
        ]),
      },
    },
    {
      id: "14-worktree-cwd",
      files: {
        [sessionPath("projects", "s14a")]: toJsonl([
          assistantLine({ session: "s14a", uuid: "u14-a", ts: at("10:00:01"), cwd: "{{REPO}}", messageId: "msg_14a", requestId: "req_14a", usage: { input: 1, output: 10, cacheRead: 0 } }),
        ]),
        [sessionPath("projects", "s14b")]: toJsonl([
          assistantLine({ session: "s14b", uuid: "u14-b", ts: at("10:00:02"), cwd: "{{REPO}}-worktree", messageId: "msg_14b", requestId: "req_14b", usage: { input: 2, output: 20, cacheRead: 0 } }),
        ]),
        [sessionPath("projects", "s14c")]: toJsonl([
          assistantLine({ session: "s14c", uuid: "u14-c", ts: at("10:00:03"), cwd: "{{REPO}}/packages/sub", messageId: "msg_14c", requestId: "req_14c", usage: { input: 3, output: 5, cacheRead: 0 } }),
        ]),
      },
    },
    {
      id: "15-retry-notices",
      files: {
        [sessionPath("projects", "s15")]: toJsonl([
          retryNoticeLine({ ...retryBase, uuid: "u15-1", ts: at("10:00:01") }, 429, null),
          retryNoticeLine({ ...retryBase, uuid: "u15-2", ts: at("10:00:02") }, 429, { five_hour: { used_percentage: 100 } }),
          assistantLine({ session: "s15", uuid: "u15-a", ts: at("10:00:04"), messageId: "msg_15a", requestId: "req_15a", usage: { input: 2, output: 8, cacheRead: 0 } }),
          systemLine({ ...retryBase, uuid: "u15-3", ts: at("10:00:05") }, "turn_duration"),
        ]),
      },
    },
    {
      id: "16-cache-write-forms",
      files: {
        [sessionPath("projects", "s16")]: toJsonl([
          assistantLine({ session: "s16", uuid: "u16-a", ts: at("10:00:01"), messageId: "msg_16a", requestId: "req_16a", usage: { input: 5, output: 10, cacheRead: 50, cache5m: 300, cache1h: 700 } }),
          assistantLine({ session: "s16", uuid: "u16-b", ts: at("10:00:02"), messageId: "msg_16b", requestId: "req_16b", usage: { input: 6, output: 20, cacheRead: 60, unsplit: 400 } }),
        ]),
      },
    },
    {
      id: "17-report-edges",
      files: {
        [sessionPath("projects", "s17")]: toJsonl([
          assistantLine({ session: "s17", uuid: "u17-a", ts: at("10:00:01"), messageId: "msg_17a", requestId: "req_17a", usage: { input: 1, cacheRead: 0 } }),
          assistantLine({ session: "s17", uuid: "u17-b", ts: "not-a-time", messageId: "msg_17b", requestId: "req_17b", usage: { input: 2, output: 7, cacheRead: 0 } }),
          assistantLine({ session: "s17", uuid: "u17-c", ts: at("10:00:03"), messageId: "msg_17c", requestId: "req_17c", usage: { input: 3, output: 9, cacheRead: 0, extraIterations: [{ type: "advisor", model: "claude-opus-5" }] } }),
        ]),
      },
    },
    {
      // One response written as two cumulative snapshots that straddle UTC midnight. Which day it
      // counts on depends on which snapshot dates it, and nothing else in the fixtures covers that
      // (D-058). The winner by output tokens is the second line, so the request is dated 09-02.
      id: "18-streaming-across-midnight",
      files: {
        [sessionPath("projects", "s18")]: toJsonl([
          assistantLine({ session: "s18", uuid: "u18-a-1", ts: "2026-09-01T23:59:58.000Z", messageId: "msg_18a", requestId: "req_18a", usage: { input: 5, output: 10, cacheRead: 0 } }),
          assistantLine({ session: "s18", uuid: "u18-a-2", ts: "2026-09-02T00:00:03.000Z", messageId: "msg_18a", requestId: "req_18a", usage: { input: 5, output: 25, cacheRead: 0 } }),
        ]),
      },
    },
    {
      // One response whose lines all carry the SAME token counts, straddling UTC midnight. Case 18
      // has growing counts, so "largest output wins" picks the last line on its own; here it picks
      // nothing and the tie-break decides which day the response lands on (D-065). Observed on a
      // real log set: three lines, identical counts, 23:59:57 to 00:00:01.
      id: "19-repeated-snapshot-across-midnight",
      files: {
        [sessionPath("projects", "s19")]: toJsonl([
          assistantLine({ session: "s19", uuid: "u19-a-1", ts: "2026-09-01T23:59:57.000Z", messageId: "msg_19a", requestId: "req_19a", usage: { input: 2, output: 30, cacheRead: 0 } }),
          assistantLine({ session: "s19", uuid: "u19-a-2", ts: "2026-09-01T23:59:58.000Z", messageId: "msg_19a", requestId: "req_19a", usage: { input: 2, output: 30, cacheRead: 0 } }),
          assistantLine({ session: "s19", uuid: "u19-a-3", ts: "2026-09-02T00:00:01.000Z", messageId: "msg_19a", requestId: "req_19a", usage: { input: 2, output: 30, cacheRead: 0 } }),
        ]),
      },
    },
  ];
}

/**
 * Writes one case's generated log trees, replacing only previously generated directories.
 * @param fixturesRoot - The `fixtures/` directory.
 * @param fixture - The case to write.
 */
export function writeCase(fixturesRoot: string, fixture: FixtureCase): void {
  const caseDir = join(fixturesRoot, fixture.id);
  // Remove only generated trees; hand-written expected.json and README.md must survive.
  for (const generated of ["projects", "run-1", "run-2"]) {
    rmSync(join(caseDir, generated), { recursive: true, force: true });
  }
  for (const [relative, content] of Object.entries(fixture.files)) {
    const path = join(caseDir, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

/**
 * Generates every case under a fixtures directory.
 * @param fixturesRoot - The `fixtures/` directory.
 * @param print - Receives one summary line.
 * @returns The IDs of the cases written.
 */
export function main(fixturesRoot: string, print: (line: string) => void): string[] {
  const cases = buildCases();
  cases.forEach((fixture) => {
    writeCase(fixturesRoot, fixture);
  });
  print(`generated ${cases.length} fixture cases in ${fixturesRoot}`);
  return cases.map((fixture) => fixture.id);
}
