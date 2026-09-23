import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyView from '@fastify/view';
import ejs from 'ejs';
import { JSDOM } from 'jsdom';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The bookmarklet crosses three hands: the help page renders it, the browser runs it, and
 * /bookmarklet maps what it sends. These tests pull the real string out of the rendered
 * page, execute it against a stub `location`, and feed the result back through the route
 * table — the same one the github.com compatibility routes sit in. A bookmarklet and a
 * github.com URL therefore cannot open different pages for the same address.
 */

const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'templates');

describe('bookmarklet', () => {
  let fastify: FastifyInstance;

  beforeAll(async () => {
    // Set before the routes load src/config.ts, so the rendered origin is a known value.
    process.env.BASE_URL = 'http://localhost:3000';
    process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'test-token';

    const { helpRoutes } = await import('../src/routes/help.js');
    const { githubCompatRoutes } = await import('../src/routes/github-compat.js');

    fastify = Fastify();
    await fastify.register(fastifyView, {
      engine: { ejs },
      root: TEMPLATES,
      defaultContext: { baseUrl: 'http://localhost:3000' },
    });

    // The stand-in for authMiddleware, which normally sets the token user.
    fastify.decorateRequest('user', null);
    fastify.addHook('preHandler', async (request) => {
      (request as any).user = {
        id: 'token-user',
        githubUserId: 1,
        login: 'octocat',
        avatarUrl: null,
        accessToken: 'test-token',
      };
    });

    await fastify.register(helpRoutes);
    await fastify.register(githubCompatRoutes);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify?.close();
  });

  /** The help page, rendered for a browser at `headers`. */
  const helpPage = async (headers: Record<string, string> = {}) => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/help',
      headers: { host: 'localhost:3000', ...headers },
    });
    expect(response.statusCode).toBe(200);
    return response.body;
  };

  /** The bookmarklet, read from the link the page offers. */
  const bookmarkletIn = (html: string): string => {
    const link = new JSDOM(html).window.document.querySelector('.bookmarklet-link');
    expect(link).not.toBeNull();
    return (link as HTMLAnchorElement).getAttribute('href') as string;
  };

  /** Runs the bookmarklet the way a browser would, against a stub `location`. */
  const click = (bookmarklet: string, pageUrl: string): string => {
    expect(bookmarklet.startsWith('javascript:')).toBe(true);
    const page: { href: string } = { href: pageUrl };
    new Function('location', bookmarklet.slice('javascript:'.length))(page);
    return page.href;
  };

  /** The help page's bookmarklet, clicked while the browser is on `pageUrl`. */
  const clicked = async (pageUrl: string, headers?: Record<string, string>): Promise<string> => {
    return click(bookmarkletIn(await helpPage(headers)), pageUrl);
  };

  /** Where the browser ends up after the bookmarklet click. */
  const openedFrom = async (pageUrl: string, headers?: Record<string, string>) => {
    const target = new URL(await clicked(pageUrl, headers));
    return fastify.inject({
      method: 'GET',
      url: target.pathname + target.search,
      headers: { host: 'localhost:3000' },
    });
  };

  it('renders a bookmarklet for the address the browser used', async () => {
    expect(bookmarkletIn(await helpPage())).toBe(
      "javascript:location.href='http://localhost:3000/bookmarklet?url='+encodeURIComponent(location.href)"
    );
  });

  it('offers the same address in a field to copy', async () => {
    const html = await helpPage();
    const field = new JSDOM(html).window.document.querySelector('#bookmarklet-address');
    expect((field as HTMLTextAreaElement).value).toBe(bookmarkletIn(html));
  });

  it('names the proxied address when nginx sends X-Forwarded headers', async () => {
    const html = await helpPage({
      host: '127.0.0.1:3000',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'github.com',
    });
    expect(bookmarkletIn(html)).toContain("'https://github.com/bookmarklet?url='");
  });

  it('drops a forwarded host that cannot be part of an origin', async () => {
    const href = bookmarkletIn(await helpPage({ 'x-forwarded-host': "evil.com'+alert(1)+'" }));
    expect(href).not.toContain('alert');
    expect(href).toMatch(
      /^javascript:location\.href='[^']*\/bookmarklet\?url='\+encodeURIComponent\(location\.href\)$/
    );
  });

  it('opens a pull request at its Conversation tab', async () => {
    const response = await openedFrom('https://github.com/octocat/hello-world/pull/42');
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/pr/octocat/hello-world/42?tab=conversation');
  });

  it('opens a files sub-page at the Review tab', async () => {
    const response = await openedFrom('https://github.com/octocat/hello-world/pull/42/files');
    expect(response.headers.location).toBe('/pr/octocat/hello-world/42?tab=review');
  });

  it('opens a single commit', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const response = await openedFrom(
      `https://github.com/octocat/hello-world/pull/42/commits/${sha}`
    );
    expect(response.headers.location).toBe(`/pr/octocat/hello-world/42/commit/${sha}`);
  });

  it('opens the repo PR list and the global one', async () => {
    expect((await openedFrom('https://github.com/octocat/hello-world/pulls')).headers.location).toBe(
      '/repos/octocat/hello-world/pulls'
    );
    expect((await openedFrom('https://github.com/pulls')).headers.location).toBe('/dashboard');
  });

  it('keeps the ignore-whitespace flag and drops the proxy escape hatch', async () => {
    expect(
      (await openedFrom('https://github.com/octocat/hello-world/pull/42?w=1&argus=0')).headers
        .location
    ).toBe('/pr/octocat/hello-world/42?tab=conversation&w=1');
  });

  it('reports an address Argus has no view for', async () => {
    const response = await openedFrom('https://github.com/octocat/hello-world/issues/7');
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('Argus has no view for /octocat/hello-world/issues/7');
  });

  it('leaves an Argus page alone when clicked there', async () => {
    const response = await openedFrom('http://localhost:3000/pr/octocat/hello-world/42');
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/pr/octocat/hello-world/42');
  });

  it('sends a bare click on the endpoint to the help screen', async () => {
    const response = await fastify.inject({ method: 'GET', url: '/bookmarklet' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/help');
  });
});
