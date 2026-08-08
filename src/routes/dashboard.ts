import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { performance } from 'node:perf_hooks';
import { requireAuth } from '../middleware/auth.js';
import { createUserOctokit } from '../lib/github.js';
import {
  fetchDashboardOverview,
  overviewCacheKey,
  unbucketedMineCount,
  type OverviewPull,
} from '../lib/dashboard-overview.js';
import { countReviewedFilesBatch } from '../lib/file-reviews.js';
import { getFetchedAt, type CacheMode } from '../lib/api-cache.js';

/**
 * The dashboard answers three questions, in the order they usually matter:
 *
 *   1. What is blocked on me? (my review is requested, directly or through a team)
 *   2. What is blocked on someone else? (my PRs, and what reviewers have said)
 *   3. Where was I mentioned?
 *
 * It used to list open PRs grouped by recently-pushed repository, which answered none of
 * them: your own PRs and everyone else's sat in the same list, and a review request in a
 * repo that had not been pushed to recently did not appear at all.
 */

const TABS = ['waiting', 'mine', 'mentions'] as const;
type Tab = (typeof TABS)[number];

/** Attaches local per-file review progress, which lives in SQLite rather than at GitHub. */
function withReviewProgress(
  userId: number,
  pulls: OverviewPull[]
): Array<OverviewPull & { reviewedFiles: number }> {
  if (pulls.length === 0) return [];

  const counts = countReviewedFilesBatch(
    userId,
    pulls.map((pr) => ({
      owner: pr.owner,
      repo: pr.repo,
      prNumber: pr.number,
      headSha: pr.headSha,
    }))
  );

  return pulls.map((pr) => ({
    ...pr,
    reviewedFiles: counts.get(`${pr.owner}/${pr.repo}#${pr.number}@${pr.headSha}`) ?? 0,
  }));
}

export async function dashboardRoutes(fastify: FastifyInstance) {
  fastify.get('/dashboard', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(request, reply)) return;

    try {
      const octokit = createUserOctokit(request.user!.accessToken);
      const userId = request.user!.githubUserId;
      const login = request.user!.login;

      const perfStart = performance.now();
      const cacheMode: CacheMode =
        (request.query as { refresh?: string }).refresh === '1' ? 'bypass' : 'normal';

      // All three tabs render server-side and switch client-side, so ?tab= only decides
      // which one starts visible — deep links and a reload after switching land right.
      const rawTab = (request.query as { tab?: string }).tab;
      const activeTab = TABS.includes(rawTab as Tab) ? (rawTab as Tab) : 'waiting';

      const fetchStart = performance.now();
      const overview = await fetchDashboardOverview(octokit, login, cacheMode);
      const fetchMs = performance.now() - fetchStart;

      const localStart = performance.now();
      const waiting = {
        total: overview.waiting.total,
        humans: withReviewProgress(userId, overview.waiting.humans),
        bots: withReviewProgress(userId, overview.waiting.bots),
      };
      const localMs = performance.now() - localStart;

      const cachedAt = getFetchedAt(overviewCacheKey(login));
      const dataFetchedAt = (cachedAt ?? new Date()).toISOString();

      request.log.info(
        {
          dashboardMs: Math.round(performance.now() - perfStart),
          fetchMs: Math.round(fetchMs),
          localMs: Math.round(localMs),
          waiting: overview.waiting.total,
          mine: overview.mine.total,
          mentions: overview.mentions.total,
          tab: activeTab,
          refresh: cacheMode === 'bypass',
        },
        'dashboard performance breakdown'
      );

      return reply.view('dashboard', {
        title: 'Dashboard - Argus',
        user: request.user,
        activeTab,
        waiting,
        mine: overview.mine,
        mentions: overview.mentions,
        unbucketedMine: unbucketedMineCount(overview.mine),
        dataFetchedAt,
      });
    } catch (err: any) {
      console.error('Error fetching dashboard:', err);

      if (err.status === 401) {
        return reply.status(401).view('error', {
          title: 'Authentication Error - Argus',
          user: request.user,
          message:
            'GitHub token is invalid or expired. Please check your GITHUB_TOKEN environment variable.',
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
