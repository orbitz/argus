-- Migration: Commit Reviews
-- Tracks which commits a user has reviewed in a PR.
--
-- Unlike file_reviews, no head_sha/blob_sha invalidation is needed: a commit SHA already
-- identifies its content. After a force push the rewritten commits simply have no rows, and a
-- commit that survives a rebase unchanged keeps its review. Rows for dropped SHAs are inert.

CREATE TABLE IF NOT EXISTS commit_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    commit_sha TEXT NOT NULL,
    reviewed_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, owner, repo, pr_number, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_commit_reviews_lookup
    ON commit_reviews(user_id, owner, repo, pr_number);
