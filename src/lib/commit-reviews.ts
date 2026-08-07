import { query } from '../db/index.js';

/**
 * Commit SHAs the user has marked reviewed for a PR.
 *
 * The file_reviews equivalent has to re-check each stored blob SHA against the live file list,
 * because a path can point at different content across revisions. A commit SHA is its content,
 * so a plain lookup is enough here.
 */
export function getReviewedCommits(
  userId: number,
  owner: string,
  repo: string,
  prNumber: number
): string[] {
  const { rows } = query<{ commit_sha: string }>(
    `SELECT commit_sha FROM commit_reviews
     WHERE user_id = ? AND owner = ? AND repo = ? AND pr_number = ?`,
    [userId, owner, repo, prNumber]
  );
  return rows.map(r => r.commit_sha);
}

/**
 * Toggle commit review status. Returns true if the commit is now reviewed.
 */
export function toggleCommitReview(
  userId: number,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string
): boolean {
  const { rows } = query<{ id: number }>(
    `SELECT id FROM commit_reviews
     WHERE user_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND commit_sha = ?`,
    [userId, owner, repo, prNumber, commitSha]
  );

  if (rows.length > 0) {
    query(`DELETE FROM commit_reviews WHERE id = ?`, [rows[0].id]);
    return false;
  }

  query(
    `INSERT INTO commit_reviews (user_id, owner, repo, pr_number, commit_sha)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, owner, repo, prNumber, commitSha]
  );
  return true;
}
