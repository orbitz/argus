import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { mapGitHubUrl } from '../lib/github-url.js';

/**
 * Routes that accept github.com's own URLs and redirect to the Argus equivalent.
 *
 * These exist so Argus can stand in front of github.com (docs/github-proxy.md) without the
 * user having to learn a second set of URLs: an existing bookmark, a link from a review
 * request, or `gh pr view --web` all land on the Argus page for that PR.
 *
 * A redirect rather than an internal rewrite, so the address bar ends up showing the URL
 * that was actually served — otherwise every subsequent relative link and form POST on the
 * page would be resolved against a path Argus does not own.
 *
 * 302, not 301: the mapping is a product decision that may change, and a 301 would be
 * cached in browsers indefinitely.
 */
export async function githubCompatRoutes(fastify: FastifyInstance) {
  const redirect = (request: FastifyRequest, reply: FastifyReply) => {
    // request.url carries the query string; routeOptions gives the raw path only.
    const path = request.url.split('?')[0] ?? '/';
    const target = mapGitHubUrl(path, request.query as Record<string, string | string[] | undefined>);

    if (!target) {
      return reply.status(404).view('error', {
        title: 'Not Found - Argus',
        user: request.user,
        message: `Argus has no view for ${path}`,
      });
    }

    return reply.redirect(target);
  };

  // github.com/pulls — the "your pull requests" page.
  fastify.get('/pulls', redirect);

  // github.com/owner/repo/pulls
  fastify.get('/:owner/:repo/pulls', redirect);

  // github.com/owner/repo/pull/123 and its sub-pages (/files, /commits, /commits/<sha>,
  // /checks). The wildcard also absorbs sub-pages Argus has no view for, which land on the
  // conversation tab rather than 404ing.
  fastify.get('/:owner/:repo/pull/:number', redirect);
  fastify.get('/:owner/:repo/pull/:number/*', redirect);
}
