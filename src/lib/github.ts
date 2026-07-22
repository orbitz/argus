import { Octokit } from '@octokit/rest';
import http from 'http';
import https from 'https';
import { config } from '../config.js';
import { query } from '../db/index.js';

// HTTP agents for keep-alive connection pooling
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50
});

// Singleton Octokit instance (single-token auth = one user)
let octokitInstance: Octokit | null = null;

export function initOctokit(accessToken: string): Octokit {
  if (octokitInstance) {
    return octokitInstance;
  }

  octokitInstance = new Octokit({
    auth: accessToken,
    request: {
      agent: (url: string) => url.startsWith('https:') ? httpsAgent : httpAgent
    }
  });

  return octokitInstance;
}

export function getOctokit(): Octokit {
  if (!octokitInstance) {
    throw new Error('Octokit not initialized. Call initOctokit first.');
  }
  return octokitInstance;
}

export function cleanupOctokit(): void {
  httpAgent.destroy();
  httpsAgent.destroy();
  octokitInstance = null;
}

// Backward compatibility - returns singleton
export function createUserOctokit(_accessToken?: string): Octokit {
  return getOctokit();
}

// API response types
export interface PRData {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: {
    login: string;
    avatar_url: string;
  };
  base: {
    ref: string;
    sha: string;
    repo: {
      full_name: string;
    };
  };
  head: {
    ref: string;
    sha: string;
    repo: {
      full_name: string;
    } | null;
  };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  merged_by?: {
    login: string;
    avatar_url: string;
  } | null;
  mergeable: boolean | null;
  mergeable_state: string;
  commits: number;
  additions: number;
  deletions: number;
  changed_files: number;
  draft: boolean;
  assignees?: Array<{
    login: string;
    avatar_url: string;
  }>;
  requested_reviewers?: Array<{
    login: string;
    avatar_url: string;
  }>;
  requested_teams?: Array<{
    name: string;
    slug: string;
  }>;
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}

export interface ReviewComment {
  id: number;
  user: {
    login: string;
    avatar_url: string;
  };
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  side: 'LEFT' | 'RIGHT';
  commit_id: string;
  original_commit_id: string;
  created_at: string;
  updated_at: string;
  in_reply_to_id?: number;
  html_url: string;
  diff_hunk: string;
}

export interface IssueComment {
  id: number;
  user: {
    login: string;
    avatar_url: string;
  };
  body: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface PRFile {
  sha: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

// Fetch PR data with caching
export async function fetchPR(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PRData> {
  const cacheKey = `pr:${owner}/${repo}#${prNumber}`;

  // Check cache first
  const { rows: cached } = query<{ data: string; etag: string }>(
    `SELECT data, etag FROM api_cache
     WHERE cache_key = ? AND expires_at > datetime('now')`,
    [cacheKey]
  );

  const headers: Record<string, string> = {};
  if (cached.length > 0 && cached[0].etag) {
    headers['If-None-Match'] = cached[0].etag;
  }

  try {
    const response = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      headers,
    });

    const etag = response.headers.etag || null;

    // Update cache (SQLite UPSERT)
    query(
      `INSERT INTO api_cache (cache_key, etag, data, fetched_at, expires_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now', '+${config.cacheTtl} seconds'))
       ON CONFLICT (cache_key) DO UPDATE SET
         etag = excluded.etag,
         data = excluded.data,
         fetched_at = datetime('now'),
         expires_at = datetime('now', '+${config.cacheTtl} seconds')`,
      [cacheKey, etag, JSON.stringify(response.data)]
    );

    return response.data as PRData;
  } catch (err: any) {
    if (err.status === 304 && cached.length > 0) {
      // Not modified, return cached data
      return JSON.parse(cached[0].data) as PRData;
    }
    throw err;
  }
}

// Fetch PR files
export async function fetchPRFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PRFile[]> {
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  return files as PRFile[];
}

// Fetch PR diff (raw)
export async function fetchPRDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<string> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: {
      format: 'diff',
    },
  });

  return response.data as unknown as string;
}

// Fetch checks for a commit
export async function fetchChecks(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<CheckRun[]> {
  const response = await octokit.checks.listForRef({
    owner,
    repo,
    ref,
    per_page: 100,
  });

  return response.data.check_runs as CheckRun[];
}

// Fetch combined status for a commit
export async function fetchCombinedStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string
): Promise<{ state: string; statuses: any[] }> {
  const response = await octokit.repos.getCombinedStatusForRef({
    owner,
    repo,
    ref,
  });

  return {
    state: response.data.state,
    statuses: response.data.statuses,
  };
}

// Fetch review comments (inline)
export async function fetchReviewComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<ReviewComment[]> {
  const response = await octokit.pulls.listReviewComments({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  return response.data as ReviewComment[];
}

// Fetch issue comments (top-level)
export async function fetchIssueComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<IssueComment[]> {
  const response = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  return response.data as IssueComment[];
}

// Fetch reviews
export async function fetchReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<any[]> {
  const response = await octokit.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  return response.data;
}

// Determine the set of users whose most recent decisive review approved the PR.
// Ignores COMMENTED/PENDING reviews, which don't change approval state.
export function getApprovers(reviews: any[]): string[] {
  const approved = new Map<string, boolean>();
  for (const review of reviews) {
    const login = review.user?.login;
    if (!login) continue;
    const state = review.state;
    if (state === 'APPROVED') approved.set(login, true);
    else if (state === 'CHANGES_REQUESTED' || state === 'DISMISSED') approved.set(login, false);
  }
  return [...approved.entries()].filter(([, ok]) => ok).map(([login]) => login);
}

// Post a top-level comment
export async function postComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string
): Promise<void> {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

// Submit a review
export async function submitReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  body?: string
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event,
    body,
  });
}

// Create an inline review comment
export async function createReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  commitId: string,
  path: string,
  line: number,
  side: 'LEFT' | 'RIGHT' = 'RIGHT'
): Promise<number> {
  const response = await octokit.pulls.createReviewComment({
    owner,
    repo,
    pull_number: prNumber,
    body,
    commit_id: commitId,
    path,
    line,
    side,
  });
  return response.data.id;
}

// Reply to a review comment
export async function replyToReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commentId: number,
  body: string
): Promise<void> {
  await octokit.pulls.createReplyForReviewComment({
    owner,
    repo,
    pull_number: prNumber,
    comment_id: commentId,
    body,
  });
}

// Fetch commits in a PR
export async function fetchPRCommits(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<Array<{
  sha: string;
  commit: {
    message: string;
    author: { name?: string; date?: string } | null;
  };
  author: { login: string; avatar_url: string } | null;
  html_url: string;
}>> {
  const response = await octokit.pulls.listCommits({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 250,
  });

  return response.data.map(c => ({
    sha: c.sha,
    commit: {
      message: c.commit.message,
      author: c.commit.author,
    },
    author: c.author ? { login: c.author.login, avatar_url: c.author.avatar_url } : null,
    html_url: c.html_url,
  }));
}

// Fetch a single commit
export async function fetchCommit(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string
): Promise<{
  sha: string;
  commit: {
    message: string;
    author: { name?: string; date?: string } | null;
  };
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
  }>;
}> {
  const response = await octokit.repos.getCommit({
    owner,
    repo,
    ref: sha,
  });

  return {
    sha: response.data.sha,
    commit: {
      message: response.data.commit.message,
      author: response.data.commit.author,
    },
    files: (response.data.files || []).map(f => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch,
    })),
  };
}

// Compare two commits
export async function compareCommits(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<{
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  files: PRFile[];
  commits: Array<{
    sha: string;
    commit: { message: string; author: { name?: string; date?: string } | null };
    author: { login: string; avatar_url: string } | null;
  }>;
}> {
  const response = await octokit.repos.compareCommits({
    owner,
    repo,
    base,
    head,
  });

  return {
    ahead_by: response.data.ahead_by,
    behind_by: response.data.behind_by,
    total_commits: response.data.total_commits,
    files: (response.data.files || []) as PRFile[],
    commits: response.data.commits.map(c => ({
      sha: c.sha,
      commit: {
        message: c.commit.message,
        author: c.commit.author,
      },
      author: c.author ? { login: c.author.login, avatar_url: c.author.avatar_url } : null,
    })),
  };
}

// Get head SHA only (lightweight)
export async function fetchHeadSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ headSha: string; updatedAt: string }> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  return {
    headSha: response.data.head.sha,
    updatedAt: response.data.updated_at,
  };
}

export interface TimelineEvent {
  event: string;
  created_at: string;
  actor?: {
    login: string;
    avatar_url: string;
  };
  // For commits
  sha?: string;
  commit_id?: string;
  // For reviews
  state?: string;
  body?: string;
  // For assignments
  assignee?: {
    login: string;
    avatar_url: string;
  };
  assigner?: {
    login: string;
    avatar_url: string;
  };
  // For review requests
  requested_reviewer?: {
    login: string;
    avatar_url: string;
  };
  requested_team?: {
    name: string;
    slug: string;
  };
  // For merges
  commit_url?: string;
  // For labels
  label?: {
    name: string;
    color: string;
  };
  // For milestones
  milestone?: {
    title: string;
  };
  // For renames
  rename?: {
    from: string;
    to: string;
  };
}

// Fetch PR timeline events (force pushes, approvals, merges, etc.)
export async function fetchPRTimeline(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<TimelineEvent[]> {
  try {
    const response = await octokit.request(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/timeline',
      {
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
        headers: {
          accept: 'application/vnd.github.mockingbird-preview+json',
        },
      }
    );

    return response.data as TimelineEvent[];
  } catch (err) {
    console.error('Failed to fetch PR timeline:', err);
    return [];
  }
}

// Fetch PRs where the user's review is requested
export interface ReviewRequestItem {
  number: number;
  title: string;
  owner: string;
  repo: string;
  fullName: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at: string;
  draft: boolean;
}

export async function fetchReviewRequests(
  octokit: Octokit,
  username: string
): Promise<ReviewRequestItem[]> {
  const cacheKey = `review-requests:${username}`;

  const { rows: cached } = query<{ data: string; etag: string }>(
    `SELECT data, etag FROM api_cache
     WHERE cache_key = ? AND expires_at > datetime('now')`,
    [cacheKey]
  );

  const headers: Record<string, string> = {};
  if (cached.length > 0 && cached[0].etag) {
    headers['If-None-Match'] = cached[0].etag;
  }

  try {
    const response = await octokit.request('GET /search/issues', {
      q: `type:pr state:open review-requested:${username}`,
      per_page: 100,
      sort: 'updated',
      order: 'desc',
      headers,
    });

    const etag = response.headers.etag || null;
    const items: ReviewRequestItem[] = response.data.items.map((item: any) => {
      const repoUrl: string = item.repository_url || '';
      const parts = repoUrl.split('/');
      const repo = parts[parts.length - 1];
      const owner = parts[parts.length - 2];
      return {
        number: item.number,
        title: item.title,
        owner,
        repo,
        fullName: `${owner}/${repo}`,
        user: { login: item.user.login, avatar_url: item.user.avatar_url },
        created_at: item.created_at,
        updated_at: item.updated_at,
        draft: !!item.draft,
      };
    });

    query(
      `INSERT INTO api_cache (cache_key, etag, data, fetched_at, expires_at)
       VALUES (?, ?, ?, datetime('now'), datetime('now', '+30 seconds'))
       ON CONFLICT (cache_key) DO UPDATE SET
         etag = excluded.etag,
         data = excluded.data,
         fetched_at = datetime('now'),
         expires_at = datetime('now', '+30 seconds')`,
      [cacheKey, etag, JSON.stringify(items)]
    );

    return items;
  } catch (err: any) {
    if (err.status === 304 && cached.length > 0) {
      return JSON.parse(cached[0].data) as ReviewRequestItem[];
    }
    throw err;
  }
}

// Merge a pull request
// Fetch raw file content at a specific ref
export async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string> {
  const response = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref,
    mediaType: { format: 'raw' },
  });

  return response.data as unknown as string;
}

// Fetch raw file bytes at a specific ref (binary-safe). Returns null if the
// path is not a fetchable file (e.g. too large, missing, a directory).
export async function fetchFileBuffer(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<Buffer | null> {
  try {
    const response = await octokit.repos.getContent({ owner, repo, path, ref });
    const data = response.data as { content?: string; encoding?: string };
    if (data.content && data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64');
    }
    return null;
  } catch {
    return null;
  }
}

export async function mergePR(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commitTitle?: string,
  commitMessage?: string,
  mergeMethod: 'merge' | 'squash' | 'rebase' = 'merge'
): Promise<{ merged: boolean; message: string; sha?: string }> {
  try {
    const response = await octokit.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      commit_title: commitTitle,
      commit_message: commitMessage,
      merge_method: mergeMethod,
    });

    return {
      merged: response.data.merged,
      message: response.data.message,
      sha: response.data.sha,
    };
  } catch (err: any) {
    console.error('Failed to merge PR:', err);
    return {
      merged: false,
      message: err.message || 'Failed to merge PR',
    };
  }
}
