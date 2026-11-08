-- 033_machines: other machines' records, read from a folder the user already syncs (D-101 to D-103, steps G7.1 to G7.3).
--
-- Each machine writes scrubbed copies of its own log and spool lines to <folder>/nilometer/<machine id>/, and reads
-- every other machine's files there into raw_lines as ordinary 'log' and 'spool' sources. Every view then treats an
-- imported line as it treats a local one: on 268,937 real lines, every observed and projected view built from
-- scrubbed lines matched the one built from the full lines (G7.1). These tables say which machine a file came from,
-- what this machine is called, and which lines are already stored, so the same line is never stored twice.

-- This machine's identity and folder: one row once `nilometer machines folder` has run.
CREATE TABLE this_machine (
  id                    INTEGER PRIMARY KEY, -- derived: always 1, so there is one row
  machine_id            TEXT NOT NULL,       -- derived: random UUID made on first setup; names this machine's folder, never the hostname (D-103)
  label                 TEXT NOT NULL,       -- source: the name the user gave this machine (`--name`)
  folder                TEXT,                -- source: the synced folder given to `machines folder`; NULL after `machines leave`
  last_exported_line_id INTEGER NOT NULL DEFAULT 0, -- derived: the highest local raw_lines.id written to the folder
  CHECK (id = 1),
  CHECK (length(label) BETWEEN 1 AND 60)
) STRICT;

-- The other machines found in the folder, as of the last ingest that read it.
CREATE TABLE machines (
  machine_id        TEXT PRIMARY KEY, -- source: the machine's folder name, a UUID
  label             TEXT,             -- source: label in its machine.json; NULL when the file couldn't be read
  exported_at       TEXT,             -- source: when it last wrote its export, by its own clock (ISO-8601 UTC)
  nilometer_version TEXT,             -- source: the Nilometer version that wrote it
  status            TEXT NOT NULL,    -- derived: 'merged', or 'refused' with a reason
  reason            TEXT,             -- derived: why it was refused; NULL when merged
  checked_at        TEXT NOT NULL,    -- derived: ISO-8601 UTC time of the ingest that read it
  CHECK (status IN ('merged', 'refused')),
  CHECK ((status = 'refused') = (reason IS NOT NULL))
) STRICT;

-- Which source files came from another machine. A file not listed here is this machine's own.
CREATE TABLE machine_files (
  source_file_id INTEGER PRIMARY KEY REFERENCES source_files (id), -- derived: the file's row
  machine_id     TEXT NOT NULL,       -- source: the machine folder it was read from
  file_sha256    TEXT NOT NULL,       -- derived: SHA-256 of the compressed file when last read; unchanged means nothing new
  CHECK (length(file_sha256) = 64)
) STRICT;

CREATE INDEX machine_files_machine ON machine_files (machine_id);

-- Each imported line's identity on the machine that wrote it, so a line seen in two files (a month rewritten after
-- a database rebuild, or a machine's folder re-created) is stored once.
CREATE TABLE machine_lines (
  raw_line_id INTEGER PRIMARY KEY REFERENCES raw_lines (id), -- derived: the stored line
  origin      TEXT NOT NULL UNIQUE  -- source: the line's nilometerLine field: a hash of its original file and bytes
) STRICT;

-- Every stored line with the machine it was recorded on; machine_id is NULL for this machine.
CREATE VIEW line_machines AS
SELECT l.id AS raw_line_id, mf.machine_id
FROM raw_lines l
LEFT JOIN machine_files mf ON mf.source_file_id = l.source_file_id;

-- The latest weekly window with a reading, which both per-machine views also report on.
CREATE VIEW latest_weekly_window AS
SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MAX(reset_at_utc), '-7 days') AS starts_at_utc, MAX(reset_at_utc) AS reset_at_utc
FROM window_instances
WHERE window = 'seven_day';

-- Each deduplicated request with the machine that recorded it (D-102): the events behind both per-machine views.
-- No cost here, so the observed view can read it; the projection joins request_costs to it.
CREATE VIEW machine_requests AS
-- Materialized: window_instances is costly, and a correlated lookup would run it once per request (G7.4: 523 s on
-- real data before, against 6.5 s for the whole page).
WITH week AS MATERIALIZED (SELECT starts_at_utc, reset_at_utc FROM latest_weekly_window),
this AS MATERIALIZED (SELECT machine_id, label FROM this_machine)
SELECT
  d.raw_line_id,
  d.dedup_key,
  d.timestamp_utc,
  d.model,
  -- This machine has no row in machines; its ID and label come from this_machine, else plain names.
  COALESCE(mf.machine_id, (SELECT machine_id FROM this), 'this-machine') AS machine_id,
  COALESCE(m.label, CASE WHEN mf.machine_id IS NULL
    THEN COALESCE((SELECT label FROM this), 'This machine') END, 'Unnamed machine') AS machine_label,
  mf.machine_id IS NULL AS is_this_machine,
  d.input_tokens,
  d.output_tokens,
  d.cache_read_tokens,
  COALESCE(d.cache_write_5m_tokens, 0) + COALESCE(d.cache_write_1h_tokens, 0)
    + COALESCE(d.cache_write_unsplit_tokens, 0) AS cache_write_tokens,
  -- Inside the latest weekly window with a reading: its seven days back from the reset.
  COALESCE(d.timestamp_utc >= w.starts_at_utc AND d.timestamp_utc < w.reset_at_utc, 0) AS in_latest_week
FROM requests_dedup d
JOIN raw_lines l ON l.id = d.raw_line_id
LEFT JOIN machine_files mf ON mf.source_file_id = l.source_file_id
LEFT JOIN machines m ON m.machine_id = mf.machine_id
LEFT JOIN week w;

-- Observed: each machine's recorded Claude Code requests and tokens, over its whole record and in the latest weekly
-- window, with its span and its last export (D-102). Usage elsewhere is in the account's percentages and in no row.
CREATE VIEW obs_usage_by_machine AS
SELECT
  r.machine_id,
  r.machine_label,
  MAX(r.is_this_machine) AS is_this_machine,
  COUNT(*) AS requests,
  SUM(r.input_tokens) AS input_tokens,
  SUM(r.output_tokens) AS output_tokens,
  SUM(r.cache_read_tokens) AS cache_read_tokens,
  SUM(r.cache_write_tokens) AS cache_write_tokens,
  COUNT(*) FILTER (WHERE r.in_latest_week) AS week_requests,
  COALESCE(SUM(r.output_tokens) FILTER (WHERE r.in_latest_week), 0) AS week_output_tokens,
  MIN(r.timestamp_utc) AS covers_from,
  MAX(r.timestamp_utc) AS covers_to,
  (SELECT exported_at FROM machines m WHERE m.machine_id = r.machine_id) AS last_export_at_utc,
  w.starts_at_utc AS week_starts_at_utc,
  w.reset_at_utc AS week_reset_at_utc
FROM machine_requests r
LEFT JOIN latest_weekly_window w
GROUP BY r.machine_id, r.machine_label
ORDER BY is_this_machine DESC, requests DESC;

-- Projected: each machine's observed tokens at API list price, and its share of every recorded machine's, over the
-- whole record and in the latest weekly window (D-102). A share of recorded usage, never of a window.
CREATE VIEW proj_api_list_price_by_machine AS
WITH per_machine AS (
  SELECT
    r.machine_id,
    r.machine_label,
    MAX(r.is_this_machine) AS is_this_machine,
    TOTAL(c.total_usd) AS list_price_usd,
    TOTAL(c.total_usd) FILTER (WHERE r.in_latest_week) AS week_list_price_usd,
    COUNT(*) FILTER (WHERE c.unpriced_reason IS NOT NULL) AS unpriced_requests,
    MIN(r.timestamp_utc) AS covers_from,
    MAX(r.timestamp_utc) AS covers_to
  FROM machine_requests r
  JOIN request_costs c ON c.raw_line_id = r.raw_line_id
  GROUP BY r.machine_id, r.machine_label
)
SELECT
  p.*,
  -- Unrounded; NULL when nothing priced was recorded.
  p.list_price_usd / NULLIF((SELECT TOTAL(list_price_usd) FROM per_machine), 0) AS share_of_recorded,
  p.week_list_price_usd / NULLIF((SELECT TOTAL(week_list_price_usd) FROM per_machine), 0) AS week_share_of_recorded,
  w.starts_at_utc AS week_starts_at_utc,
  w.reset_at_utc AS week_reset_at_utc
FROM per_machine p
LEFT JOIN latest_weekly_window w
ORDER BY p.is_this_machine DESC, p.list_price_usd DESC;

-- Another machine's requests carry no working directory (D-103), so they can't be attributed to a repository there;
-- they count under their own kind, never as an unresolved directory of this machine. Otherwise as in 030.
DROP VIEW obs_usage_events;

-- Observed: every deduplicated request with its repository, as in 030, and another machine's under its own kind (D-103).
CREATE VIEW obs_usage_events AS
SELECT
  d.raw_line_id, d.dedup_key, d.session_id, d.timestamp_utc, d.model,
  CASE WHEN mf.machine_id IS NULL THEN r.repository END AS repository,
  CASE WHEN mf.machine_id IS NULL THEN r.repo_kind ELSE 'other_machine' END AS repo_kind,
  d.input_tokens, d.output_tokens, d.cache_read_tokens,
  d.cache_write_5m_tokens, d.cache_write_1h_tokens, d.cache_write_unsplit_tokens,
  CASE WHEN mf.machine_id IS NULL THEN r.aliased_from END AS aliased_from
FROM requests_dedup d
JOIN request_repositories r ON r.raw_line_id = d.raw_line_id
JOIN raw_lines l ON l.id = d.raw_line_id
LEFT JOIN machine_files mf ON mf.source_file_id = l.source_file_id;
