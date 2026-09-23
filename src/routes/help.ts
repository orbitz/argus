import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { mapGitHubUrl } from '../lib/github-url.js';
import { bookmarkletUrl } from '../lib/bookmarklet.js';
import { config } from '../config.js';

/** An origin the bookmarklet string can carry safely, or null. See assertOrigin(). */
const ORIGIN_PATTERN = /^https?:\/\/(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(:\d+)?$/;

/**
 * `raw` as an origin, or null when it cannot hold one.
 *
 * The Host and X-Forwarded-Host headers are client input, and the origin is pasted into a
 * javascript: URL on the help page. Only the characters a URL host may hold pass, so a
 * crafted header cannot close that string early and run its own code.
 */
function assertOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!ORIGIN_PATTERN.test(url.origin)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The help screen and the bookmarklet click target.
 *
 * `/help` shows the bookmarklet to install. `/bookmarklet` is where that bookmarklet
 * points: it maps the URL it is given and redirects to the Argus view, so a bookmark and
 * a github.com URL always open the same page.
 */
export async function helpRoutes(fastify: FastifyInstance) {
  /**
   * The address the browser used for this request: scheme, host and port.
   *
   * Behind the github.com proxy, nginx adds X-Forwarded-Proto and X-Forwarded-Host,
   * because the request then arrives as plain http on 127.0.0.1:3000 while the browser is
   * on https://github.com. The bookmarklet has to name the browser's address, or it would
   * send the next click to a host the user does not have.
   */
  const requestOrigin = (request: FastifyRequest): string => {
    const first = (value: string | string[] | undefined): string | undefined =>
      (Array.isArray(value) ? value[0] : value) || undefined;

    const scheme = first(request.headers['x-forwarded-proto']) || request.protocol;
    const host = first(request.headers['x-forwarded-host']) || request.headers.host;
    const forwarded = host ? assertOrigin(`${scheme}://${host}`) : null;
    return forwarded || assertOrigin(config.baseUrl) || 'http://localhost:3000';
  };

  fastify.get('/help', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireAuth(request, reply)) return;

    return reply.view('help', {
      title: 'Help - Argus',
      user: request.user,
      bookmarklet: bookmarkletUrl(requestOrigin(request)),
    });
  });

  // Click target of the bookmarklet. `url` is the page it was clicked on: a full URL, or
  // a bare path, which the base below accepts for free.
  fastify.get('/bookmarklet', async (request: FastifyRequest, reply: FastifyReply) => {
    const { url } = request.query as { url?: string };
    if (!url) return reply.redirect('/help');

    let parsed: URL;
    try {
      parsed = new URL(url, 'https://github.com');
    } catch {
      return reply.status(404).view('error', {
        title: 'Not Found - Argus',
        user: request.user,
        message: 'The bookmarklet could not read this page address.',
      });
    }

    const query: Record<string, string | string[] | undefined> = {};
    parsed.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    const target = mapGitHubUrl(parsed.pathname, query);
    if (target) return reply.redirect(target);

    // An Argus address has no github.com mapping, such as the PR page you are already on.
    // Send it back to itself, so a second click changes nothing.
    if (parsed.origin === requestOrigin(request)) {
      return reply.redirect(parsed.pathname + parsed.search);
    }

    return reply.status(404).view('error', {
      title: 'Not Found - Argus',
      user: request.user,
      message: `Argus has no view for ${parsed.pathname}`,
    });
  });
}
