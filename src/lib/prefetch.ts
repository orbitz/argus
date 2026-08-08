/**
 * Background cache warming.
 *
 * The cache layer makes a warm page render without touching the network, but only if
 * something has already populated it. This job keeps the dashboard and the PRs you are
 * most likely to open warm, so clicking through is instant rather than paying a cold
 * fetch on first visit.
 *
 * Cost control rests on one observation: a PR whose `updatedAt` has not moved since we
 * last cached it cannot have changed, so it is skipped entirely. In steady state a pass
 * therefore costs one GraphQL query plus a handful of requests for genuinely changed PRs.
 */

import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { getTokenUser } from '../middleware/auth.js';
import {
  getOctokit,
  fetchPRFiles,
  fetchIssueComments,
  fetchReviewComments,
  fetchPRCommits,
  fetchPRTimeline,
  fetchReviews,
  fetchPR,
  prKey,
} from './github.js';
import {
  fetchDashboardOverview,
  overviewCacheKey,
  type OverviewPull,
} from './dashboard-overview.js';
import { getFetchedAt } from './api-cache.js';
import { query } from '../db/index.js';

interface WarmTarget {
  owner: string;
  repo: string;
  pr: OverviewPull;
}

/** Last `updatedAt` we successfully warmed, per PR. Cheap unchanged-check without a fetch. */
function lastWarmedAt(owner: string, repo: string, prNumber: number): string | null {
  const { rows } = query<{ data: string }>(
    `SELECT data FROM api_cache WHERE cache_key = ?`,
    [prKey(owner, repo, prNumber)]
  );
  if (rows.length === 0) return null;
  try {
    return (JSON.parse(rows[0].data) as { updated_at?: string }).updated_at ?? null;
  } catch {
    return null;
  }
}

async function warmPR(owner: string, repo: string, prNumber: number): Promise<void> {
  const octokit = getOctokit();
  // Everything the PR page's parallel batch needs. Checks and combined status are
  // deliberately excluded: they have a 20s TTL and would be stale by the time you click.
  await Promise.all([
    fetchPR(octokit, owner, repo, prNumber),
    fetchPRFiles(octokit, owner, repo, prNumber),
    fetchIssueComments(octokit, owner, repo, prNumber),
    fetchReviewComments(octokit, owner, repo, prNumber),
    fetchReviews(octokit, owner, repo, prNumber),
    fetchPRCommits(octokit, owner, repo, prNumber),
    fetchPRTimeline(octokit, owner, repo, prNumber),
  ]);
}

async function runPass(log: FastifyBaseLogger): Promise<void> {
  const user = getTokenUser();
  if (!user) return;

  const started = Date.now();
  const octokit = getOctokit();

  // Warms the dashboard's own cache entry as a side effect, which is what makes the
  // dashboard render from SQLite instead of paying ~6s of GitHub search on first visit.
  const overview = await fetchDashboardOverview(octokit, user.login);

  // Warm what the dashboard actually shows, in the order you are likely to open it:
  // PRs from people that are blocked on your review, then your own PRs that a reviewer
  // has responded to, then the rest. Bot PRs come last — they are numerous, and a
  // dependency bump is rarely what you open first.
  const ordered: OverviewPull[] = [
    ...overview.waiting.humans,
    ...overview.mine.changesRequested.items,
    ...overview.mine.approved.items,
    ...overview.mine.awaiting.items,
    ...overview.waiting.bots,
  ];

  // The same PR can appear in more than one section; warming it twice is wasted work.
  const seen = new Set<string>();
  const candidates: WarmTarget[] = [];
  for (const pr of ordered) {
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;
    if (seen.has(key) || !pr.owner || !pr.repo) continue;
    seen.add(key);
    candidates.push({ owner: pr.owner, repo: pr.repo, pr });
  }

  const stale = candidates.filter((c) => {
    const warmed = lastWarmedAt(c.owner, c.repo, c.pr.number);
    if (warmed === null) return true; // never cached
    return warmed !== c.pr.updatedAt; // changed since we last warmed it
  });

  const targets = stale.slice(0, config.prefetch.maxPRsPerPass);
  const skippedForCap = stale.length - targets.length;

  let warmed = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i += config.prefetch.concurrency) {
    const batch = targets.slice(i, i + config.prefetch.concurrency);
    await Promise.all(
      batch.map(async (t) => {
        try {
          await warmPR(t.owner, t.repo, t.pr.number);
          warmed++;
        } catch (err) {
          failed++;
          log.debug({ err, pr: `${t.owner}/${t.repo}#${t.pr.number}` }, 'prefetch warm failed');
        }
      })
    );
  }

  log.info(
    {
      ms: Date.now() - started,
      waiting: overview.waiting.total,
      candidates: candidates.length,
      warmed,
      failed,
      unchangedSkipped: candidates.length - stale.length,
      skippedForCap,
      dashboardCachedAt: getFetchedAt(overviewCacheKey(user.login))?.toISOString() ?? null,
    },
    'prefetch pass complete'
  );
}

let timer: NodeJS.Timeout | null = null;

export function startPrefetch(log: FastifyBaseLogger): void {
  if (!config.prefetch.enabled) {
    log.info('prefetch disabled');
    return;
  }

  let running = false;
  const tick = async () => {
    if (running) return; // a slow pass must not overlap the next tick
    running = true;
    try {
      await runPass(log);
    } catch (err) {
      log.warn({ err }, 'prefetch pass failed');
    } finally {
      running = false;
    }
  };

  void tick();
  // unref so a pending timer never keeps the process alive during shutdown.
  timer = setInterval(tick, config.prefetch.intervalMs);
  timer.unref();
}

export function stopPrefetch(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
