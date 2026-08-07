import { query } from '../db/index.js';

/**
 * Get list of file paths that a user has marked as reviewed for a specific PR,
 * persisting across revisions for files whose blob SHA hasn't changed.
 */
export function getReviewedFiles(
  userId: number,
  owner: string,
  repo: string,
  prNumber: number,
  currentFileShas: Map<string, string>
): string[] {
  const { rows } = query<{ file_path: string; file_sha: string }>(
    `SELECT file_path, file_sha FROM file_reviews
     WHERE user_id = ? AND owner = ? AND repo = ? AND pr_number = ?`,
    [userId, owner, repo, prNumber]
  );
  return rows
    .filter(r => r.file_sha && currentFileShas.get(r.file_path) === r.file_sha)
    .map(r => r.file_path);
}

/**
 * Count files a user has marked reviewed for a PR at a specific head SHA — a cheap,
 * file-list-free progress figure for summary screens (the dashboard). Unlike
 * getReviewedFiles it does not validate each blob SHA against the live file list
 * (which would require fetching every file), so it counts reviews recorded at the
 * current head. Good enough for an at-a-glance "X / N reviewed" badge.
 */
export function countReviewedFilesAtHead(
  userId: number,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string
): number {
  const { rows } = query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM file_reviews
     WHERE user_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?`,
    [userId, owner, repo, prNumber, headSha]
  );
  return rows[0]?.n ?? 0;
}

/**
 * Batched form of countReviewedFilesAtHead for the dashboard, which needs a count for
 * every open PR at once. One grouped query replaces one query per PR.
 *
 * Returns a map keyed `owner/repo#number@headSha`.
 */
export function countReviewedFilesBatch(
  userId: number,
  prs: Array<{ owner: string; repo: string; prNumber: number; headSha: string }>
): Map<string, number> {
  const counts = new Map<string, number>();
  if (prs.length === 0) return counts;

  const conditions = prs
    .map(() => '(owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?)')
    .join(' OR ');
  const params: any[] = [userId];
  for (const pr of prs) params.push(pr.owner, pr.repo, pr.prNumber, pr.headSha);

  const { rows } = query<{
    owner: string;
    repo: string;
    pr_number: number;
    head_sha: string;
    n: number;
  }>(
    `SELECT owner, repo, pr_number, head_sha, COUNT(*) AS n FROM file_reviews
     WHERE user_id = ? AND (${conditions})
     GROUP BY owner, repo, pr_number, head_sha`,
    params
  );

  for (const row of rows) {
    counts.set(`${row.owner}/${row.repo}#${row.pr_number}@${row.head_sha}`, row.n);
  }
  return counts;
}

/**
 * Idempotently mark a file as reviewed. No-op if already reviewed with the same SHA.
 */
export function markFileReviewed(
  userId: number,
  owner: string,
  repo: string,
  prNumber: number,
  filePath: string,
  headSha: string,
  fileSha: string
): void {
  const { rows } = query<{ id: number }>(
    `SELECT id FROM file_reviews
     WHERE user_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND file_path = ? AND file_sha = ?`,
    [userId, owner, repo, prNumber, filePath, fileSha]
  );

  if (rows.length > 0) return; // already reviewed with this SHA

  query(
    `DELETE FROM file_reviews
     WHERE user_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND file_path = ?`,
    [userId, owner, repo, prNumber, filePath]
  );
  query(
    `INSERT INTO file_reviews (user_id, owner, repo, pr_number, file_path, head_sha, file_sha)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, owner, repo, prNumber, filePath, headSha, fileSha]
  );
}

/**
 * Idempotently mark a file as unreviewed. No-op if not currently reviewed.
 */
export function markFileUnreviewed(
  userId: number,
  owner: string,
  repo: string,
  prNumber: number,
  filePath: string
): void {
  query(
    `DELETE FROM file_reviews
     WHERE user_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND file_path = ?`,
    [userId, owner, repo, prNumber, filePath]
  );
}

/**
 * Toggle file review status (mark as reviewed or un-review).
 * Returns true if file is now reviewed, false if un-reviewed.
 */
export function toggleFileReview(
  userId: number,
  owner: string,
  repo: string,
  prNumber: number,
  filePath: string,
  headSha: string,
  fileSha: string
): boolean {
  // Check if a review exists for this file with this blob SHA
  const { rows } = query<{ id: number }>(
    `SELECT id FROM file_reviews
     WHERE user_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND file_path = ? AND file_sha = ?`,
    [userId, owner, repo, prNumber, filePath, fileSha]
  );

  if (rows.length > 0) {
    // Delete (un-review)
    query(
      `DELETE FROM file_reviews WHERE id = ?`,
      [rows[0].id]
    );
    return false;
  } else {
    // Delete any old review for this file (different sha), then insert
    query(
      `DELETE FROM file_reviews
       WHERE user_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND file_path = ?`,
      [userId, owner, repo, prNumber, filePath]
    );
    query(
      `INSERT INTO file_reviews (user_id, owner, repo, pr_number, file_path, head_sha, file_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, owner, repo, prNumber, filePath, headSha, fileSha]
    );
    return true;
  }
}
