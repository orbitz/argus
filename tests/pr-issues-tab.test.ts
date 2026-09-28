import { describe, it, expect } from 'vitest';
import ejs from 'ejs';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Rendering, not just compiling. tests/templates.test.ts proves pr.ejs parses; this proves
 * the Issues tab it now carries produces the rows a reader is meant to see, including the
 * cases that only appear on a bad day — an issue in another repository, and one the token
 * could not read.
 */

const TEMPLATE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'templates',
  'pr.ejs'
);

const OWNER = 'orbitz';
const REPO = 'argus';

/** The smallest viewData pr.ejs will render. Only the Issues tab fields vary per test. */
function viewData(referencedIssues: unknown[]) {
  return {
    title: '#42 A pull request - Argus',
    user: { login: 'reviewer', avatar_url: '' },
    owner: OWNER,
    repo: REPO,
    pr: {
      number: 42,
      title: 'A pull request',
      body: null,
      renderedBody: '',
      state: 'open',
      merged: false,
      merged_at: null,
      mergeable: true,
      user: { login: 'author', avatar_url: '' },
      base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: `${OWNER}/${REPO}` } },
      head: { ref: 'topic', sha: 'a'.repeat(40), repo: { full_name: `${OWNER}/${REPO}` } },
      additions: 1,
      deletions: 0,
      changed_files: 1,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      html_url: `https://github.com/${OWNER}/${REPO}/pull/42`,
      requested_reviewers: [],
      assignees: [],
      labels: [],
    },
    files: [],
    fileCount: 0,
    fileTreeHtml: '',
    lazyDiffs: false,
    commentFiles: {},
    issueComments: [],
    reviewComments: [],
    reviews: [],
    timeline: [],
    checksSummary: { total: 0, passed: 0, failed: 0, pending: 0, state: 'success' },
    mergeStatus: { state: 'clean', blocked: false, label: 'Ready to merge', detail: '' },
    pendingWorkflows: [],
    checks: [],
    statuses: [],
    revisions: [],
    isHistoricalView: false,
    selectedRevisionId: null,
    isCrossRevisionView: false,
    fromRevisionId: null,
    toRevisionId: null,
    isCurrentRevisionExplicit: false,
    commits: [{ sha: 'c'.repeat(40), commit: { message: 'FIX A thing #7', author: null }, author: null }],
    referencedIssues,
    fetchedAt: '2026-01-01T00:00:00Z',
    dataFetchedAt: '2026-01-01T00:00:00Z',
    inlineCommentFormTemplate: '',
    pollIntervalMs: 30000,
    config: { ui: { pollIntervalMs: 30000 } },
    reviewedFiles: [],
    reviewedCommits: [],
    reviewedCommitsSet: new Set<string>(),
    totalLines: 0,
    reviewedLines: 0,
    activeTab: 'issues',
    hideWhitespace: false,
  };
}

function render(referencedIssues: unknown[]) {
  const html = ejs.render(readFileSync(TEMPLATE, 'utf8'), viewData(referencedIssues), {
    filename: TEMPLATE,
  });
  return new JSDOM(html).window.document;
}

const issue = (over: Record<string, unknown> = {}) => ({
  owner: OWNER,
  repo: REPO,
  number: 7,
  key: 'orbitz/argus#7',
  title: 'The thing is broken',
  state: 'open',
  htmlUrl: `https://github.com/${OWNER}/${REPO}/issues/7`,
  isPullRequest: false,
  error: null,
  ...over,
});

describe('the Issues tab', () => {
  it('is one of the page tabs and is selected by ?tab=issues', () => {
    const doc = render([issue()]);
    const tab = doc.querySelector('.pr-tab[data-tab="issues"]');
    expect(tab).not.toBeNull();
    expect(tab!.classList.contains('active')).toBe(true);
    expect(
      doc.querySelector('[data-tab-content="issues"]')!.classList.contains('active')
    ).toBe(true);
  });

  it('counts the referenced issues on the tab', () => {
    const doc = render([issue(), issue({ number: 8, key: 'orbitz/argus#8' })]);
    expect(doc.querySelector('.pr-tab[data-tab="issues"] .tab-pill')!.textContent!.trim()).toBe('2');
  });

  it('shows each issue as a link carrying its number and title', () => {
    const doc = render([issue()]);
    const row = doc.querySelector('.issue-ref-row') as HTMLAnchorElement;
    expect(row.getAttribute('href')).toBe('https://github.com/orbitz/argus/issues/7');
    expect(row.querySelector('.issue-ref-id')!.textContent!.trim()).toBe('#7');
    expect(row.querySelector('.issue-ref-title')!.textContent!.trim()).toBe('The thing is broken');
    expect(row.querySelector('.issue-ref-state')!.textContent!.trim()).toBe('Open');
  });

  it('gives the full name to an issue outside this repository', () => {
    const doc = render([
      issue({ owner: 'terrateam', repo: 'terrat', number: 100, key: 'terrateam/terrat#100' }),
    ]);
    expect(doc.querySelector('.issue-ref-id')!.textContent!.trim()).toBe('terrateam/terrat#100');
  });

  it('marks a closed issue as closed', () => {
    const doc = render([issue({ state: 'closed' })]);
    const state = doc.querySelector('.issue-ref-state')!;
    expect(state.textContent!.trim()).toBe('Closed');
    expect(state.classList.contains('issue-ref-state-closed')).toBe(true);
  });

  it('shows the reason in place of a title the token could not read', () => {
    const doc = render([issue({ title: null, state: null, error: 'Not found, or not visible to this token' })]);
    const title = doc.querySelector('.issue-ref-title')!;
    expect(title.classList.contains('issue-ref-missing')).toBe(true);
    expect(title.textContent!.trim()).toBe('Not found, or not visible to this token');
    // Still a link: the reader may have access the token does not.
    expect(doc.querySelector('.issue-ref-row')!.getAttribute('href')).toBe(
      'https://github.com/orbitz/argus/issues/7'
    );
  });

  it('says when a referenced number is a pull request, not an issue', () => {
    const doc = render([issue({ isPullRequest: true })]);
    expect(doc.querySelector('.issue-ref-kind')!.textContent!.trim()).toBe('PR');
  });

  it('escapes a title that contains markup', () => {
    const doc = render([issue({ title: '<img src=x onerror=alert(1)>' })]);
    const title = doc.querySelector('.issue-ref-title')!;
    expect(title.querySelector('img')).toBeNull();
    expect(title.textContent!.trim()).toBe('<img src=x onerror=alert(1)>');
  });

  it('explains the convention when no commit references an issue', () => {
    const doc = render([]);
    expect(doc.querySelector('.issue-ref-list')).toBeNull();
    expect(doc.querySelector('.issue-refs-empty')).not.toBeNull();
    // No count pill on an empty tab.
    expect(doc.querySelector('.pr-tab[data-tab="issues"] .tab-pill')).toBeNull();
  });
});
