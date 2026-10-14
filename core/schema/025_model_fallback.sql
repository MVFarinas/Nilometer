-- 025_model_fallback: a request refused by one model and retried by another is its own event (D-080, step G2.8).
--
-- Claude Code writes a system line with subtype model_refusal_fallback when a model refuses a
-- request and another model retries it, naming both models, the requestId, and a refusal
-- category (observed 2026-10-03). The refused request writes no request line, so no token count
-- exists for it. Until now the line was ignored_type; it's the only place the refusal is recorded.
--
-- parsed_lines and events are rebuilt because SQLite can't change a CHECK constraint in place.
-- Both are derived: the parser version bump that ships with this migration re-derives them from
-- raw_lines, so the rows copied here only keep the database consistent until then.

-- Dozens of views read parsed_lines and events by name. A modern ALTER TABLE ... RENAME re-checks
-- every view, and fails while the old table is dropped and the new one not yet renamed. Legacy
-- rename leaves views untouched; they resolve to the rebuilt tables by name once this finishes.
PRAGMA legacy_alter_table = ON;

CREATE TABLE parsed_lines_025 (
  raw_line_id   INTEGER PRIMARY KEY REFERENCES raw_lines (id), -- derived: the line these fields came from
  class         TEXT NOT NULL,    -- derived: classification, first matching rule wins
  session_id    TEXT,             -- source: sessionId ('<missing>' if absent or not a string); NULL when malformed
  type          TEXT,             -- source: type ('<missing>' if absent or not a string); NULL when malformed
  subtype       TEXT,             -- source: subtype when it's a string, else NULL
  timestamp_raw TEXT,             -- source: timestamp as JSON text of its value; NULL when absent or malformed
  timestamp_utc TEXT,             -- derived: timestamp normalized to UTC with milliseconds; NULL when it doesn't parse
  cwd           TEXT,             -- source: cwd when it's a string, else NULL
  git_branch    TEXT,             -- source: gitBranch when it's a string, else NULL
  cc_version    TEXT,             -- source: version (Claude Code version) when it's a string, else NULL
  is_sidechain  INTEGER NOT NULL, -- source: isSidechain === true (1) or anything else (0)
  uuid          TEXT,             -- source: uuid when it's a non-empty string
  parent_uuid   TEXT,             -- source: parentUuid when it's a non-empty string (D-021)
  origin_kind   TEXT,             -- source: origin.kind when it's a string (D-022)
  user_content  TEXT,             -- derived: user lines only; 'tool_result' when message.content holds a tool_result block, else 'prompt'
  is_meta       INTEGER NOT NULL DEFAULT 0, -- source: isMeta === true (1) or anything else (0)
  CHECK (class IN ('malformed', 'limit_hit', 'api_error', 'synthetic_other', 'request', 'retry_notice', 'model_fallback', 'ignored_type')),
  CHECK (is_sidechain IN (0, 1)),
  CHECK (user_content IN ('tool_result', 'prompt')),
  CHECK (is_meta IN (0, 1))
) STRICT;
INSERT INTO parsed_lines_025 (raw_line_id, class, session_id, type, subtype, timestamp_raw, timestamp_utc, cwd,
  git_branch, cc_version, is_sidechain, uuid, parent_uuid, origin_kind, user_content, is_meta)
  SELECT raw_line_id, class, session_id, type, subtype, timestamp_raw, timestamp_utc, cwd,
    git_branch, cc_version, is_sidechain, uuid, parent_uuid, origin_kind, user_content, is_meta
  FROM parsed_lines;
DROP TABLE parsed_lines;
ALTER TABLE parsed_lines_025 RENAME TO parsed_lines;
CREATE INDEX parsed_lines_session_uuid ON parsed_lines (session_id, uuid);
CREATE INDEX parsed_lines_session_time ON parsed_lines (session_id, timestamp_utc);
CREATE INDEX parsed_lines_request_time ON parsed_lines (timestamp_utc) WHERE class = 'request';

CREATE TABLE events_025 (
  raw_line_id               INTEGER PRIMARY KEY REFERENCES raw_lines (id), -- derived: the event line
  class                     TEXT NOT NULL,    -- derived: 'limit_hit', 'api_error', 'synthetic_other', 'retry_notice', or 'model_fallback'
  error                     TEXT,             -- source: error when it's a string
  api_error_status          NUMERIC,          -- source: apiErrorStatus, or error.status for retry notices
  window                    TEXT,             -- derived: 'five_hour' or 'seven_day' parsed from limit-hit text (D-004)
  reset_text                TEXT,             -- derived: text after 'resets ' in limit-hit text (D-004)
  unknown_error_key         TEXT,             -- derived: report label for an api_error's unrecognized or missing error
  retry_rate_limits_present INTEGER NOT NULL, -- derived: 1 when a retry notice's error.rateLimits is present and not null (D-019)
  reset_at_utc              TEXT,             -- derived: limit hits only; reset_text resolved against the hit's timestamp (D-023)
  quota_window              TEXT,             -- source: quotaLimits.rateLimitType when it's 'five_hour' or 'seven_day' (limit hits only, D-067)
  quota_resets_at_utc       TEXT,             -- source: quotaLimits.resetsAt (Unix seconds, whole, 1..253402300799) as ISO-8601 UTC (limit hits only, D-067)
  fallback_original_model   TEXT,             -- source: originalModel when it's a string (model fallbacks only, D-080)
  fallback_model            TEXT,             -- source: fallbackModel when it's a string (model fallbacks only, D-080)
  fallback_request_id       TEXT,             -- source: requestId when it's a string (model fallbacks only, D-080)
  refusal_category          TEXT,             -- source: apiRefusalCategory when it's a string (model fallbacks only, D-080); stored, never shown
  CHECK (class IN ('limit_hit', 'api_error', 'synthetic_other', 'retry_notice', 'model_fallback')),
  CHECK (quota_window IN ('five_hour', 'seven_day'))
);
INSERT INTO events_025 (raw_line_id, class, error, api_error_status, window, reset_text, unknown_error_key,
  retry_rate_limits_present, reset_at_utc, quota_window, quota_resets_at_utc)
  SELECT raw_line_id, class, error, api_error_status, window, reset_text, unknown_error_key,
    retry_rate_limits_present, reset_at_utc, quota_window, quota_resets_at_utc
  FROM events;
DROP TABLE events;
ALTER TABLE events_025 RENAME TO events;

PRAGMA legacy_alter_table = OFF;
