-- Cache table cleanup.
--
-- pr_snapshots was never read or written by any code path — it predates the api_cache /
-- diff_cache split. Dropping it also drops its two indexes.
DROP TABLE IF EXISTS pr_snapshots;

-- Redundant indexes. Each one duplicates an index SQLite already maintains, so they add
-- write cost on every cache insert for no read benefit:
--   idx_api_cache_key    — api_cache.cache_key is already UNIQUE
--   idx_pr_revisions_id  — id is the INTEGER PRIMARY KEY, i.e. the rowid
DROP INDEX IF EXISTS idx_api_cache_key;
DROP INDEX IF EXISTS idx_pr_revisions_id;

-- Supports the daily eviction pass (DELETE ... WHERE fetched_at < ?) now that one exists.
CREATE INDEX IF NOT EXISTS idx_api_cache_fetched_at ON api_cache(fetched_at);

-- Rebuild diff_cache with the syntax-highlighting flag in its key.
--
-- rendered_html contains the highlighted (or plain-escaped) markup, but the old key was
-- (owner, repo, head_sha, file_path) only. A repo with syntax highlighting toggled off
-- would therefore serve highlighted HTML from an entry written while it was on, and vice
-- versa. The table is a pure cache, so rebuilding it simply discards the old entries.
DROP TABLE IF EXISTS diff_cache;

CREATE TABLE diff_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT,
    repo TEXT,
    head_sha TEXT,
    file_path TEXT NOT NULL,
    highlighted INTEGER NOT NULL DEFAULT 1,
    diff_data TEXT NOT NULL,
    rendered_html TEXT,
    fetched_at TEXT DEFAULT (datetime('now')),
    UNIQUE(owner, repo, head_sha, file_path, highlighted)
);

CREATE INDEX idx_diff_cache_fetched_at ON diff_cache(fetched_at);
