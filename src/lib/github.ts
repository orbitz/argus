import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { config } from '../config.js';
import { cachedFetch, TTL, type CacheMode } from './api-cache.js';

const ArgusOctokit = Octokit.plugin(retry, throttling);

// Singleton Octokit instance (single-token auth = one user)
let octokitInstance: Octokit | null = null;

export function initOctokit(accessToken: string): Octokit {
  if (octokitInstance) {
    return octokitInstance;
  }

  // Note: there is deliberately no `request.agent` here. Octokit v21 is fetch-based and
  // silently ignores that option — the http.Agent instances it used to build were dead
  // code. Connection pooling comes from undici's global dispatcher.
  octokitInstance = new ArgusOctokit({
    auth: accessToken,
    request: {
      // Octokit v21 has no `timeout` option; the only way to bound a request is to supply
      // our own fetch. Without this a hung connection hangs the Fastify handler forever.
      fetch: (url: any, init?: any) =>
        fetch(url, {
          ...init,
          signal: init?.signal ?? AbortSignal.timeout(config.github.requestTimeoutMs),
        }),
    },
    throttle: {
      onRateLimit: (retryAfter: number, options: any, _o: unknown, retryCount: number) => {
        if (retryCount < 2) return true;
        console.warn(`Rate limit hit for ${options.method} ${options.url}; giving up`);
        return false;
      },
      onSecondaryRateLimit: (retryAfter: number, options: any, _o: unknown, retryCount: number) => {
        if (retryCount < 2) return true;
        console.warn(`Secondary rate limit for ${options.method} ${options.url}; giving up`);
        return false;
      },
    },
  }) as Octokit;

  return octokitInstance;
}

export function getOctokit(): Octokit {
  if (!octokitInstance) {
    throw new Error('Octokit not initialized. Call initOctokit first.');
  }
  return octokitInstance;
}

export function cleanupOctokit(): void {
  octokitInstance = null;
}

// Backward compatibility - returns singleton
export function createUserOctokit(_accessToken?: string): Octokit {
  return getOctokit();
}

// Cache keys for a PR's resources. Kept next to the fetchers so prCacheKeys() in
// api-cache.ts and the fetchers below can't drift apart.
const prKey = (owner: string, repo: string, n: number) => `pr:${owner}/${repo}#${n}`;
const prFilesKey = (owner: string, repo: string, n: number) => `pr-files:${owner}/${repo}#${n}`;
const prReviewsKey = (owner: string, repo: string, n: number) => `pr-reviews:${owner}/${repo}#${n}`;
const prReviewCommentsKey = (owner: string, repo: string, n: number) =>
  `pr-review-comments:${owner}/${repo}#${n}`;
const prIssueCommentsKey = (owner: string, repo: string, n: number) =>
  `pr-issue-comments:${owner}/${repo}#${n}`;
const prCommitsKey = (owner: string, repo: string, n: number) => `pr-commits:${owner}/${repo}#${n}`;
const prTimelineKey = (owner: string, repo: string, n: number) => `pr-timeline:${owner}/${repo}#${n}`;
const prHeadShaKey = (owner: string, repo: string, n: number) => `pr-head-sha:${owner}/${repo}#${n}`;
const checksKey = (owner: string, repo: string, ref: string) => `checks:${owner}/${repo}@${ref}`;
const statusKey = (owner: string, repo: string, ref: string) => `status:${owner}/${repo}@${ref}`;

export {
  prKey,
  prFilesKey,
  prReviewsKey,
  prReviewCommentsKey,
  prIssueCommentsKey,
  prCommitsKey,
  prTimelineKey,
  prHeadShaKey,
};

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
  prNumber: number,
  mode?: CacheMode
): Promise<PRData> {
  const result = await cachedFetch<PRData>(
    prKey(owner, repo, prNumber),
    { ttlMs: TTL.pr, mode },
    async (headers) => {
      const response = await octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
        headers,
      });
      return { data: response.data as PRData, etag: response.headers.etag || null };
    }
  );
  return result.data;
}

// Fetch PR files
export async function fetchPRFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  mode?: CacheMode
): Promise<PRFile[]> {
  const result = await cachedFetch<PRFile[]>(
    prFilesKey(owner, repo, prNumber),
    { ttlMs: TTL.files, mode },
    async (headers) => {
      // The first page carries the ETag we validate against. Only keep paginating when the
      // Link header says more pages remain — most PRs fit in one page, so the common case is
      // a single request that 304s on repeat loads.
      const first = await octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
        headers,
      });

      let files = first.data as PRFile[];
      const link = first.headers.link;
      if (typeof link === 'string' && link.includes('rel="next"')) {
        const rest = await octokit.paginate(octokit.pulls.listFiles, {
          owner,
          repo,
          pull_number: prNumber,
          per_page: 100,
          page: 2,
        });
        files = files.concat(rest as PRFile[]);
      }

      return { data: files, etag: first.headers.etag || null };
    }
  );
  return result.data;
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
  ref: string,
  mode?: CacheMode
): Promise<CheckRun[]> {
  const result = await cachedFetch<CheckRun[]>(
    checksKey(owner, repo, ref),
    { ttlMs: TTL.checks, mode },
    async (headers) => {
      const response = await octokit.checks.listForRef({
        owner,
        repo,
        ref,
        per_page: 100,
        headers,
      });
      return {
        data: response.data.check_runs as CheckRun[],
        etag: response.headers.etag || null,
      };
    }
  );
  return result.data;
}

// Fetch combined status for a commit
export async function fetchCombinedStatus(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  mode?: CacheMode
): Promise<{ state: string; statuses: any[] }> {
  const result = await cachedFetch<{ state: string; statuses: any[] }>(
    statusKey(owner, repo, ref),
    { ttlMs: TTL.status, mode },
    async (headers) => {
      const response = await octokit.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref,
        headers,
      });
      return {
        data: { state: response.data.state, statuses: response.data.statuses },
        etag: response.headers.etag || null,
      };
    }
  );
  return result.data;
}

// Fetch review comments (inline)
export async function fetchReviewComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  mode?: CacheMode
): Promise<ReviewComment[]> {
  const result = await cachedFetch<ReviewComment[]>(
    prReviewCommentsKey(owner, repo, prNumber),
    { ttlMs: TTL.comments, mode },
    async (headers) => {
      const response = await octokit.pulls.listReviewComments({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
        headers,
      });
      return { data: response.data as ReviewComment[], etag: response.headers.etag || null };
    }
  );
  return result.data;
}

// Fetch issue comments (top-level)
export async function fetchIssueComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  mode?: CacheMode
): Promise<IssueComment[]> {
  const result = await cachedFetch<IssueComment[]>(
    prIssueCommentsKey(owner, repo, prNumber),
    { ttlMs: TTL.comments, mode },
    async (headers) => {
      const response = await octokit.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
        headers,
      });
      return { data: response.data as IssueComment[], etag: response.headers.etag || null };
    }
  );
  return result.data;
}

// Fetch reviews
export async function fetchReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  mode?: CacheMode
): Promise<any[]> {
  const result = await cachedFetch<any[]>(
    prReviewsKey(owner, repo, prNumber),
    { ttlMs: TTL.reviews, mode },
    async (headers) => {
      const response = await octokit.pulls.listReviews({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
        headers,
      });
      return { data: response.data, etag: response.headers.etag || null };
    }
  );
  return result.data;
}

// --- Dashboard via GraphQL ---------------------------------------------------------
//
// The REST dashboard cost ~316 requests: one repo list, one pulls list per repo, then
// two per PR (changed_files + reviews) for up to 150 PRs, funnelled through a
// concurrency limiter — roughly 19 serialized round-trip waves. GraphQL returns the same
// data shape in a single request.

export interface DashboardPull {
  number: number;
  title: string;
  author: string;
  updatedAt: string;
  draft: boolean;
  headSha: string;
  changedFiles: number;
  reviews: Array<{ state: string; user: { login: string } }>;
}

export interface DashboardRepo {
  owner: string;
  name: string;
  fullName: string;
  pulls: DashboardPull[];
}

const DASHBOARD_QUERY = `
  query Dashboard($repos: Int!, $prs: Int!) {
    viewer {
      repositories(
        first: $repos
        orderBy: { field: PUSHED_AT, direction: DESC }
        affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
        # ownerAffiliations is a SEPARATE filter from affiliations, and it defaults to
        # [OWNER, COLLABORATOR] — which drops every organization-owned repository even
        # when affiliations includes ORGANIZATION_MEMBER. REST's
        # repos.listForAuthenticatedUser has no equivalent filter, so it must be widened
        # here or the dashboard silently loses most org repos.
        ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      ) {
        nodes {
          name
          nameWithOwner
          owner { login }
          pullRequests(
            first: $prs
            states: OPEN
            orderBy: { field: UPDATED_AT, direction: DESC }
          ) {
            nodes {
              number
              title
              isDraft
              updatedAt
              changedFiles
              headRefOid
              author { login }
              reviews(last: 50) {
                nodes {
                  state
                  author { login }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Cache key for the dashboard payload. The version segment is bumped whenever the query
 * changes shape or scope, so a stale entry from an older (in v1's case, wrong) query is
 * never served — stale-while-revalidate would otherwise hand back the old result once
 * more even after the fix shipped.
 *
 * v2: widened ownerAffiliations; v1 silently omitted organization-owned repos.
 */
export function dashboardCacheKey(login: string): string {
  return `dashboard:v2:${login}`;
}

export async function fetchDashboardGraphql(
  octokit: Octokit,
  login: string,
  mode?: CacheMode
): Promise<DashboardRepo[]> {
  const result = await cachedFetch<DashboardRepo[]>(
    dashboardCacheKey(login),
    { ttlMs: TTL.dashboard, mode },
    async () => {
      const response: any = await octokit.graphql(DASHBOARD_QUERY, {
        repos: config.github.dashboardRepoLimit,
        prs: config.github.dashboardPrsPerRepo,
      });

      const repos: DashboardRepo[] = (response?.viewer?.repositories?.nodes ?? [])
        .filter(Boolean)
        .map((repo: any): DashboardRepo => ({
          owner: repo.owner?.login ?? '',
          name: repo.name,
          fullName: repo.nameWithOwner,
          pulls: (repo.pullRequests?.nodes ?? []).filter(Boolean).map((pr: any): DashboardPull => ({
            number: pr.number,
            title: pr.title,
            author: pr.author?.login ?? 'unknown',
            updatedAt: pr.updatedAt,
            draft: !!pr.isDraft,
            headSha: pr.headRefOid ?? '',
            changedFiles: pr.changedFiles ?? 0,
            // Reshaped to match the REST review payload so getApprovers() works on both.
            reviews: (pr.reviews?.nodes ?? [])
              .filter((r: any) => r?.author?.login)
              .map((r: any) => ({ state: r.state, user: { login: r.author.login } })),
          })),
        }))
        .filter((repo: DashboardRepo) => repo.pulls.length > 0);

      // GraphQL responses carry no usable ETag, so this is a TTL + stale-while-revalidate
      // cache rather than a conditional one.
      return { data: repos, etag: null };
    }
  );
  return result.data;
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

export interface PRCommit {
  sha: string;
  commit: {
    message: string;
    author: { name?: string; date?: string } | null;
  };
  author: { login: string; avatar_url: string } | null;
  html_url: string;
}

// Fetch commits in a PR
export async function fetchPRCommits(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  mode?: CacheMode
): Promise<PRCommit[]> {
  const result = await cachedFetch<PRCommit[]>(
    prCommitsKey(owner, repo, prNumber),
    { ttlMs: TTL.commits, mode },
    async (headers) => {
      const response = await octokit.pulls.listCommits({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100, // GitHub's hard maximum; the old 250 was silently clamped anyway
        headers,
      });
      return {
        data: response.data.map((c) => ({
          sha: c.sha,
          commit: {
            message: c.commit.message,
            author: c.commit.author,
          },
          author: c.author ? { login: c.author.login, avatar_url: c.author.avatar_url } : null,
          html_url: c.html_url,
        })),
        etag: response.headers.etag || null,
      };
    }
  );
  return result.data;
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
  prNumber: number,
  mode?: CacheMode
): Promise<{ headSha: string; updatedAt: string }> {
  // Polled every 45s per open tab, so caching this matters more than its size suggests.
  const result = await cachedFetch<{ headSha: string; updatedAt: string }>(
    prHeadShaKey(owner, repo, prNumber),
    { ttlMs: TTL.headSha, mode },
    async (headers) => {
      const response = await octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
        headers,
      });
      return {
        data: { headSha: response.data.head.sha, updatedAt: response.data.updated_at },
        etag: response.headers.etag || null,
      };
    }
  );
  return result.data;
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
  prNumber: number,
  mode?: CacheMode
): Promise<TimelineEvent[]> {
  try {
    const result = await cachedFetch<TimelineEvent[]>(
      prTimelineKey(owner, repo, prNumber),
      { ttlMs: TTL.timeline, mode },
      async (headers) => {
        const response = await octokit.request(
          'GET /repos/{owner}/{repo}/issues/{issue_number}/timeline',
          {
            owner,
            repo,
            issue_number: prNumber,
            per_page: 100,
            headers: {
              ...headers,
              accept: 'application/vnd.github.mockingbird-preview+json',
            },
          }
        );
        return { data: response.data as TimelineEvent[], etag: response.headers.etag || null };
      }
    );
    return result.data;
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
  username: string,
  mode?: CacheMode
): Promise<ReviewRequestItem[]> {
  const result = await cachedFetch<ReviewRequestItem[]>(
    `review-requests:${username}`,
    { ttlMs: TTL.reviewRequests, mode },
    async (headers) => {
      const response = await octokit.request('GET /search/issues', {
        q: `type:pr state:open review-requested:${username}`,
        per_page: 100,
        sort: 'updated',
        order: 'desc',
        headers,
      });

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

      return { data: items, etag: response.headers.etag || null };
    }
  );
  return result.data;
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
