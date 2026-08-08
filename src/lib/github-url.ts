/**
 * Maps github.com's own URL shapes onto Argus routes.
 *
 * Argus can be run as a drop-in front end for github.com (see docs/github-proxy.md): a
 * hosts entry plus a local TLS terminator send github.com to Argus, and every path Argus
 * does not own is proxied on to the real site. That only works if the URLs the browser
 * already has resolve here — bookmarks, links in email, `gh pr view --web`, and the
 * github.com/owner/repo/pull/N that CI writes into every notification.
 *
 * The mapping is deliberately pure and total: it takes a path plus query and returns the
 * Argus URL to redirect to, or null when Argus has no equivalent (which, behind the proxy,
 * means the request should never have reached Argus in the first place).
 */

/** GitHub paths whose first segment is a site feature, not an account name. */
const RESERVED_OWNERS = new Set([
  'about',
  'account',
  'api',
  'apps',
  'assets',
  'codespaces',
  'collections',
  'contact',
  'dashboard',
  'enterprise',
  'enterprises',
  'events',
  'explore',
  'features',
  'issues',
  'join',
  'login',
  'logout',
  'marketplace',
  'new',
  'notifications',
  'organizations',
  'orgs',
  'pricing',
  'pulls',
  'search',
  'security',
  'session',
  'settings',
  'sessions',
  'signup',
  'sponsors',
  'static',
  'stars',
  'topics',
  'trending',
  'users',
]);

/**
 * Query parameters worth carrying across. GitHub and Argus happen to spell "ignore
 * whitespace" the same way; everything else on a GitHub URL (diff=split, file-filters,
 * short_path anchors) has no Argus counterpart and is dropped rather than passed through
 * as dead weight.
 */
const PRESERVED_QUERY_KEYS = ['w'];

export type QueryLike = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function buildQuery(pairs: Array<[string, string]>): string {
  if (pairs.length === 0) return '';
  const params = new URLSearchParams();
  for (const [key, value] of pairs) params.append(key, value);
  return `?${params.toString()}`;
}

function isValidSegment(segment: string | undefined): segment is string {
  return typeof segment === 'string' && segment.length > 0;
}

/**
 * The tab a GitHub pull-request sub-page corresponds to. GitHub's Files and Commits are
 * one Review tab in Argus, so both land in the same place.
 */
function tabForPullSubPage(subPage: string | undefined): string {
  switch (subPage) {
    case 'files':
    case 'commits':
      return 'review';
    case 'checks':
      return 'checks';
    default:
      // /pull/N, plus sub-pages Argus has no view for (conflicts, comments-only anchors).
      return 'conversation';
  }
}

/**
 * Translate a github.com path into the equivalent Argus path, or null if there is none.
 *
 * @param pathname URL path, without query string. Percent-encoding is preserved as given.
 * @param query    Parsed query string (Fastify's `request.query` shape).
 */
export function mapGitHubUrl(pathname: string, query: QueryLike = {}): string | null {
  const carried: Array<[string, string]> = [];
  for (const key of PRESERVED_QUERY_KEYS) {
    const value = firstValue(query[key]);
    if (value !== undefined) carried.push([key, value]);
  }

  const segments = pathname.split('/').filter((segment) => segment.length > 0);

  // github.com/ and github.com/pulls are both "the PRs I care about" — Argus's dashboard.
  if (segments.length === 0) return `/dashboard${buildQuery(carried)}`;
  if (segments.length === 1 && segments[0] === 'pulls') return `/dashboard${buildQuery(carried)}`;

  const [owner, repo, kind, ...rest] = segments;
  if (!isValidSegment(owner) || !isValidSegment(repo)) return null;
  if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;

  // github.com/owner/repo/pulls -> Argus's PR list for that repo. GitHub's ?q= search
  // syntax has no Argus equivalent, so the list renders with its own default filter.
  if (kind === 'pulls' && rest.length === 0) {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls${buildQuery(carried)}`;
  }

  if (kind !== 'pull') return null;

  const [number, subPage, subPageArg] = rest;
  if (!isValidSegment(number) || !/^\d+$/.test(number)) return null;

  const base = `/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`;

  // github.com/owner/repo/pull/N/commits/<sha> is a single commit's diff, which Argus
  // serves as its own page rather than a tab. The bare /commits list is the Review tab.
  if (subPage === 'commits' && isValidSegment(subPageArg)) {
    if (/^[0-9a-f]{7,40}$/i.test(subPageArg)) {
      return `${base}/commit/${subPageArg}${buildQuery(carried)}`;
    }
  }

  return `${base}${buildQuery([['tab', tabForPullSubPage(subPage)], ...carried])}`;
}
