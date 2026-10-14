/**
 * @file A refused-and-retried request, stored as its own event (D-080, step G2.8).
 *
 * One session: a fallback line naming claude-opus-5 as refusing request req_refused and
 * claude-sonnet-5 as retrying it, then Sonnet's own request (output 9). Worked out by hand: one
 * model_fallback event with all four fields stored, the refusal category included; one request;
 * no token from the refused request, since none was logged.
 */
import { describe, expect, it } from "vitest";

import { ingest, request } from "./helpers.js";

describe("a model fallback in the database (D-080)", () => {
  const db = ingest({
    "-p/s.jsonl": [
      {
        type: "system",
        subtype: "model_refusal_fallback",
        sessionId: "s",
        uuid: "f",
        timestamp: "2026-09-01T10:00:02Z",
        originalModel: "claude-opus-5",
        fallbackModel: "claude-sonnet-5",
        requestId: "req_refused",
        apiRefusalCategory: "synthetic-category",
      },
      request("s", "r", null, "2026-09-01T10:00:05Z", {
        usage: { input_tokens: 6, output_tokens: 9 },
      }),
    ],
  });

  it("stores one event with both models, the refused request, and the refusal category", () => {
    expect(
      db
        .prepare(
          "SELECT class, fallback_original_model, fallback_model, fallback_request_id, refusal_category FROM events",
        )
        .all(),
    ).toEqual([
      {
        class: "model_fallback",
        fallback_original_model: "claude-opus-5",
        fallback_model: "claude-sonnet-5",
        fallback_request_id: "req_refused",
        refusal_category: "synthetic-category",
      },
    ]);
  });

  it("adds no request and no tokens for the refused request", () => {
    expect(
      db.prepare("SELECT COUNT(*) AS n, SUM(output_tokens) AS output FROM requests_dedup").get(),
    ).toEqual({ n: 1, output: 9 });
  });
});
