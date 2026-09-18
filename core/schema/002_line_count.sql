-- 002_line_count: remember how many complete lines precede each file's stored byte offset.
--
-- Incremental reads start mid-file (D-003). Without this count, the first new line couldn't be
-- given its true line number, and fixtures/README.md defines a line's number as where it was
-- first seen. Reset to 0 together with byte_offset when a rewrite is detected.

ALTER TABLE source_files ADD COLUMN line_count INTEGER NOT NULL DEFAULT 0 CHECK (line_count >= 0); -- derived: complete lines before byte_offset
