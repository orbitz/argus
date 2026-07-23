import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { createUserOctokit, fetchReviews, getApprovers } from '../lib/github.js';
import { buildStacks } from '../lib/stacks.js';
import { config } from '../config.js';

export async function repoRoutes(fastify: FastifyInstance) {
  // List accessible repos
  fastify.get('/repos', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(request, reply)) return;

    try {
      const octokit = createUserOctokit(request.user!.accessToken);

      // Fetch repos the user has access to
      const { data: repos } = await octokit.repos.listForAuthenticatedUser({
        sort: 'updated',
        per_page: 100,
      });

      return reply.view('repos', {
        title: 'Repositories - Argus',
        user: request.user,
        repos: repos.map((repo) => ({
          id: repo.id,
          fullName: repo.full_name,
          owner: repo.owner?.login || '',
          name: repo.name,
          private: repo.private,
          description: repo.description,
          updatedAt: repo.updated_at,
          openIssuesCount: repo.open_issues_count,
        })),
      });
    } catch (err: any) {
      console.error('Error fetching repos:', err);

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
        message: 'Failed to fetch repositories',
      });
    }
  });

  // List PRs for a repo
  fastify.get(
    '/repos/:owner/:repo/pulls',
    async (
      request: FastifyRequest<{
        Params: { owner: string; repo: string };
        Querystring: { state?: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo } = request.params;
      const state = (request.query.state || 'open') as 'open' | 'closed' | 'all';

      try {
        const octokit = createUserOctokit(request.user!.accessToken);

        const { data: pulls } = await octokit.pulls.list({
          owner,
          repo,
          state,
          sort: 'updated',
          direction: 'desc',
          per_page: 50,
        });

        const login = request.user!.login;

        // Approval state per PR. Failures (e.g. permissions) degrade to "not approved".
        const approvals = await Promise.all(
          pulls.map(async (pr) => {
            try {
              const approvers = getApprovers(await fetchReviews(octokit, owner, repo, pr.number));
              return {
                approved: approvers.includes(login),
                otherApprovers: approvers.filter((l) => l !== login),
              };
            } catch (err: any) {
              // Degrade to "not approved", but never silently — a swallowed failure
              // here is indistinguishable from a PR that genuinely has no approvals.
              console.error(`Failed to fetch reviews for PR #${pr.number}:`, err.status, err.message);
              return { approved: false, otherApprovers: [] as string[] };
            }
          })
        );

        const enrichedPulls = pulls.map((pr, i) => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: pr.draft,
          user: {
            login: pr.user?.login || 'unknown',
            avatarUrl: pr.user?.avatar_url || '',
          },
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          headRef: pr.head.ref,
          baseRef: pr.base.ref,
          // Only same-repo PRs participate in stack linking (see buildStacks). A null
          // head.repo (deleted branch) or a fork resolves to false.
          sameRepo: pr.head.repo?.full_name === pr.base.repo?.full_name,
          approved: approvals[i].approved,
          otherApprovers: approvals[i].otherApprovers,
        }));

        // Group into stacks (chains/trees linked by base<-head branch) + standalone PRs.
        const { stacks, standalone } = buildStacks(enrichedPulls);

        return reply.view('pulls', {
          title: `Pull Requests - ${owner}/${repo} - Argus`,
          user: request.user,
          owner,
          repo,
          state,
          stacks,
          standalone,
        });
      } catch (err: any) {
        console.error('Error fetching PRs:', err);

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
          message: `Failed to fetch pull requests for ${owner}/${repo}`,
        });
      }
    }
  );
}
