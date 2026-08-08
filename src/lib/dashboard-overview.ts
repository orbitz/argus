import type { Octokit } from '@octokit/rest';
import { cachedFetch, TTL, type CacheMode } from './api-cache.js';

/**
 * The dashboard's data: what is waiting on you, what is waiting on someone else, and where
 * you were mentioned.
 *
 * All of it comes from GitHub's search index in one GraphQL request with aliased search
 * fields. Search is the only way to ask these questions without walking every repository —
 * "PRs where my review is requested" is not derivable from a repo listing without fetching
 * every PR's requested reviewers, which is what the old repo-by-repo dashboard did at a
 * cost of hundreds of requests.
 *
 * Note `review-requested:` rather than `user-review-requested:`: the former includes review
 * requests that arrived through a team, the latter only direct ones. On an org that
 * requests reviews by team, the direct-only qualifier returns nothing at all.
 */

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;

export interface OverviewPull {
  number: number;
  title: string;
  owner: string;
  repo: string;
  fullName: string;
  authorLogin: string;
  authorIsBot: boolean;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  changedFiles: number;
  additions: number;
  deletions: number;
  reviewCount: number;
  commentCount: number;
  reviewDecision: ReviewDecision;
  /** Head commit, so per-file "reviewed" progress from the local DB can be keyed to it. */
  headSha: string;
  /** Why this is waiting on you. Empty on PRs fetched outside the review-request search. */
  requestedFromYou: boolean;
  requestedTeams: string[];
}

export interface OverviewMention {
  number: number;
  title: string;
  owner: string;
  repo: string;
  fullName: string;
  updatedAt: string;
  authorLogin: string;
  isPullRequest: boolean;
}

/** A capped slice of a result set, which always knows how much it is not showing. */
export interface CappedList<T> {
  total: number;
  items: T[];
}

export interface DashboardOverview {
  /** PRs asking for your review, split so a wall of dependency bumps cannot bury a human's PR. */
  waiting: {
    total: number;
    humans: OverviewPull[];
    bots: OverviewPull[];
  };
  /** Your own open PRs, bucketed by what the reviewers have said so far. */
  mine: {
    total: number;
    changesRequested: CappedList<OverviewPull>;
    approved: CappedList<OverviewPull>;
    awaiting: CappedList<OverviewPull>;
  };
  mentions: CappedList<OverviewMention>;
}

// How many items each section fetches. The counts shown always come from search's
// issueCount, not from these, so a capped section says how many it is hiding.
const LIMITS = {
  waiting: 50,
  changesRequested: 25,
  approved: 25,
  awaiting: 15,
  mentions: 30,
} as const;

const PULL_FIELDS = `
  number
  title
  isDraft
  createdAt
  updatedAt
  changedFiles
  additions
  deletions
  reviewDecision
  headRefOid
  author { __typename login }
  repository { nameWithOwner }
  reviews(first: 0) { totalCount }
  comments(first: 0) { totalCount }
`;

// Only the review-request search needs to explain itself, so the extra nodes are asked
// for there rather than on every pull request the dashboard lists.
const REVIEW_REQUEST_FIELDS = `
  reviewRequests(first: 10) {
    nodes {
      requestedReviewer {
        __typename
        ... on User { login }
        ... on Team { combinedSlug }
      }
    }
  }
`;

const OVERVIEW_QUERY = `
  query(
    $login: String!
    $waiting: String!
    $changesRequested: String!
    $approved: String!
    $awaiting: String!
    $mine: String!
    $mentions: String!
    $waitingLimit: Int!
    $changesRequestedLimit: Int!
    $approvedLimit: Int!
    $awaitingLimit: Int!
    $mentionsLimit: Int!
  ) {
    # Which teams you are on, so a team review request can be named as the reason a PR is
    # waiting on you. Filtering by userLogins asks GitHub to do the membership test.
    viewer {
      organizations(first: 25) {
        nodes {
          teams(first: 100, userLogins: [$login]) {
            nodes { combinedSlug }
          }
        }
      }
    }
    waiting: search(query: $waiting, type: ISSUE, first: $waitingLimit) {
      issueCount
      nodes { ... on PullRequest { ${PULL_FIELDS} ${REVIEW_REQUEST_FIELDS} } }
    }
    changesRequested: search(query: $changesRequested, type: ISSUE, first: $changesRequestedLimit) {
      issueCount
      nodes { ... on PullRequest { ${PULL_FIELDS} } }
    }
    approved: search(query: $approved, type: ISSUE, first: $approvedLimit) {
      issueCount
      nodes { ... on PullRequest { ${PULL_FIELDS} } }
    }
    awaiting: search(query: $awaiting, type: ISSUE, first: $awaitingLimit) {
      issueCount
      nodes { ... on PullRequest { ${PULL_FIELDS} } }
    }
    # Count only: lets the page tell you when the three buckets do not account for every
    # open PR you have (a PR whose only reviews are comments falls outside all three).
    mine: search(query: $mine, type: ISSUE, first: 0) {
      issueCount
    }
    mentions: search(query: $mentions, type: ISSUE, first: $mentionsLimit) {
      issueCount
      nodes {
        __typename
        ... on Issue {
          number title updatedAt
          author { login }
          repository { nameWithOwner }
        }
        ... on PullRequest {
          number title updatedAt
          author { login }
          repository { nameWithOwner }
        }
      }
    }
  }
`;

function splitFullName(fullName: string): { owner: string; repo: string } {
  const slash = fullName.indexOf('/');
  if (slash === -1) return { owner: '', repo: fullName };
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

/**
 * Why a pull request is asking for your review: because it named you, or because it named
 * a team you are on.
 *
 * A PR can request several teams and only some of them will be yours, so team requests are
 * intersected with your own membership. When nothing matches — a team whose membership the
 * token cannot read, or a request withdrawn since search last indexed the PR — every
 * requested team is reported rather than claiming, wrongly, that you were named directly.
 */
export function reviewRequestReason(
  node: any,
  login: string,
  myTeams: Set<string>
): { requestedFromYou: boolean; requestedTeams: string[] } {
  const nodes: any[] = node?.reviewRequests?.nodes ?? [];
  const wanted = login.toLowerCase();

  let requestedFromYou = false;
  const mine: string[] = [];
  const all: string[] = [];

  for (const entry of nodes) {
    const reviewer = entry?.requestedReviewer;
    if (!reviewer) continue;
    if (reviewer.__typename === 'User' && (reviewer.login ?? '').toLowerCase() === wanted) {
      requestedFromYou = true;
    } else if (reviewer.__typename === 'Team' && reviewer.combinedSlug) {
      all.push(reviewer.combinedSlug);
      if (myTeams.has(reviewer.combinedSlug.toLowerCase())) mine.push(reviewer.combinedSlug);
    }
  }

  if (requestedFromYou) return { requestedFromYou, requestedTeams: mine };
  return { requestedFromYou, requestedTeams: mine.length > 0 ? mine : all };
}

/** The `org/team` slugs you belong to, lowercased for comparison. */
export function myTeamSlugs(viewer: any): Set<string> {
  const slugs = new Set<string>();
  for (const org of viewer?.organizations?.nodes ?? []) {
    for (const team of org?.teams?.nodes ?? []) {
      if (team?.combinedSlug) slugs.add(String(team.combinedSlug).toLowerCase());
    }
  }
  return slugs;
}

export function toOverviewPull(node: any): OverviewPull | null {
  if (!node || typeof node.number !== 'number') return null;
  const fullName: string = node.repository?.nameWithOwner ?? '';
  const { owner, repo } = splitFullName(fullName);
  return {
    number: node.number,
    title: node.title ?? '',
    owner,
    repo,
    fullName,
    authorLogin: node.author?.login ?? 'ghost',
    // GitHub types app actors as Bot, which is more reliable than matching on a login
    // suffix — dependabot's login carries no [bot] marker in search results.
    authorIsBot: node.author?.__typename === 'Bot',
    createdAt: node.createdAt ?? '',
    updatedAt: node.updatedAt ?? '',
    draft: !!node.isDraft,
    changedFiles: node.changedFiles ?? 0,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    reviewCount: node.reviews?.totalCount ?? 0,
    commentCount: node.comments?.totalCount ?? 0,
    reviewDecision: node.reviewDecision ?? null,
    headSha: node.headRefOid ?? '',
    requestedFromYou: false,
    requestedTeams: [],
  };
}

function toOverviewMention(node: any): OverviewMention | null {
  if (!node || typeof node.number !== 'number') return null;
  const fullName: string = node.repository?.nameWithOwner ?? '';
  const { owner, repo } = splitFullName(fullName);
  return {
    number: node.number,
    title: node.title ?? '',
    owner,
    repo,
    fullName,
    updatedAt: node.updatedAt ?? '',
    authorLogin: node.author?.login ?? 'ghost',
    isPullRequest: node.__typename === 'PullRequest',
  };
}

function pulls(section: any): OverviewPull[] {
  return (section?.nodes ?? []).map(toOverviewPull).filter((p: OverviewPull | null): p is OverviewPull => p !== null);
}

/**
 * Cache key for the overview.
 *
 * v1: initial three-section dashboard.
 */
export function overviewCacheKey(login: string): string {
  return `dashboard-overview:v1:${login}`;
}

export async function fetchDashboardOverview(
  octokit: Octokit,
  login: string,
  mode?: CacheMode
): Promise<DashboardOverview> {
  const author = `type:pr state:open author:${login}`;

  const result = await cachedFetch<DashboardOverview>(
    overviewCacheKey(login),
    { ttlMs: TTL.dashboard, mode },
    async () => {
      const response: any = await octokit.graphql(OVERVIEW_QUERY, {
        // sort:updated is search's default ordering, so the capped sections show the most
        // recently active items rather than an arbitrary slice.
        login,
        waiting: `type:pr state:open review-requested:${login}`,
        changesRequested: `${author} review:changes_requested`,
        approved: `${author} review:approved`,
        awaiting: `${author} review:none`,
        mine: author,
        mentions: `state:open mentions:${login}`,
        waitingLimit: LIMITS.waiting,
        changesRequestedLimit: LIMITS.changesRequested,
        approvedLimit: LIMITS.approved,
        awaitingLimit: LIMITS.awaiting,
        mentionsLimit: LIMITS.mentions,
      });

      const myTeams = myTeamSlugs(response?.viewer);
      const waitingNodes: any[] = response?.waiting?.nodes ?? [];
      const waitingPulls = waitingNodes
        .map((node) => {
          const pull = toOverviewPull(node);
          if (!pull) return null;
          return { ...pull, ...reviewRequestReason(node, login, myTeams) };
        })
        .filter((p): p is OverviewPull => p !== null);

      const overview: DashboardOverview = {
        waiting: {
          total: response?.waiting?.issueCount ?? 0,
          humans: waitingPulls.filter((p) => !p.authorIsBot),
          bots: waitingPulls.filter((p) => p.authorIsBot),
        },
        mine: {
          total: response?.mine?.issueCount ?? 0,
          changesRequested: {
            total: response?.changesRequested?.issueCount ?? 0,
            items: pulls(response?.changesRequested),
          },
          approved: {
            total: response?.approved?.issueCount ?? 0,
            items: pulls(response?.approved),
          },
          awaiting: {
            total: response?.awaiting?.issueCount ?? 0,
            items: pulls(response?.awaiting),
          },
        },
        mentions: {
          total: response?.mentions?.issueCount ?? 0,
          items: (response?.mentions?.nodes ?? [])
            .map(toOverviewMention)
            .filter((m: OverviewMention | null): m is OverviewMention => m !== null),
        },
      };

      // GraphQL responses carry no usable ETag, so this is a TTL + stale-while-revalidate
      // cache rather than a conditional one.
      return { data: overview, etag: null };
    }
  );

  return result.data;
}

/**
 * PRs of yours that the three buckets do not account for — currently those whose only
 * reviews are comments, which search's `review:` qualifiers have no value for. Reported
 * rather than silently dropped, so the section's counts add up to the total.
 */
export function unbucketedMineCount(mine: DashboardOverview['mine']): number {
  const bucketed = mine.changesRequested.total + mine.approved.total + mine.awaiting.total;
  return Math.max(0, mine.total - bucketed);
}
