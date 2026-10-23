-- 032_stored_views: requests_dedup and window_readings become tables that ingest fills from their views (D-096, step G6.1).
--
-- Every report statement recomputed both from the raw tables: window_readings pairs each of tens of thousands of
-- rate-limit readings with its API response through correlated lookups, and requests_dedup ranks every request line.
-- On real data the report and page ran about 20 statements built on them and took 45-50 s. Their inputs (requests,
-- parsed_lines, raw_lines, source_files, status_readings, rate_limit_windows) are written only by ingest, so ingest
-- stores their rows once (core/ingest/stored-views.ts) and everything downstream reads the stored rows. The
-- definitions are unchanged and keep running as views under *_computed, so the rows trace back exactly as before,
-- and a test fails if a stored table ever differs from its view.
--
-- Columns are ANY in a STRICT table: no type affinity, so every value is stored exactly as the view returned it.

DROP VIEW requests_dedup;

-- Observed: one row per distinct API response (winners) plus every unkeyed request line, as 019 computed it; ingest stores its rows in requests_dedup (D-096).
CREATE VIEW requests_dedup_computed AS
WITH ranked AS (
  SELECT
    r.raw_line_id,
    r.dedup_key,
    r.message_id,
    r.request_id,
    r.model,
    r.input_tokens,
    r.output_tokens,
    r.cache_read_tokens,
    r.cache_write_5m_tokens,
    r.cache_write_1h_tokens,
    r.cache_write_unsplit_tokens,
    r.speed,
    p.session_id,
    p.timestamp_raw,
    p.timestamp_utc,
    p.cwd,
    p.is_sidechain,
    f.root,
    f.relative_path,
    l.first_run_id,
    l.line_number,
    ROW_NUMBER() OVER (
      PARTITION BY r.dedup_key
      ORDER BY r.output_tokens DESC, p.is_sidechain ASC,
               -- Among lines tied on output, the earliest: when those numbers first existed
               -- (D-065, the same rule D-045 applies to readings). NULLs last, so an unparsed
               -- timestamp never wins.
               (p.timestamp_utc IS NULL) ASC, p.timestamp_utc ASC,
               f.root DESC, f.relative_path DESC, l.first_run_id DESC, l.line_number DESC
    ) AS candidate_rank
  FROM requests r
  JOIN parsed_lines p ON p.raw_line_id = r.raw_line_id
  JOIN raw_lines l ON l.id = r.raw_line_id
  JOIN source_files f ON f.id = l.source_file_id
)
SELECT
  raw_line_id, dedup_key, message_id, request_id, model,
  input_tokens, output_tokens, cache_read_tokens,
  cache_write_5m_tokens, cache_write_1h_tokens, cache_write_unsplit_tokens, speed,
  session_id, timestamp_raw, timestamp_utc, cwd, is_sidechain,
  root, relative_path, first_run_id, line_number
FROM ranked
WHERE dedup_key IS NULL OR candidate_rank = 1;

CREATE TABLE requests_dedup (
  raw_line_id                ANY, -- derived: requests_dedup_computed.raw_line_id
  dedup_key                  ANY, -- derived: requests_dedup_computed.dedup_key
  message_id                 ANY, -- derived: requests_dedup_computed.message_id
  request_id                 ANY, -- derived: requests_dedup_computed.request_id
  model                      ANY, -- derived: requests_dedup_computed.model
  input_tokens               ANY, -- derived: requests_dedup_computed.input_tokens
  output_tokens              ANY, -- derived: requests_dedup_computed.output_tokens
  cache_read_tokens          ANY, -- derived: requests_dedup_computed.cache_read_tokens
  cache_write_5m_tokens      ANY, -- derived: requests_dedup_computed.cache_write_5m_tokens
  cache_write_1h_tokens      ANY, -- derived: requests_dedup_computed.cache_write_1h_tokens
  cache_write_unsplit_tokens ANY, -- derived: requests_dedup_computed.cache_write_unsplit_tokens
  speed                      ANY, -- derived: requests_dedup_computed.speed
  session_id                 ANY, -- derived: requests_dedup_computed.session_id
  timestamp_raw              ANY, -- derived: requests_dedup_computed.timestamp_raw
  timestamp_utc              ANY, -- derived: requests_dedup_computed.timestamp_utc
  cwd                        ANY, -- derived: requests_dedup_computed.cwd
  is_sidechain               ANY, -- derived: requests_dedup_computed.is_sidechain
  root                       ANY, -- derived: requests_dedup_computed.root
  relative_path              ANY, -- derived: requests_dedup_computed.relative_path
  first_run_id               ANY, -- derived: requests_dedup_computed.first_run_id
  line_number                ANY  -- derived: requests_dedup_computed.line_number
) STRICT;

CREATE INDEX requests_dedup_raw_line_id ON requests_dedup (raw_line_id);
CREATE INDEX requests_dedup_dedup_key ON requests_dedup (dedup_key);
CREATE INDEX requests_dedup_time ON requests_dedup (timestamp_utc);
CREATE INDEX requests_dedup_session_time ON requests_dedup (session_id, timestamp_utc);
CREATE INDEX requests_dedup_cwd ON requests_dedup (cwd);

INSERT INTO requests_dedup (raw_line_id, dedup_key, message_id, request_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_write_unsplit_tokens, speed, session_id, timestamp_raw, timestamp_utc, cwd, is_sidechain, root, relative_path, first_run_id, line_number)
SELECT raw_line_id, dedup_key, message_id, request_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_write_unsplit_tokens, speed, session_id, timestamp_raw, timestamp_utc, cwd, is_sidechain, root, relative_path, first_run_id, line_number FROM requests_dedup_computed;

DROP VIEW window_readings;

-- Observed: one row per observation of a plan window, as 028 computed it; ingest stores its rows in window_readings (D-096). As in 026 (D-044, D-045, D-086), with stale = 1 when a counted reading is more than 1 point below an earlier counted one in its window (D-089).
CREATE VIEW window_readings_computed AS
WITH readings AS (
  SELECT
    w.raw_line_id, w.window, w.resets_at, w.used_percentage, s.session_id, s.captured_at_s,
    -- The response behind the latest request line in this session, inside this window, at or before
    -- the capture (+1 s for whole-second captures). An unkeyed line is its own response.
    (SELECT COALESCE(rq.dedup_key, 'line:' || rq.raw_line_id)
       FROM parsed_lines p
       JOIN requests rq ON rq.raw_line_id = p.raw_line_id
       WHERE p.session_id = s.session_id AND p.class = 'request'
         AND p.timestamp_utc > strftime('%Y-%m-%dT%H:%M:%fZ',
               w.resets_at - CASE w.window WHEN 'five_hour' THEN 5 * 3600 ELSE 7 * 86400 END, 'unixepoch')
         AND p.timestamp_utc < strftime('%Y-%m-%dT%H:%M:%fZ', s.captured_at_s + 1, 'unixepoch')
       ORDER BY p.timestamp_utc DESC, p.raw_line_id DESC
       LIMIT 1) AS response_key
  FROM rate_limit_windows w
  JOIN status_readings s ON s.raw_line_id = w.raw_line_id
  WHERE s.status = 'ok' AND w.validity = 'valid' AND w.window IN ('five_hour', 'seven_day')
),
dated AS (
  SELECT
    r.*,
    -- The response's first line: when its numbers first existed.
    (SELECT MIN(p.timestamp_utc)
       FROM requests rq
       JOIN parsed_lines p ON p.raw_line_id = rq.raw_line_id
       WHERE (r.response_key LIKE 'line:%' AND rq.raw_line_id = CAST(substr(r.response_key, 6) AS INTEGER))
          OR rq.dedup_key = r.response_key) AS response_first_utc,
    -- The previous capture of the same response, in capture order.
    LAG(r.used_percentage) OVER captures AS previous_used_percentage
  FROM readings r
  -- A capture-time fallback is its own group: NULL response keys must not merge (D-044).
  WINDOW captures AS (
    PARTITION BY r.window, r.resets_at, r.session_id, r.response_key,
                 CASE WHEN r.response_key IS NULL THEN r.raw_line_id END
    ORDER BY r.captured_at_s, r.raw_line_id
  )
),
runs AS (
  SELECT
    d.*,
    -- A new run starts at the first capture and at every change of more than 0.01 points: payloads
    -- carry computed values such as 7.000000000000001, which are the same number (D-044, D-086).
    SUM(CASE WHEN d.previous_used_percentage IS NULL
               OR abs(d.used_percentage - d.previous_used_percentage) > 0.01 THEN 1 ELSE 0 END)
      OVER (
        PARTITION BY d.window, d.resets_at, d.session_id, d.response_key,
                     CASE WHEN d.response_key IS NULL THEN d.raw_line_id END
        ORDER BY d.captured_at_s, d.raw_line_id
        ROWS UNBOUNDED PRECEDING
      ) AS run
  FROM dated d
),
observed AS (
  SELECT
    u.*,
    -- A later run's value didn't come from the response, so it's dated when it was first seen.
    CASE
      WHEN u.response_first_utc IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ', u.captured_at_s, 'unixepoch')
      WHEN u.run = 1 THEN u.response_first_utc
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ', MIN(u.captured_at_s) OVER run_captures, 'unixepoch')
    END AS observed_at_utc,
    ROW_NUMBER() OVER run_captures_latest AS copy_rank
  FROM runs u
  WINDOW
    run_captures AS (
      PARTITION BY u.window, u.resets_at, u.session_id, u.response_key,
                   CASE WHEN u.response_key IS NULL THEN u.raw_line_id END, u.run
    ),
    run_captures_latest AS (
      PARTITION BY u.window, u.resets_at, u.session_id, u.response_key,
                   CASE WHEN u.response_key IS NULL THEN u.raw_line_id END, u.run
      ORDER BY u.captured_at_s DESC, u.raw_line_id DESC
    )
),
counted AS (
  SELECT
    raw_line_id,
    window,
    resets_at,
    strftime('%Y-%m-%dT%H:%M:%fZ', resets_at, 'unixepoch') AS reset_at_utc,
    used_percentage,
    session_id,
    captured_at_s,
    strftime('%Y-%m-%dT%H:%M:%fZ', captured_at_s, 'unixepoch') AS captured_at_utc,
    observed_at_utc,
    unixepoch(observed_at_utc, 'subsec') AS observed_at_s,
    CASE
      WHEN response_key IS NULL THEN 'capture'
      WHEN run = 1 THEN 'last_request'
      ELSE 'changed_capture'
    END AS observed_via,
    unixepoch(observed_at_utc, 'subsec') > resets_at AS after_reset
  FROM observed
  WHERE copy_rank = 1
)
SELECT
  c.*,
  -- Usage within one window only rises, so a counted reading more than 1 point below an earlier one
  -- in the same window, from any session, carries a number from before that earlier reading (D-089).
  CASE
    WHEN c.after_reset = 0 AND c.used_percentage < MAX(c.used_percentage) OVER (
      PARTITION BY c.window, c.resets_at ORDER BY c.observed_at_s, c.raw_line_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) - 1 THEN 1
    ELSE 0
  END AS stale
FROM counted c;

CREATE TABLE window_readings (
  raw_line_id     ANY, -- derived: window_readings_computed.raw_line_id
  window          ANY, -- derived: window_readings_computed.window
  resets_at       ANY, -- derived: window_readings_computed.resets_at
  reset_at_utc    ANY, -- derived: window_readings_computed.reset_at_utc
  used_percentage ANY, -- derived: window_readings_computed.used_percentage
  session_id      ANY, -- derived: window_readings_computed.session_id
  captured_at_s   ANY, -- derived: window_readings_computed.captured_at_s
  captured_at_utc ANY, -- derived: window_readings_computed.captured_at_utc
  observed_at_utc ANY, -- derived: window_readings_computed.observed_at_utc
  observed_at_s   ANY, -- derived: window_readings_computed.observed_at_s
  observed_via    ANY, -- derived: window_readings_computed.observed_via
  after_reset     ANY, -- derived: window_readings_computed.after_reset
  stale           ANY  -- derived: window_readings_computed.stale
) STRICT;

CREATE INDEX window_readings_raw_line ON window_readings (raw_line_id);
CREATE INDEX window_readings_instance ON window_readings (window, reset_at_utc, observed_at_s);
CREATE INDEX window_readings_session_time ON window_readings (session_id, observed_at_s);
CREATE INDEX window_readings_time ON window_readings (observed_at_utc);

INSERT INTO window_readings (raw_line_id, window, resets_at, reset_at_utc, used_percentage, session_id, captured_at_s, captured_at_utc, observed_at_utc, observed_at_s, observed_via, after_reset, stale)
SELECT raw_line_id, window, resets_at, reset_at_utc, used_percentage, session_id, captured_at_s, captured_at_utc, observed_at_utc, observed_at_s, observed_via, after_reset, stale FROM window_readings_computed;

-- Statistics for the query planner, so the first report after this migration is fast too (D-096).
ANALYZE;
