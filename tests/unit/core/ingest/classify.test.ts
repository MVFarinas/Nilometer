/**
 * @file Unit tests for core/ingest/classify.ts (docs/development.md P4.4). One or more tests per rule in
 * fixtures/README.md.
 */
import { describe, expect, it } from "vitest";

import {
  LINE_CLASSES,
  type LogObject,
  MAX_RESETS_AT,
  MISSING,
  classifyLine,
  dedupKey,
  extractEvent,
  extractLinks,
  extractRequest,
  identityString,
  ignoredTypeKey,
  isNumber,
  isObject,
  messageText,
  nonEmptyString,
  objectField,
  parseLimitText,
  parseLine,
  parseQuotaLimits,
  parseTimestamp,
} from "../../../../core/ingest/classify.js";

/**
 * Builds an assistant request line with a usage object.
 * @param extra - Fields merged over the defaults.
 * @param usage - The usage object.
 * @returns A parsed log object.
 */
function request(
  extra: Record<string, unknown> = {},
  usage: Record<string, unknown> = {},
): LogObject {
  return {
    type: "assistant",
    sessionId: "s1",
    requestId: "req_1",
    message: { id: "msg_1", model: "claude-sonnet-5", usage },
    ...extra,
  };
}

describe("parseLine and small helpers", () => {
  it.each([
    ["an object", '{"a":1}', { a: 1 }],
    ["an array", "[1,2]", null],
    ["null", "null", null],
    ["a string", '"x"', null],
    ["invalid JSON", '{"a":', null],
    ["an empty line", "", null],
    ["an object with CRLF whitespace", '{"a":1}\r', { a: 1 }],
  ])("parses %s", (_name, text, expected) => {
    expect(parseLine(Buffer.from(text))).toEqual(expected);
  });

  it("recognizes plain objects only", () => {
    expect(isObject({})).toBe(true);
    expect(isObject([])).toBe(false);
    expect(isObject(null)).toBe(false);
    expect(isObject("x")).toBe(false);
  });

  it("reads nested object fields, returning null for anything else", () => {
    expect(objectField({ m: { x: 1 } }, "m")).toEqual({ x: 1 });
    expect(objectField({ m: [1] }, "m")).toBeNull();
    expect(objectField({ m: "x" }, "m")).toBeNull();
    expect(objectField("not an object", "m")).toBeNull();
    expect(objectField({}, "m")).toBeNull();
  });

  it("treats only JSON numbers as numbers", () => {
    expect(isNumber(3)).toBe(true);
    expect(isNumber(1.5)).toBe(true);
    expect(isNumber(true)).toBe(false);
    expect(isNumber("3")).toBe(false);
    expect(isNumber(null)).toBe(false);
  });

  it("labels absent or non-string identity values as missing", () => {
    expect(identityString("s")).toBe("s");
    expect(identityString("")).toBe("");
    expect(identityString(undefined)).toBe(MISSING);
    expect(identityString(7)).toBe(MISSING);
    expect(MISSING).toBe("<missing>");
  });

  it("returns non-empty strings only", () => {
    expect(nonEmptyString("x")).toBe("x");
    expect(nonEmptyString("")).toBeNull();
    expect(nonEmptyString(5)).toBeNull();
  });
});

describe("classifyLine", () => {
  it("lists the seven classes in precedence order", () => {
    expect(LINE_CLASSES).toEqual([
      "malformed",
      "limit_hit",
      "api_error",
      "synthetic_other",
      "request",
      "retry_notice",
      "ignored_type",
    ]);
  });

  it.each<[string, LogObject | null, string]>([
    ["an unparsed line", null, "malformed"],
    ["a rate_limit error line", { isApiErrorMessage: true, error: "rate_limit" }, "limit_hit"],
    ["another error line", { isApiErrorMessage: true, error: "server_error" }, "api_error"],
    ["an error line without error", { isApiErrorMessage: true }, "api_error"],
    [
      "a synthetic line",
      { type: "assistant", message: { model: "<synthetic>", usage: {} } },
      "synthetic_other",
    ],
    ["an assistant line with usage", request(), "request"],
    [
      "an assistant line without usage",
      { type: "assistant", message: { model: "m" } },
      "ignored_type",
    ],
    [
      "an assistant line whose usage isn't an object",
      { type: "assistant", message: { usage: 5 } },
      "ignored_type",
    ],
    ["a retry notice", { type: "system", subtype: "api_error" }, "retry_notice"],
    ["another system line", { type: "system", subtype: "turn_duration" }, "ignored_type"],
    ["a user line", { type: "user" }, "ignored_type"],
  ])("classifies %s", (_name, line, expected) => {
    expect(classifyLine(line)).toBe(expected);
  });

  it("tests error lines before the request rule, even with a usage object", () => {
    expect(classifyLine(request({ isApiErrorMessage: true, error: "rate_limit" }))).toBe(
      "limit_hit",
    );
  });

  it("tests the synthetic model before the request rule", () => {
    const line = request({ message: { model: "<synthetic>", usage: { output_tokens: 0 } } });
    expect(classifyLine(line)).toBe("synthetic_other");
  });

  it("requires isApiErrorMessage to be exactly true", () => {
    expect(classifyLine(request({ isApiErrorMessage: "true", error: "rate_limit" }))).toBe(
      "request",
    );
  });
});

describe("dedupKey", () => {
  it("keys on message.id first", () => {
    expect(dedupKey(request())).toBe("s1/m/msg_1");
  });

  it("falls back to requestId when message.id is missing or empty", () => {
    expect(dedupKey(request({ message: { usage: {} } }))).toBe("s1/r/req_1");
    expect(dedupKey(request({ message: { id: "", usage: {} } }))).toBe("s1/r/req_1");
  });

  it("returns null when neither ID is a non-empty string", () => {
    expect(dedupKey(request({ message: { id: 5, usage: {} }, requestId: "" }))).toBeNull();
  });

  it("uses the missing label for an absent session ID", () => {
    expect(dedupKey(request({ sessionId: undefined }))).toBe("<missing>/m/msg_1");
  });
});

describe("extractRequest", () => {
  it("reads token counts, IDs, model, speed, and the split cache writes", () => {
    const line = request(
      {},
      {
        input_tokens: 10,
        output_tokens: 42,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 999,
        cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 200 },
        speed: "fast",
        service_tier: "priority",
        inference_geo: "us",
      },
    );
    expect(extractRequest(line)).toEqual({
      dedupKey: "s1/m/msg_1",
      messageId: "msg_1",
      requestId: "req_1",
      model: "claude-sonnet-5",
      inputTokens: 10,
      outputTokens: 42,
      cacheReadTokens: 1000,
      cacheWrite5mTokens: 3,
      cacheWrite1hTokens: 200,
      cacheWriteUnsplitTokens: null,
      speed: "fast",
      serviceTier: "priority",
      inferenceGeo: "us",
      missingFields: [],
      nonMessageIterations: [],
    });
  });

  it("uses the unsplit total only when the split object is absent", () => {
    const fields = extractRequest(
      request(
        {},
        {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 400,
        },
      ),
    );
    expect(fields).toMatchObject({
      cacheWrite5mTokens: null,
      cacheWrite1hTokens: null,
      cacheWriteUnsplitTokens: 400,
    });
  });

  it("defaults missing cache-write values to 0 silently", () => {
    const fields = extractRequest(
      request(
        {},
        {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: "x" },
        },
      ),
    );
    expect(fields).toMatchObject({
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      missingFields: [],
    });
    expect(
      extractRequest(request({}, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 }))
        .cacheWriteUnsplitTokens,
    ).toBe(0);
  });

  it("defaults missing or non-numeric reported fields to 0 and lists them by log name", () => {
    const fields = extractRequest(request({}, { input_tokens: true, output_tokens: "7" }));
    expect(fields).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    expect(fields.missingFields).toEqual([
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
    ]);
  });

  it("returns null IDs and speed for non-strings and the missing label for the model", () => {
    const fields = extractRequest({
      type: "assistant",
      requestId: 7,
      message: { id: 9, model: 3, usage: { speed: 1 } },
    });
    expect(fields).toMatchObject({
      messageId: null,
      requestId: null,
      model: MISSING,
      speed: null,
      serviceTier: null,
      inferenceGeo: null,
    });
  });

  it("lists iteration types other than message, skipping non-object entries", () => {
    const fields = extractRequest(
      request(
        {},
        {
          iterations: [
            { type: "message" },
            { type: "advisor" },
            "junk",
            { model: "x" },
            { type: "fallback_message" },
          ],
        },
      ),
    );
    expect(fields.nonMessageIterations).toEqual(["advisor", MISSING, "fallback_message"]);
  });

  it("ignores a non-array iterations field", () => {
    expect(
      extractRequest(request({}, { iterations: { type: "advisor" } })).nonMessageIterations,
    ).toEqual([]);
  });
});

describe("parseTimestamp", () => {
  it.each([
    ["UTC with milliseconds", "2026-09-01T10:00:02.000Z", "2026-09-01T10:00:02.000Z", "2026-09-01"],
    ["UTC without a fraction", "2026-09-01T23:59:58Z", "2026-09-01T23:59:58.000Z", "2026-09-01"],
    [
      "microseconds, truncated to milliseconds",
      "2026-09-01T10:00:00.123456Z",
      "2026-09-01T10:00:00.123Z",
      "2026-09-01",
    ],
    ["one fraction digit", "2026-09-01T10:00:00.5Z", "2026-09-01T10:00:00.500Z", "2026-09-01"],
    [
      "a positive offset crossing back a day",
      "2026-09-02T01:30:00.000+02:00",
      "2026-09-01T23:30:00.000Z",
      "2026-09-01",
    ],
    [
      "a negative offset crossing forward a day",
      "2026-09-01T22:00:00-05:30",
      "2026-09-02T03:30:00.000Z",
      "2026-09-02",
    ],
    ["a leap day", "2028-02-29T00:00:00Z", "2028-02-29T00:00:00.000Z", "2028-02-29"],
  ])("parses %s", (_name, raw, utc, day) => {
    expect(parseTimestamp(raw)).toEqual({ utc, day });
  });

  it.each([
    ["a non-string", 1757000000],
    ["garbage", "not-a-time"],
    ["a lowercase z", "2026-09-01T10:00:00z"],
    ["no seconds", "2026-09-01T10:00Z"],
    ["no zone", "2026-09-01T10:00:00"],
    ["month 13", "2026-13-01T00:00:00Z"],
    ["February 30", "2026-02-30T00:00:00Z"],
    ["February 29 in a non-leap year", "2026-02-29T00:00:00Z"],
    ["hour 24", "2026-09-01T24:00:00Z"],
    ["minute 60", "2026-09-01T10:60:00Z"],
    ["second 60", "2026-09-01T10:00:60Z"],
    ["offset hour 24", "2026-09-01T10:00:00+24:00"],
    ["offset minute 60", "2026-09-01T10:00:00+01:60"],
  ])("rejects %s", (_name, raw) => {
    expect(parseTimestamp(raw)).toBeNull();
  });
});

describe("messageText", () => {
  it("joins the text of list content, skipping parts without string text", () => {
    const line = {
      message: {
        content: [{ text: "a" }, { type: "tool_use" }, { text: 5 }, "junk", { text: "b" }],
      },
    };
    expect(messageText(line)).toBe("ab");
  });

  it("uses string content as the text", () => {
    expect(messageText({ message: { content: "hello" } })).toBe("hello");
  });

  it("returns empty text for other content and for no message", () => {
    expect(messageText({ message: { content: 5 } })).toBe("");
    expect(messageText({})).toBe("");
  });
});

// The strings below are Claude Code's own wording, copied verbatim, middle dot included. They are
// a RECORD of what it sends, not test data to tidy: the parser matches on "limit" and "resets" and
// ignores the separator, so editing them leaves every test passing while they describe a message
// nothing sends. A blanket find-and-replace did exactly that once, and only the diff caught it.
describe("parseQuotaLimits (D-067)", () => {
  // 1788329400 is 2026-09-02T06:10:00Z, worked out by hand: 20,698 days after 1970-01-01, plus 6h10m.
  it("reads a recognized window and a whole-second reset", () => {
    expect(
      parseQuotaLimits({
        quotaLimits: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1788329400 },
      }),
    ).toEqual({ window: "five_hour", resetsAtUtc: "2026-09-02T06:10:00.000Z", unusable: [] });
    expect(parseQuotaLimits({ quotaLimits: { rateLimitType: "seven_day" } })).toEqual({
      window: "seven_day",
      resetsAtUtc: null,
      unusable: [],
    });
  });

  it("reports nothing when quotaLimits or a member is absent, as in older versions", () => {
    const none = { window: null, resetsAtUtc: null, unusable: [] };
    expect(parseQuotaLimits({ error: "rate_limit" })).toEqual(none);
    expect(parseQuotaLimits({ quotaLimits: {} })).toEqual(none);
  });

  it("reports quotaLimits itself when it's present but not an object", () => {
    for (const value of [null, "five_hour", 5, [], true]) {
      expect(parseQuotaLimits({ quotaLimits: value })).toEqual({
        window: null,
        resetsAtUtc: null,
        unusable: ["quotaLimits"],
      });
    }
  });

  it("reports a window it doesn't recognize instead of mapping it onto one it does", () => {
    for (const value of ["seven_day_opus", "FIVE_HOUR", "", null, 5]) {
      expect(parseQuotaLimits({ quotaLimits: { rateLimitType: value } })).toEqual({
        window: null,
        resetsAtUtc: null,
        unusable: ["rateLimitType"],
      });
    }
  });

  it("accepts resetsAt only as a whole number of seconds from 1 to the year 9999", () => {
    /**
     * Reads one resetsAt value.
     * @param value - The resetsAt member.
     * @returns The reset time read from it, or null.
     */
    const reset = (value: unknown): string | null =>
      parseQuotaLimits({ quotaLimits: { resetsAt: value } }).resetsAtUtc;
    expect(reset(1)).toBe("1970-01-01T00:00:01.000Z");
    expect(reset(MAX_RESETS_AT)).toBe("9999-12-31T23:59:59.000Z");
    for (const bad of [0, -1, 1.5, MAX_RESETS_AT + 1, "1788329400", true, null]) {
      expect(parseQuotaLimits({ quotaLimits: { resetsAt: bad } })).toEqual({
        window: null,
        resetsAtUtc: null,
        unusable: ["resetsAt"],
      });
    }
  });

  it("lists both members, window first, when neither can be used", () => {
    expect(
      parseQuotaLimits({ quotaLimits: { resetsAt: "soon", rateLimitType: "seven_day_opus" } }),
    ).toEqual({ window: null, resetsAtUtc: null, unusable: ["rateLimitType", "resetsAt"] });
  });

  it("reads quotaLimits only on limit hits", () => {
    const line = { error: "server_error", quotaLimits: { rateLimitType: "five_hour" } };
    expect(extractEvent(line, "api_error").quota).toEqual({
      window: null,
      resetsAtUtc: null,
      unusable: [],
    });
  });
});

describe("parseLimitText", () => {
  it.each([
    [
      "session wording",
      "You've hit your session limit · resets 6:10am (UTC)",
      "five_hour",
      "6:10am (UTC)",
    ],
    [
      "weekly wording",
      "You've hit your weekly limit · resets Sep 5, 9am (UTC)",
      "seven_day",
      "Sep 5, 9am (UTC)",
    ],
    ["older 5-hour wording", "5-hour limit reached ∙ resets 2am", "five_hour", "2am"],
    ["no window or reset", "Usage limit reached", null, null],
    ["uppercase wording", "SESSION LIMIT hit. RESETS  7pm ", "five_hour", "7pm"],
    ["both windows, session first", "weekly limit and session limit", "five_hour", null],
    ["a reset with nothing after it", "session limit · resets   ", "five_hour", null],
  ])("parses %s", (_name, text, window, resetText) => {
    expect(parseLimitText(text)).toEqual({ window, resetText });
  });

  it("uses the first 'resets ' when there are several", () => {
    expect(parseLimitText("resets 1am, then resets 2am").resetText).toBe("1am, then resets 2am");
  });
});

describe("extractEvent", () => {
  it("extracts a limit hit's error, status, window, and reset", () => {
    const line = {
      isApiErrorMessage: true,
      error: "rate_limit",
      apiErrorStatus: 429,
      message: {
        model: "<synthetic>",
        content: [{ text: "You've hit your session limit · resets 6:10am (UTC)" }],
      },
    };
    expect(extractEvent(line, "limit_hit")).toEqual({
      error: "rate_limit",
      apiErrorStatus: 429,
      window: "five_hour",
      resetText: "6:10am (UTC)",
      // No quotaLimits on this line, as on Claude Code 2.1.214: nothing read, nothing reported.
      quota: { window: null, resetsAtUtc: null, unusable: [] },
      unknownErrorKey: null,
      retryRateLimitsPresent: false,
    });
  });

  it.each([
    ["server_error, which is recognized", { error: "server_error" }, null],
    ["an unrecognized error", { error: "billing_error" }, "billing_error"],
    ["a missing error", {}, MISSING],
    ["a null error", { error: null }, MISSING],
  ])("labels an API error with %s", (_name, fields, key) => {
    const event = extractEvent({ isApiErrorMessage: true, ...fields }, "api_error");
    expect(event.unknownErrorKey).toBe(key);
    expect(event.window).toBeNull();
  });

  it("leaves unknown-error labels and windows off other synthetic lines", () => {
    expect(
      extractEvent({ error: "whatever", message: { content: "session limit" } }, "synthetic_other"),
    ).toMatchObject({
      unknownErrorKey: null,
      window: null,
      resetText: null,
    });
  });

  it("takes a retry notice's status from error.status, with null error text", () => {
    const line = { type: "system", subtype: "api_error", error: { status: 429, rateLimits: null } };
    expect(extractEvent(line, "retry_notice")).toMatchObject({
      error: null,
      apiErrorStatus: 429,
      retryRateLimitsPresent: false,
    });
  });

  it("prefers apiErrorStatus over error.status", () => {
    const line = { apiErrorStatus: 503, error: { status: 429 } };
    expect(extractEvent(line, "retry_notice").apiErrorStatus).toBe(503);
  });

  it("ignores error.status outside retry notices and non-numeric statuses", () => {
    expect(extractEvent({ error: { status: 429 } }, "api_error").apiErrorStatus).toBeNull();
    expect(extractEvent({ apiErrorStatus: "429" }, "api_error").apiErrorStatus).toBeNull();
  });

  it.each([
    ["a non-null rateLimits", { rateLimits: { five_hour: {} } }, true],
    ["an empty object", { rateLimits: {} }, true],
    ["a null rateLimits", { rateLimits: null }, false],
    ["no rateLimits member", {}, false],
  ])("counts a retry notice with %s", (_name, error, present) => {
    expect(extractEvent({ error }, "retry_notice").retryRateLimitsPresent).toBe(present);
  });

  it("never counts rateLimits outside retry notices", () => {
    expect(extractEvent({ error: { rateLimits: {} } }, "api_error").retryRateLimitsPresent).toBe(
      false,
    );
  });
});

describe("ignoredTypeKey", () => {
  it.each([
    ["a type", { type: "user" }, "user"],
    ["a type with a subtype", { type: "system", subtype: "turn_duration" }, "system/turn_duration"],
    ["a non-string subtype", { type: "system", subtype: 3 }, "system"],
    ["a missing type", { subtype: "x" }, "<missing>/x"],
  ])("labels %s", (_name, line, key) => {
    expect(ignoredTypeKey(line)).toBe(key);
  });
});

describe("extractLinks", () => {
  it("reads uuid, parent, origin kind, and meta flag as written", () => {
    expect(
      extractLinks({
        type: "user",
        uuid: "u",
        parentUuid: "p",
        origin: { kind: "task-notification" },
        isMeta: true,
        message: { content: "go on" },
      }),
    ).toEqual({
      uuid: "u",
      parentUuid: "p",
      originKind: "task-notification",
      userContent: "prompt",
      isMeta: true,
    });
  });

  it.each([
    [
      "a tool result among other blocks",
      [{ type: "text" }, { type: "tool_result" }],
      "tool_result",
    ],
    ["text and image blocks", [{ type: "text" }, { type: "image" }], "prompt"],
    ["an empty list", [], "prompt"],
    ["non-object blocks", ["tool_result", null], "prompt"],
    ["no content", undefined, null],
    ["object content", { type: "tool_result" }, null],
  ])("labels user content with %s", (_name, content, expected) => {
    expect(extractLinks({ type: "user", message: { content } }).userContent).toBe(expected);
  });

  it("gives no user content to other line types, and nulls mistyped or empty fields", () => {
    expect(
      extractLinks({
        type: "assistant",
        uuid: "",
        parentUuid: 7,
        origin: "human",
        isMeta: "true",
        message: { content: [{ type: "tool_result" }] },
      }),
    ).toEqual({ uuid: null, parentUuid: null, originKind: null, userContent: null, isMeta: false });
    expect(extractLinks({ origin: { kind: 3 } }).originKind).toBeNull();
  });
});
