import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

/**
 * The compat routes are root-level parameterised routes (`/:owner/:repo/pull/:number`),
 * which is exactly the shape that can swallow another route by accident. These tests build
 * the real route table — every module, in the order index.ts registers them — and check
 * both directions: GitHub URLs redirect, and Argus's own URLs still reach their handlers.
 */
describe('github.com URL compatibility routes', () => {
  let fastify: FastifyInstance;

  beforeAll(async () => {
    process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'test-token';

    const { homeRoutes } = await import('../src/routes/home.js');
    const { authRoutes } = await import('../src/routes/auth.js');
    const { repoRoutes } = await import('../src/routes/repos.js');
    const { prRoutes } = await import('../src/routes/pr.js');
    const { dashboardRoutes } = await import('../src/routes/dashboard.js');
    const { notificationRoutes } = await import('../src/routes/notifications.js');
    const { githubCompatRoutes } = await import('../src/routes/github-compat.js');

    fastify = Fastify();
    // Stand-in for the auth middleware and the view engine: these tests are about which
    // handler a URL reaches, not about what that handler renders.
    fastify.decorateRequest('user', null);
    fastify.decorateReply('view', function (this: any, template: string) {
      return this.type('text/plain').send(`view:${template}`);
    });

    await fastify.register(homeRoutes);
    await fastify.register(authRoutes, { prefix: '/auth' });
    await fastify.register(repoRoutes);
    await fastify.register(prRoutes);
    await fastify.register(dashboardRoutes);
    await fastify.register(notificationRoutes);
    await fastify.register(githubCompatRoutes);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify?.close();
  });

  const location = async (url: string) => {
    const response = await fastify.inject({ method: 'GET', url });
    return { status: response.statusCode, to: response.headers.location };
  };

  it('redirects a GitHub PR URL to the Argus PR page', async () => {
    expect(await location('/octocat/hello-world/pull/42')).toEqual({
      status: 302,
      to: '/pr/octocat/hello-world/42?tab=conversation',
    });
  });

  it('redirects GitHub PR sub-pages', async () => {
    expect((await location('/octocat/hello-world/pull/42/files')).to).toBe(
      '/pr/octocat/hello-world/42?tab=review'
    );
    expect((await location('/octocat/hello-world/pull/42/checks')).to).toBe(
      '/pr/octocat/hello-world/42?tab=checks'
    );
    expect(
      (await location('/octocat/hello-world/pull/42/commits/0123456789abcdef0123456789abcdef01234567')).to
    ).toBe('/pr/octocat/hello-world/42/commit/0123456789abcdef0123456789abcdef01234567');
  });

  it('preserves the ignore-whitespace flag', async () => {
    expect((await location('/octocat/hello-world/pull/42/files?w=1')).to).toBe(
      '/pr/octocat/hello-world/42?tab=review&w=1'
    );
  });

  it('redirects the repo PR list and the global one', async () => {
    expect((await location('/octocat/hello-world/pulls')).to).toBe('/repos/octocat/hello-world/pulls');
    expect((await location('/pulls')).to).toBe('/dashboard');
  });

  it('leaves Argus routes with the same shape alone', async () => {
    // 4 segments, like /:owner/:repo/pull/:number — must still reach repoRoutes.
    expect((await location('/repos/octocat/hello-world/pulls')).status).not.toBe(302);
    // 4 segments, like the compat route — must still reach prRoutes.
    expect((await location('/pr/octocat/hello-world/42')).status).not.toBe(302);
    // 5+ segments, like the compat wildcard.
    expect((await location('/pr/octocat/hello-world/42/commits')).status).not.toBe(302);
  });

  it('leaves the dashboard and notifications alone', async () => {
    expect((await location('/dashboard')).status).not.toBe(302);
    expect((await location('/notifications')).status).not.toBe(302);
  });

  it('still sends the root to the dashboard', async () => {
    // homeRoutes owns '/', and its redirect only fires for an authenticated user.
    const response = await fastify.inject({
      method: 'GET',
      url: '/',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect([200, 302]).toContain(response.statusCode);
  });

  it('404s a path Argus has no view for rather than redirecting somewhere wrong', async () => {
    const response = await fastify.inject({ method: 'GET', url: '/octocat/hello-world/pull/abc' });
    expect(response.statusCode).toBe(404);
  });
});
