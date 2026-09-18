-- 006_status_readings: status line readings decoded from the hook's spool (D-008, D-009, D-018).
--
-- Spool lines are stored in raw_lines like log lines (source_files.kind = 'spool') and derived
-- here instead of into parsed_lines. Values are stored as written and flagged, never clamped: an
-- out-of-range percentage is evidence of a payload problem, not something to repair.
-- Rebuildable from raw_lines, like the tables in 003.

CREATE TABLE status_readings (
  raw_line_id     INTEGER PRIMARY KEY REFERENCES raw_lines (id), -- derived: the spool line
  status          TEXT NOT NULL,    -- derived: 'ok', 'malformed_line', 'malformed_payload_encoding', or 'malformed_payload'
  captured_at_s   NUMERIC,          -- source: spool captured_at_s (epoch seconds, from the hook's clock)
  hook_version    NUMERIC,          -- source: spool hook_version
  session_id      TEXT,             -- source: payload session_id
  transcript_path TEXT,             -- source: payload transcript_path; links the reading to its session log
  model_id        TEXT,             -- source: payload model.id
  cc_version      TEXT,             -- source: payload version (Claude Code version)
  cost_total_usd  NUMERIC,          -- source: payload cost.total_cost_usd; a cross-check only, never a source (CLAUDE.md)
  has_rate_limits INTEGER NOT NULL, -- derived: 1 when payload rate_limits is an object
  CHECK (status IN ('ok', 'malformed_line', 'malformed_payload_encoding', 'malformed_payload')),
  CHECK (has_rate_limits IN (0, 1))
);

CREATE TABLE rate_limit_windows (
  raw_line_id     INTEGER NOT NULL REFERENCES status_readings (raw_line_id), -- derived: the reading
  window          TEXT NOT NULL,    -- source: key under payload rate_limits, e.g. 'five_hour'
  used_percentage NUMERIC,          -- source: rate_limits.<window>.used_percentage when it's a number
  resets_at       NUMERIC,          -- source: rate_limits.<window>.resets_at when it's a number (epoch seconds)
  validity        TEXT NOT NULL,    -- derived: 'valid' or the first problem found
  PRIMARY KEY (raw_line_id, window),
  CHECK (validity IN ('valid', 'invalid_percentage', 'invalid_epoch_in_percentage', 'invalid_resets_at', 'unknown_window'))
);

CREATE INDEX rate_limit_windows_window ON rate_limit_windows (window, validity);
