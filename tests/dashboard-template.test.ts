import { describe, it, expect } from 'vitest';
import ejs from 'ejs';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The dashboard now draws every row the way the pulls list does: a status dot, a fixed
 * grid, lines changed, repository, author, age. These render the page and check that the
 * row keeps that shape in all three tabs, including the two cases the pulls list never
 * has — a pull request from another repository, and an issue with no status at all.
 */

const TEMPLATE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'templates',
  'dashboard.ejs'
);

/** `hoursAgo` hours before now, so the age column renders a predictable "2h ago". */
function iso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
}

function pull(over: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Fix the thing',
    owner: 'octocat',
    repo: 'hello-world',
    fullName: 'octocat/hello-world',
    authorLogin: 'alice',
    authorIsBot: false,
    createdAt: iso(48),
    // 2.5 hours old, so the age reads "2h ago" after the whole-hours floor.
    updatedAt: iso(2.5),
    draft: false,
    changedFiles: 3,
    additions: 128,
    deletions: 34,
    reviewCount: 2,
    commentCount: 0,
    reviewDecision: null,
    checks: null,
    headSha: 'abc123',
    requestedFromYou: false,
    requestedTeams: [] as string[],
    reviewedFiles: 0,
    ...over,
  };
}

function mention(over: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: 'About the thing',
    owner: 'octocat',
    repo: 'hello-world',
    fullName: 'octocat/hello-world',
    authorLogin: 'bob',
    updatedAt: iso(1),
    isPullRequest: true,
    draft: null,
    changedFiles: null,
    additions: null,
    deletions: null,
    reviewDecision: null,
    checks: null,
    ...over,
  };
}

function render(over: Record<string, unknown> = {}) {
  const data = {
    title: 'Dashboard - Argus',
    user: { login: 'reviewer' },
    activeTab: 'waiting',
    waiting: { total: 0, humans: [], bots: [] },
    mine: {
      total: 0,
      changesRequested: { total: 0, items: [] },
      approved: { total: 0, items: [] },
      awaiting: { total: 0, items: [] },
    },
    mentions: { total: 0, items: [] },
    unbucketedMine: 0,
    dataFetchedAt: iso(0),
    ...over,
  };
  const html = ejs.render(readFileSync(TEMPLATE, 'utf8'), data, { filename: TEMPLATE });
  return new JSDOM(html).window.document;
}

const waitingRow = (doc: Document) =>
  doc.querySelector('[data-tab-content="waiting"] .pull-item-row')!;

describe('the dashboard pull-request row', () => {
  it('shows the diffstat, the repository, the author, and the age in that order', () => {
    const doc = render({ waiting: { total: 1, humans: [pull()], bots: [] } });
    const row = waitingRow(doc).querySelector('.pull-row')!;
    const children = [...row.children];

    expect(row.querySelector('.pull-stat .additions')!.textContent).toBe('+128');
    expect(row.querySelector('.pull-stat .deletions')!.textContent).toBe('-34');
    expect(row.querySelector('.pull-repo')!.textContent).toBe('octocat/hello-world');
    expect(row.querySelector('.pull-author')!.textContent).toBe('alice');
    expect(row.querySelector('.pull-age')!.textContent).toBe('2h ago');

    // Compare positions rather than markup, so styling can move freely.
    const at = (sel: string) => children.indexOf(row.querySelector(sel)!);
    expect(at('.pull-number')).toBeLessThan(at('.pull-stat'));
    expect(at('.pull-stat')).toBeLessThan(at('.pull-repo'));
    expect(at('.pull-repo')).toBeLessThan(at('.pull-external'));
    expect(at('.pull-external')).toBeLessThan(at('.pull-author'));
    expect(at('.pull-author')).toBeLessThan(at('.pull-age'));
  });

  it('links the row out to github.com, in that row\u2019s own repository', () => {
    const doc = render({
      waiting: {
        total: 1,
        humans: [pull({ fullName: 'other/repo', owner: 'other', repo: 'repo' })],
        bots: [],
      },
    });
    const icon = waitingRow(doc).querySelector('.pull-external')!;
    expect(icon.getAttribute('href')).toBe('https://github.com/other/repo/pull/42');
    expect(icon.getAttribute('target')).toBe('_blank');
    expect(icon.getAttribute('title')).toBe('Open on github.com');
  });

  it('links the repository column to that repository, not to this one', () => {
    const doc = render({
      waiting: { total: 1, humans: [pull({ fullName: 'other/repo', owner: 'other', repo: 'repo' })], bots: [] },
    });
    const repo = waitingRow(doc).querySelector('.pull-repo')!;
    expect(repo.getAttribute('href')).toBe('/repos/other/repo/pulls');
    expect(waitingRow(doc).querySelector('.pull-title a')!.getAttribute('href')).toBe('/pr/other/repo/42');
  });

  it('colors the dot green when the pull request is approved and the checks passed', () => {
    const doc = render({
      waiting: {
        total: 1,
        humans: [pull({ reviewDecision: 'APPROVED', checks: { state: 'passed', total: 4 } })],
        bots: [],
      },
    });
    const cell = waitingRow(doc).querySelector('.rail-cell')!;
    expect(cell.classList.contains('is-approved')).toBe(true);
    expect(cell.classList.contains('is-checks-passed')).toBe(true);
    const tip = cell.querySelector('.dot')!.getAttribute('title')!;
    expect(tip).toContain('Approved');
    expect(tip).toContain('All 4 checks passed');
  });

  it('colors the dot red when changes are requested', () => {
    const doc = render({
      waiting: {
        total: 1,
        humans: [pull({ reviewDecision: 'CHANGES_REQUESTED', checks: { state: 'failed', total: 3 } })],
        bots: [],
      },
    });
    const cell = waitingRow(doc).querySelector('.rail-cell')!;
    expect(cell.classList.contains('is-changes-requested')).toBe(true);
    expect(cell.querySelector('.dot')!.getAttribute('title')).toContain('Changes requested');
  });

  it('hollows the dot while the pull request is a draft', () => {
    const doc = render({ waiting: { total: 1, humans: [pull({ draft: true })], bots: [] } });
    const cell = waitingRow(doc).querySelector('.rail-cell')!;
    expect(cell.classList.contains('is-draft')).toBe(true);
    expect(waitingRow(doc).textContent).toContain('draft');
  });

  it('keeps the review-request and progress badges in the title cell', () => {
    const doc = render({
      waiting: {
        total: 1,
        humans: [pull({ requestedFromYou: true, reviewedFiles: 2 })],
        bots: [],
      },
    });
    const title = waitingRow(doc).querySelector('.pull-title')!;
    expect(title.querySelector('.badge.asked-you')!.textContent).toBe('you');
    expect(title.querySelector('.badge.progress')!.textContent).toBe('2/3');
  });

  it('leaves no diffstat cell for a pull request with no changes', () => {
    const doc = render({
      waiting: { total: 1, humans: [pull({ changedFiles: 0, additions: 0, deletions: 0 })], bots: [] },
    });
    expect(waitingRow(doc).querySelector('.pull-stat')).toBeNull();
    // The columns after it must not move, which is what the explicit grid-column rules buy.
    expect(waitingRow(doc).querySelector('.pull-repo')).not.toBeNull();
  });

  it('keeps the row searchable by title and repository', () => {
    const doc = render({ waiting: { total: 1, humans: [pull()], bots: [] } });
    expect(waitingRow(doc).closest('li')!.getAttribute('data-title')).toBe(
      'fix the thing octocat/hello-world'
    );
  });
});

describe('the dashboard mentions tab', () => {
  it('gives a mentioned pull request the same row, with its own diffstat', () => {
    const doc = render({
      mentions: { total: 1, items: [mention({ changedFiles: 1, additions: 5, deletions: 0 })] },
    });
    const row = doc.querySelector('[data-tab-content="mentions"] .pull-item-row')!;
    expect(row.querySelector('.rail-cell .dot')).not.toBeNull();
    expect(row.querySelector('.pull-stat .additions')!.textContent).toBe('+5');
    expect(row.querySelector('.pull-title a')!.getAttribute('href')).toBe('/pr/octocat/hello-world/7');
    expect(row.querySelector('.pull-external')!.getAttribute('href')).toBe(
      'https://github.com/octocat/hello-world/pull/7'
    );
  });

  it('gives an issue an empty rail cell, no diffstat, and an issue badge', () => {
    const doc = render({
      mentions: { total: 1, items: [mention({ isPullRequest: false })] },
    });
    const row = doc.querySelector('[data-tab-content="mentions"] .pull-item-row')!;
    expect(row.querySelector('.rail-cell .dot')).toBeNull();
    expect(row.querySelector('.pull-stat')).toBeNull();
    // The title already leaves the site, so the icon cell stays empty.
    expect(row.querySelector('.pull-external')).toBeNull();
    expect(row.querySelector('.pull-title .badge')!.textContent).toBe('issue');
    expect(row.querySelector('.pull-title a')!.getAttribute('href')).toBe(
      'https://github.com/octocat/hello-world/issues/7'
    );
    expect(row.querySelector('.pull-title a')!.getAttribute('target')).toBe('_blank');
  });
});
