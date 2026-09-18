-- 001_ingestion: raw storage for session logs and the status line spool.
--
-- Implements D-002 (store every raw line; everything else is derived and rebuildable) and D-003
-- (incremental reading by byte offset of the last complete line). Rows in raw_lines are never
-- updated or deleted: a log file rewritten by Claude Code keeps its earlier lines here, because
-- those requests happened (fixtures/README.md, cumulative runs).
--
-- Column comments: "source:" names the log, payload, or filesystem value a column holds;
-- "derived:" marks values computed by ingestion.

CREATE TABLE ingest_runs (
  id          INTEGER PRIMARY KEY, -- derived: run identity, increasing
  started_at  TEXT NOT NULL,       -- derived: ISO-8601 UTC time the run began
  finished_at TEXT,                -- derived: ISO-8601 UTC time the run ended; NULL while running or after a crash
  mode        TEXT NOT NULL,       -- derived: 'incremental' reads from stored offsets; 'full' rereads every file
  CHECK (mode IN ('incremental', 'full'))
) STRICT;

CREATE TABLE source_files (
  id            INTEGER PRIMARY KEY, -- derived: file identity
  kind          TEXT NOT NULL,       -- derived: 'log' for session JSONL, 'spool' for the status line spool
  root          TEXT NOT NULL,       -- source: discovery root (a CLAUDE_CONFIG_DIR entry, ~/.claude, or the data dir)
  relative_path TEXT NOT NULL,       -- source: path below the root, e.g. projects/<encoded>/<session>.jsonl
  byte_offset   INTEGER NOT NULL,    -- derived: position just past the last complete line consumed (D-003)
  size          INTEGER NOT NULL,    -- source: file size in bytes at the last read (stat)
  inode         INTEGER,             -- source: inode at the last read (stat); NULL where the platform has none
  first_run_id  INTEGER NOT NULL REFERENCES ingest_runs (id), -- derived: run that first saw the file
  last_run_id   INTEGER NOT NULL REFERENCES ingest_runs (id), -- derived: run that last read the file
  UNIQUE (root, relative_path),
  CHECK (kind IN ('log', 'spool')),
  CHECK (byte_offset >= 0 AND byte_offset <= size)
) STRICT;

CREATE TABLE raw_lines (
  id             INTEGER PRIMARY KEY, -- derived: row identity; not an ordering (use file, first run, line)
  source_file_id INTEGER NOT NULL REFERENCES source_files (id), -- derived: file the line came from
  line_number    INTEGER NOT NULL,    -- source: 1-based line number where the line was first seen
  byte_offset    INTEGER NOT NULL,    -- source: byte position of the line's first byte when first seen
  content_hash   TEXT NOT NULL,       -- derived: SHA-256 of bytes, lowercase hex; with the file, the line's identity
  bytes          BLOB NOT NULL,       -- source: the exact line bytes, without the terminating newline
  first_run_id   INTEGER NOT NULL REFERENCES ingest_runs (id), -- derived: run that first stored the line
  UNIQUE (source_file_id, content_hash),
  CHECK (line_number >= 1),
  CHECK (byte_offset >= 0),
  CHECK (length(content_hash) = 64)
) STRICT;

-- The canonical order every derived list uses: file, then first run, then line.
CREATE INDEX raw_lines_order ON raw_lines (source_file_id, first_run_id, line_number);

CREATE TABLE ingest_report (
  id             INTEGER PRIMARY KEY, -- derived: report row identity
  run_id         INTEGER NOT NULL REFERENCES ingest_runs (id), -- derived: run that found the problem
  source_file_id INTEGER REFERENCES source_files (id), -- derived: file involved; NULL for run-level problems
  problem        TEXT NOT NULL,       -- derived: problem code, e.g. 'file_rewritten', 'file_unreadable'
  detail         TEXT                 -- derived: human-readable detail; never a full log line
) STRICT;
