import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { performance } from 'node:perf_hooks';
import { requireAuth } from '../middleware/auth.js';
import { createUserOctokit, fetchPR, fetchReviews, getApprovers } from '../lib/github.js';
import { countReviewedFilesAtHead } from '../lib/file-reviews.js';

// Bound how many PRs are enriched concurrently. The dashboard enriches every open PR across
// many repos (each enrich = a files + reviews fetch); firing them all at once bursts past
// GitHub's secondary rate limit and saturates the socket pool. A small cap keeps it fast.
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

export async function dashboardRoutes(fastify: FastifyInstance) {
  // Dashboard - show open PRs grouped by repo
  fastify.get('/dashboard', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(request, reply)) return;

    try {
      const octokit = createUserOctokit(request.user!.accessToken);

      // --- Performance instrumentation (dashboard was observed taking ~100s) ---
      const perfStart = performance.now();
      const enrichTimings: Array<{ pr: string; ms: number; files: number; reviews: number }> = [];
      const repoTimings: Array<{ repo: string; pullsMs: number; prCount: number; enrichMs: number }> = [];

      // Fetch repos with recent activity
      const reposStart = performance.now();
      const { data: repos } = await octokit.repos.listForAuthenticatedUser({
        sort: 'pushed',
        per_page: 30,
      });
      const reposListMs = performance.now() - reposStart;

      // Fetch open PRs for each repo (in parallel, limited)
      const reposWithPRs: Array<{
        owner: string;
        name: string;
        fullName: string;
        pulls: Array<{
          number: number;
          title: string;
          author: string;
          updatedAt: string;
          draft: boolean;
          reviewedCount: number;
          totalFiles: number;
          approved: boolean;
          otherApprovers: string[];
        }>;
      }> = [];

      const userId = request.user!.githubUserId;
      const login = request.user!.login;

      // Enrich a single PR with review progress + approval state.
      // Failures (e.g. permissions) degrade gracefully to zero/false.
      //
      // Deliberately does NOT list the PR's files: a large PR (e.g. 3000 files) makes
      // fetchPRFiles paginate dozens of multi-MB pages and dominates the whole dashboard.
      // Instead totalFiles comes from the PR's changed_files count (one small cached call)
      // and reviewedCount from the local DB at the current head (no network).
      const enrichPull = async (owner: string, repo: string, prNumber: number, headSha: string) => {
        const enrichStart = performance.now();
        try {
          const [pr, reviews] = await Promise.all([
            fetchPR(octokit, owner, repo, prNumber),
            fetchReviews(octokit, owner, repo, prNumber),
          ]);
          const totalFiles = pr.changed_files ?? 0;
          enrichTimings.push({
            pr: `${owner}/${repo}#${prNumber}`,
            ms: performance.now() - enrichStart,
            files: totalFiles,
            reviews: reviews.length,
          });

          const reviewedCount = countReviewedFilesAtHead(userId, owner, repo, prNumber, headSha);
          const approvers = getApprovers(reviews);

          return {
            reviewedCount,
            totalFiles,
            approved: approvers.includes(login),
            otherApprovers: approvers.filter((l) => l !== login),
          };
        } catch {
          return { reviewedCount: 0, totalFiles: 0, approved: false, otherApprovers: [] };
        }
      };

      // Shared across all repos so total in-flight enrichment stays bounded (not per-repo).
      const limit = createLimiter(ENRICH_CONCURRENCY);

      // Fetch PRs for top repos (limit to avoid rate limits)
      const prPromises = repos.slice(0, 15).map(async (repo) => {
        const repoLabel = `${repo.owner?.login || ''}/${repo.name}`;
        try {
          const pullsStart = performance.now();
          const { data: pulls } = await octokit.pulls.list({
            owner: repo.owner?.login || '',
            repo: repo.name,
            state: 'open',
            sort: 'updated',
            direction: 'desc',
            per_page: 10,
          });
          const pullsMs = performance.now() - pullsStart;

          if (pulls.length > 0) {
            const owner = repo.owner?.login || '';
            const enrichStart = performance.now();
            const enriched = await Promise.all(
              pulls.map(async (pr) => ({
                number: pr.number,
                title: pr.title,
                author: pr.user?.login || 'unknown',
                updatedAt: pr.updated_at,
                draft: pr.draft || false,
                ...(await limit(() => enrichPull(owner, repo.name, pr.number, pr.head?.sha || ''))),
              }))
            );
            repoTimings.push({ repo: repoLabel, pullsMs, prCount: pulls.length, enrichMs: performance.now() - enrichStart });

            return {
              owner,
              name: repo.name,
              fullName: repo.full_name,
              pulls: enriched,
            };
          }
          repoTimings.push({ repo: repoLabel, pullsMs, prCount: 0, enrichMs: 0 });
          return null;
        } catch {
          return null;
        }
      });

      const results = await Promise.all(prPromises);
      for (const result of results) {
        if (result) {
          reposWithPRs.push(result);
        }
      }

      // Sort by most recently updated PR
      reposWithPRs.sort((a, b) => {
        const aDate = a.pulls[0]?.updatedAt || '';
        const bDate = b.pulls[0]?.updatedAt || '';
        return bDate.localeCompare(aDate);
      });

      // Count total PRs
      const totalPRs = reposWithPRs.reduce((sum, r) => sum + r.pulls.length, 0);

      // Emit a performance breakdown so a slow dashboard can be diagnosed from the logs.
      // Compares wall-clock to the summed per-PR enrich cost, flags the slowest PRs/repos,
      // and surfaces the biggest file-list pagination (the most likely culprit).
      const enrichSorted = [...enrichTimings].sort((a, b) => b.ms - a.ms);
      const enrichSumMs = enrichTimings.reduce((s, e) => s + e.ms, 0);
      const maxFiles = enrichTimings.reduce((m, e) => Math.max(m, e.files), 0);
      request.log.info(
        {
          dashboardMs: Math.round(performance.now() - perfStart),
          reposListMs: Math.round(reposListMs),
          repoCount: repos.length,
          reposProcessed: Math.min(repos.length, 15),
          prsEnriched: enrichTimings.length,
          enrichSumMs: Math.round(enrichSumMs), // total API time across all PRs (parallel, so >> wall-clock is expected)
          enrichSlowestMs: Math.round(enrichSorted[0]?.ms ?? 0),
          maxFilesInAnyPR: maxFiles,
          slowestPRs: enrichSorted.slice(0, 8).map((e) => ({ pr: e.pr, ms: Math.round(e.ms), files: e.files, reviews: e.reviews })),
          slowestRepos: [...repoTimings]
            .sort((a, b) => b.pullsMs + b.enrichMs - (a.pullsMs + a.enrichMs))
            .slice(0, 8)
            .map((r) => ({ repo: r.repo, pullsMs: Math.round(r.pullsMs), enrichMs: Math.round(r.enrichMs), prs: r.prCount })),
        },
        'dashboard performance breakdown'
      );

      return reply.view('dashboard', {
        title: 'Dashboard - Argus',
        user: request.user,
        reposWithPRs,
        totalPRs,
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
