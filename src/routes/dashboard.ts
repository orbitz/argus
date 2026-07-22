import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { createUserOctokit, fetchPRFiles, fetchReviews, getApprovers } from '../lib/github.js';
import { getReviewedFiles } from '../lib/file-reviews.js';

export async function dashboardRoutes(fastify: FastifyInstance) {
  // Dashboard - show open PRs grouped by repo
  fastify.get('/dashboard', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(request, reply)) return;

    try {
      const octokit = createUserOctokit(request.user!.accessToken);

      // Fetch repos with recent activity
      const { data: repos } = await octokit.repos.listForAuthenticatedUser({
        sort: 'pushed',
        per_page: 30,
      });

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
      const enrichPull = async (owner: string, repo: string, prNumber: number) => {
        try {
          const [files, reviews] = await Promise.all([
            fetchPRFiles(octokit, owner, repo, prNumber),
            fetchReviews(octokit, owner, repo, prNumber),
          ]);

          const fileShaMap = new Map<string, string>();
          for (const file of files) {
            if (file.sha) fileShaMap.set(file.filename, file.sha);
          }

          const reviewedCount = getReviewedFiles(userId, owner, repo, prNumber, fileShaMap).length;

          const approvers = getApprovers(reviews);

          return {
            reviewedCount,
            totalFiles: files.length,
            approved: approvers.includes(login),
            otherApprovers: approvers.filter((l) => l !== login),
          };
        } catch {
          return { reviewedCount: 0, totalFiles: 0, approved: false, otherApprovers: [] };
        }
      };

      // Fetch PRs for top repos (limit to avoid rate limits)
      const prPromises = repos.slice(0, 15).map(async (repo) => {
        try {
          const { data: pulls } = await octokit.pulls.list({
            owner: repo.owner?.login || '',
            repo: repo.name,
            state: 'open',
            sort: 'updated',
            direction: 'desc',
            per_page: 10,
          });

          if (pulls.length > 0) {
            const owner = repo.owner?.login || '';
            const enriched = await Promise.all(
              pulls.map(async (pr) => ({
                number: pr.number,
                title: pr.title,
                author: pr.user?.login || 'unknown',
                updatedAt: pr.updated_at,
                draft: pr.draft || false,
                ...(await enrichPull(owner, repo.name, pr.number)),
              }))
            );

            return {
              owner,
              name: repo.name,
              fullName: repo.full_name,
              pulls: enriched,
            };
          }
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
