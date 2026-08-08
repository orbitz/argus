import { describe, it, expect } from 'vitest';
import {
  toOverviewPull,
  unbucketedMineCount,
  myTeamSlugs,
  reviewRequestReason,
} from '../src/lib/dashboard-overview.js';

/** A search node shaped like the ones GitHub's GraphQL API actually returns. */
function node(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Fix the thing',
    isDraft: false,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
    changedFiles: 3,
    additions: 10,
    deletions: 2,
    reviewDecision: 'REVIEW_REQUIRED',
    headRefOid: 'abc123',
    author: { __typename: 'User', login: 'octocat' },
    repository: { nameWithOwner: 'octocat/hello-world' },
    reviews: { totalCount: 1 },
    comments: { totalCount: 4 },
    ...overrides,
  };
}

describe('toOverviewPull', () => {
  it('splits the repository into owner and name', () => {
    const pull = toOverviewPull(node())!;
    expect(pull.owner).toBe('octocat');
    expect(pull.repo).toBe('hello-world');
    expect(pull.fullName).toBe('octocat/hello-world');
  });

  it('carries the fields the dashboard renders', () => {
    const pull = toOverviewPull(node())!;
    expect(pull).toMatchObject({
      number: 42,
      title: 'Fix the thing',
      authorLogin: 'octocat',
      authorIsBot: false,
      draft: false,
      changedFiles: 3,
      additions: 10,
      deletions: 2,
      reviewCount: 1,
      commentCount: 4,
      reviewDecision: 'REVIEW_REQUIRED',
      headSha: 'abc123',
    });
  });

  it('identifies bot authors by actor type, not by login', () => {
    // dependabot's search payload has a plain "dependabot" login with no [bot] suffix,
    // so a name-based check would classify it as a person.
    const bot = toOverviewPull(node({ author: { __typename: 'Bot', login: 'dependabot' } }))!;
    expect(bot.authorIsBot).toBe(true);

    const human = toOverviewPull(node({ author: { __typename: 'User', login: 'dependabot-fan' } }))!;
    expect(human.authorIsBot).toBe(false);
  });

  it('survives a deleted author', () => {
    const pull = toOverviewPull(node({ author: null }))!;
    expect(pull.authorLogin).toBe('ghost');
    expect(pull.authorIsBot).toBe(false);
  });

  it('returns null for a node that is not a pull request', () => {
    // Search returns a union; an Issue node comes back with none of the PR fields.
    expect(toOverviewPull({})).toBeNull();
    expect(toOverviewPull(null)).toBeNull();
  });

  it('defaults missing counts to zero rather than undefined', () => {
    const pull = toOverviewPull({
      number: 1,
      repository: { nameWithOwner: 'a/b' },
      author: { __typename: 'User', login: 'x' },
    })!;
    expect(pull.changedFiles).toBe(0);
    expect(pull.reviewCount).toBe(0);
    expect(pull.reviewDecision).toBeNull();
  });
});

describe('unbucketedMineCount', () => {
  const mine = (total: number, changes: number, approved: number, awaiting: number) => ({
    total,
    changesRequested: { total: changes, items: [] },
    approved: { total: approved, items: [] },
    awaiting: { total: awaiting, items: [] },
  });

  it('is zero when the buckets account for every PR', () => {
    expect(unbucketedMineCount(mine(172, 1, 4, 167))).toBe(0);
  });

  it('reports PRs that fall outside all three review states', () => {
    // A PR whose only reviews are comments matches none of search's review: values.
    expect(unbucketedMineCount(mine(10, 1, 2, 5))).toBe(2);
  });

  it('never goes negative if the counts disagree', () => {
    // The bucket queries and the total run as separate searches, so a PR that changes
    // state between them can make the parts exceed the whole.
    expect(unbucketedMineCount(mine(5, 2, 2, 2))).toBe(0);
  });
});

describe('myTeamSlugs', () => {
  it('flattens teams across organizations, lowercased', () => {
    const slugs = myTeamSlugs({
      organizations: {
        nodes: [
          { teams: { nodes: [{ combinedSlug: 'Acme/Core' }, { combinedSlug: 'acme/infra' }] } },
          { teams: { nodes: [{ combinedSlug: 'other/sre' }] } },
        ],
      },
    });
    expect([...slugs].sort()).toEqual(['acme/core', 'acme/infra', 'other/sre']);
  });

  it('is empty rather than throwing when the viewer has no orgs', () => {
    expect(myTeamSlugs(undefined).size).toBe(0);
    expect(myTeamSlugs({ organizations: { nodes: [null] } }).size).toBe(0);
  });
});

describe('reviewRequestReason', () => {
  const teams = new Set(['acme/core', 'acme/infra']);
  const req = (...reviewers: any[]) => ({ reviewRequests: { nodes: reviewers.map((r) => ({ requestedReviewer: r })) } });
  const user = (login: string) => ({ __typename: 'User', login });
  const team = (combinedSlug: string) => ({ __typename: 'Team', combinedSlug });

  it('reports a direct request', () => {
    expect(reviewRequestReason(req(user('octocat')), 'octocat', teams)).toEqual({
      requestedFromYou: true,
      requestedTeams: [],
    });
  });

  it('matches your login case-insensitively', () => {
    expect(reviewRequestReason(req(user('OctoCat')), 'octocat', teams).requestedFromYou).toBe(true);
  });

  it('reports only the requested teams you are actually on', () => {
    const reason = reviewRequestReason(req(team('acme/core'), team('other/security')), 'octocat', teams);
    expect(reason).toEqual({ requestedFromYou: false, requestedTeams: ['acme/core'] });
  });

  it('reports both when you are named directly and through a team', () => {
    const reason = reviewRequestReason(req(user('octocat'), team('acme/infra')), 'octocat', teams);
    expect(reason).toEqual({ requestedFromYou: true, requestedTeams: ['acme/infra'] });
  });

  it('does not claim you were named directly when someone else was', () => {
    expect(reviewRequestReason(req(user('hubot')), 'octocat', teams)).toEqual({
      requestedFromYou: false,
      requestedTeams: [],
    });
  });

  it('falls back to every requested team when membership cannot be confirmed', () => {
    // A team whose membership the token cannot read still explains the request better
    // than claiming you were named directly.
    const reason = reviewRequestReason(req(team('secret/team')), 'octocat', teams);
    expect(reason).toEqual({ requestedFromYou: false, requestedTeams: ['secret/team'] });
  });

  it('survives a PR with no review requests left', () => {
    expect(reviewRequestReason({}, 'octocat', teams)).toEqual({
      requestedFromYou: false,
      requestedTeams: [],
    });
  });
});
