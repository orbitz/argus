import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { performance } from 'node:perf_hooks';
import { requireAuth } from '../middleware/auth.js';
import {
  createUserOctokit,
  fetchPR,
  fetchReviews,
  getApprovers,
  fetchDashboardGraphql,
  dashboardCacheKey,
  type DashboardRepo,
} from '../lib/github.js';
import { countReviewedFilesBatch } from '../lib/file-reviews.js';
import { getFetchedAt, type CacheMode } from '../lib/api-cache.js';
import { config } from '../config.js';
import type { Octokit } from '@octokit/rest';

// Bound how many PRs are enriched concurrently on the REST fallback path. Each enrich is
// two requests, so firing them all at once bursts past GitHub's secondary rate limit.
const ENRICH_CONCURRENCY = 8;

function createLimiter(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const pump = () => {
    while (active < max && queue.length > 0) {
      active++;
      queue.shift()!();
    }
  };
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
  };
}

/**
 * REST fallback for the dashboard, kept for when the GraphQL query fails (an unusual repo
 * shape, a token without the scopes GraphQL needs, or DASHBOARD_GRAPHQL=0).
 *
 * This is the expensive path: 1 repo list + one pulls list per repo + two requests per PR,
 * funnelled through a concurrency limiter. On an account with 15 active repos it is ~316
 * requests and roughly 19 serialized round-trip waves.
 */
async function fetchDashboardRest(
  octokit: Octokit,
  mode: CacheMode
): Promise<DashboardRepo[]> {
  const { data: repos } = await octokit.repos.listForAuthenticatedUser({
    sort: 'pushed',
    per_page: 30,
  });

  const limit = createLimiter(ENRICH_CONCURRENCY);

  const results = await Promise.all(
    repos.slice(0, config.github.dashboardRepoLimit).map(async (repo): Promise<DashboardRepo | null> => {
      const owner = repo.owner?.login || '';
      try {
        const { data: pulls } = await octokit.pulls.list({
          owner,
          repo: repo.name,
          state: 'open',
          sort: 'updated',
          direction: 'desc',
          per_page: config.github.dashboardPrsPerRepo,
        });
        if (pulls.length === 0) return null;

        const enriched = await Promise.all(
          pulls.map(async (pr) => {
            // changed_files is not in the pulls.list payload, and reviews need their own
            // request — hence two calls per PR. Failures degrade to zero/unapproved.
            const extra = await limit(async () => {
              try {
                const [full, reviews] = await Promise.all([
                  fetchPR(octokit, owner, repo.name, pr.number, mode),
                  fetchReviews(octokit, owner, repo.name, pr.number, mode),
                ]);
                return {
                  changedFiles: full.changed_files ?? 0,
                  reviews: reviews as Array<{ state: string; user: { login: string } }>,
                };
              } catch {
                return { changedFiles: 0, reviews: [] };
              }
            });

            return {
              number: pr.number,
              title: pr.title,
              author: pr.user?.login || 'unknown',
              updatedAt: pr.updated_at,
              draft: pr.draft || false,
              headSha: pr.head?.sha || '',
              ...extra,
            };
          })
        );

        return { owner, name: repo.name, fullName: repo.full_name, pulls: enriched };
      } catch {
        return null;
      }
    })
  );

  return results.filter((r): r is DashboardRepo => r !== null);
}

export async function dashboardRoutes(fastify: FastifyInstance) {
  // Dashboard - show open PRs grouped by repo
  fastify.get('/dashboard', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(request, reply)) return;

    try {
      const octokit = createUserOctokit(request.user!.accessToken);
      const userId = request.user!.githubUserId;
      const login = request.user!.login;

      const perfStart = performance.now();
      const cacheMode: CacheMode =
        (request.query as { refresh?: string }).refresh === '1' ? 'bypass' : 'normal';

      // One GraphQL request replaces the whole REST fan-out. Fall back automatically so a
      // GraphQL failure degrades to a slow dashboard rather than a broken one.
      //
      // ?source=rest / ?source=graphql overrides the configured default for one request,
      // so the two paths can be compared side by side without a restart.
      const sourceOverride = (request.query as { source?: string }).source;
      const useGraphql =
        sourceOverride === 'graphql' ||
        (sourceOverride !== 'rest' && config.github.dashboardGraphql);

      const fetchStart = performance.now();
      let source: 'graphql' | 'rest' = 'rest';
      let repoData: DashboardRepo[];
      if (useGraphql) {
        try {
          repoData = await fetchDashboardGraphql(octokit, login, cacheMode);
          source = 'graphql';
        } catch (err) {
          request.log.warn({ err }, 'dashboard GraphQL query failed; falling back to REST');
          repoData = await fetchDashboardRest(octokit, cacheMode);
        }
      } else {
        repoData = await fetchDashboardRest(octokit, cacheMode);
      }
      const fetchMs = performance.now() - fetchStart;

      // Review progress comes from the local DB. One grouped query for every PR on the
      // page, rather than one query per PR.
      const localStart = performance.now();
      const reviewCounts = countReviewedFilesBatch(
        userId,
        repoData.flatMap((repo) =>
          repo.pulls.map((pr) => ({
            owner: repo.owner,
            repo: repo.name,
            prNumber: pr.number,
            headSha: pr.headSha,
          }))
        )
      );

      const reposWithPRs = repoData.map((repo) => ({
        owner: repo.owner,
        name: repo.name,
        fullName: repo.fullName,
        pulls: repo.pulls.map((pr) => {
          const approvers = getApprovers(pr.reviews);
          return {
            number: pr.number,
            title: pr.title,
            author: pr.author,
            updatedAt: pr.updatedAt,
            draft: pr.draft,
            reviewedCount:
              reviewCounts.get(`${repo.owner}/${repo.name}#${pr.number}@${pr.headSha}`) ?? 0,
            totalFiles: pr.changedFiles,
            approved: approvers.includes(login),
            otherApprovers: approvers.filter((l) => l !== login),
          };
        }),
      }));
      const localMs = performance.now() - localStart;

      // Sort by most recently updated PR
      reposWithPRs.sort((a, b) => {
        const aDate = a.pulls[0]?.updatedAt || '';
        const bDate = b.pulls[0]?.updatedAt || '';
        return bDate.localeCompare(aDate);
      });

      const totalPRs = reposWithPRs.reduce((sum, r) => sum + r.pulls.length, 0);

      const cachedAt = getFetchedAt(dashboardCacheKey(login));
      const dataFetchedAt = (cachedAt ?? new Date()).toISOString();

      request.log.info(
        {
          dashboardMs: Math.round(performance.now() - perfStart),
          fetchMs: Math.round(fetchMs),
          localMs: Math.round(localMs),
          source,
          repoCount: reposWithPRs.length,
          totalPRs,
          refresh: cacheMode === 'bypass',
        },
        'dashboard performance breakdown'
      );

      return reply.view('dashboard', {
        title: 'Dashboard - Argus',
        user: request.user,
        reposWithPRs,
        totalPRs,
        dataFetchedAt,
      });
    } catch (err: any) {
      console.error('Error fetching dashboard:', err);

      if (err.status === 401) {
        return reply.status(401).view('error', {
          title: 'Authentication Error - Argus',
          user: request.user,
          message: 'GitHub token is invalid or expired. Please check your GITHUB_TOKEN environment variable.',
        });
      }

      return reply.view('error', {
        title: 'Error - Argus',
        user: request.user,
        message: 'Failed to load dashboard',
      });
    }
  });
}
