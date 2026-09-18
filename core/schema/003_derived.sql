-- 003_derived: tables derived from raw_lines by core/ingest/derive.ts.
--
-- Everything here is rebuildable (D-002): deleting these rows and deriving again from raw_lines
-- must produce identical contents. derive_meta records the parser version that produced them, so
-- a parser change triggers a rebuild instead of mixing old and new interpretations.
--
-- Classification and field rules: fixtures/README.md (D-001, D-004, D-007, D-019).
-- The token tables are not STRICT on purpose: a JSON number that isn't an integer is stored as
-- written rather than rejected, matching "a token value counts if it's a JSON number".

CREATE TABLE derive_meta (
  key   TEXT PRIMARY KEY, -- derived: setting name, e.g. 'parser_version'
  value TEXT NOT NULL     -- derived: setting value
) STRICT;

CREATE TABLE parsed_lines (
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
  CHECK (class IN ('malformed', 'limit_hit', 'api_error', 'synthetic_other', 'request', 'retry_notice', 'ignored_type')),
  CHECK (is_sidechain IN (0, 1))
) STRICT;

CREATE TABLE requests (
  raw_line_id                INTEGER PRIMARY KEY REFERENCES raw_lines (id), -- derived: the request line
  dedup_key                  TEXT,             -- derived: D-001 key; NULL when the line has neither ID (unkeyed)
  message_id                 TEXT,             -- source: message.id when it's a string
  request_id                 TEXT,             -- source: requestId when it's a string
  model                      TEXT NOT NULL,    -- source: message.model ('<missing>' if absent or not a string)
  input_tokens               NUMERIC NOT NULL, -- source: message.usage.input_tokens (0 when not a number)
  output_tokens              NUMERIC NOT NULL, -- source: message.usage.output_tokens (0 when not a number)
  cache_read_tokens          NUMERIC NOT NULL, -- source: message.usage.cache_read_input_tokens (0 when not a number)
  cache_write_5m_tokens      NUMERIC,          -- source: message.usage.cache_creation.ephemeral_5m_input_tokens; NULL without the split object
  cache_write_1h_tokens      NUMERIC,          -- source: message.usage.cache_creation.ephemeral_1h_input_tokens; NULL without the split object
  cache_write_unsplit_tokens NUMERIC,          -- source: message.usage.cache_creation_input_tokens; only when the split object is absent
  speed                      TEXT              -- source: message.usage.speed when it's a string
);

-- Requests grouped for dedup: each key's candidates are read together.
CREATE INDEX requests_dedup_key ON requests (dedup_key);

CREATE TABLE events (
  raw_line_id               INTEGER PRIMARY KEY REFERENCES raw_lines (id), -- derived: the event line
  class                     TEXT NOT NULL,    -- derived: 'limit_hit', 'api_error', 'synthetic_other', or 'retry_notice'
  error                     TEXT,             -- source: error when it's a string
  api_error_status          NUMERIC,          -- source: apiErrorStatus, or error.status for retry notices
  window                    TEXT,             -- derived: 'five_hour' or 'seven_day' parsed from limit-hit text (D-004)
  reset_text                TEXT,             -- derived: text after 'resets ' in limit-hit text (D-004)
  unknown_error_key         TEXT,             -- derived: report label for an api_error's unrecognized or missing error
  retry_rate_limits_present INTEGER NOT NULL, -- derived: 1 when a retry notice's error.rateLimits is present and not null (D-019)
  CHECK (class IN ('limit_hit', 'api_error', 'synthetic_other', 'retry_notice'))
);

CREATE TABLE line_problems (
  id          INTEGER PRIMARY KEY, -- derived: row identity
  raw_line_id INTEGER NOT NULL REFERENCES raw_lines (id), -- derived: the line with the problem
  problem     TEXT NOT NULL,       -- derived: 'missing_field', 'unparsed_timestamp', or 'non_message_iteration'
  detail      TEXT,                -- derived: the field name, raw timestamp JSON, or iteration type
  CHECK (problem IN ('missing_field', 'unparsed_timestamp', 'non_message_iteration'))
) STRICT;

CREATE INDEX line_problems_line ON line_problems (raw_line_id);
