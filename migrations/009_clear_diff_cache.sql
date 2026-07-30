-- Clear cached diff HTML rendered before the syntax-highlighting fix.
--
-- Rendered tables are keyed by (owner, repo, head_sha, file_path, highlighted), none of
-- which change when the *renderer* changes. Every row written before full-file context was
-- introduced can contain runaway highlighting — a block comment whose terminator fell in an
-- elided region between hunks coloured the rest of the file as comment. Without this, those
-- rows would keep being served for every already-viewed PR until the 7-day sweep in
-- src/index.ts expires them.
DELETE FROM diff_cache;
