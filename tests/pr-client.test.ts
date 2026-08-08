import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PR_JS = readFileSync(join(__dirname, '..', 'public', 'js', 'pr.js'), 'utf8');

/**
 * pr.js runs entirely in the browser, so nothing in the build or the test suite used to
 * execute it — a `let` read before its declaration parsed fine, threw at load, and took
 * the rest of init() with it. These tests run the real file in a DOM.
 *
 * The page is a stripped-down PR view: enough structure for init() to find what it looks
 * for, not a copy of pr.ejs.
 */
function buildPage(options: { files: number; commits: number; reviewedFiles?: number }) {
  const { files, commits, reviewedFiles = 0 } = options;

  const fileRows = Array.from({ length: files }, (_, i) => {
    const checked = i < reviewedFiles ? 'checked' : '';
    return `
      <div class="diff-file" data-path="src/file-${i}.ts" data-additions="10" data-deletions="2">
        <input type="checkbox" class="file-reviewed-toggle" data-path="src/file-${i}.ts" ${checked}>
      </div>`;
  }).join('');

  const commitRows = Array.from({ length: commits }, (_, i) => `
      <details class="commit-item">
        <input type="checkbox" class="commit-reviewed-toggle" data-sha="sha${i}">
      </details>`).join('');

  return `<!DOCTYPE html><html><body>
    <div id="updates-banner" class="updates-banner hidden">
      <a href="" id="reload-link">Reload</a>
      <button id="dismiss-banner">Dismiss</button>
    </div>
    <button id="check-updates-btn">Check for updates</button>
    <div id="review-progress-panel">
      <span id="review-progress-commits"></span>
      <span id="review-progress-files"></span>
      <span id="review-progress-lines"></span>
      <span id="review-progress-percent"></span>
      <div id="review-progress-bar"></div>
    </div>
    <span id="commits-section-count"></span>
    <span id="files-section-count"></span>
    <div id="diff-container">${fileRows}${commitRows}</div>
    <button id="review-toggle-btn">Review</button>
    <div class="pr-review-form" id="review-form"></div>
    <div class="review-form-overlay" id="review-form-overlay"></div>
    <div id="goto-file-overlay"></div>
    <div id="goto-file-modal"><input id="goto-file-input"><ul id="goto-file-results"></ul></div>
  </body></html>`;
}

function load(page: string) {
  const dom = new JSDOM(page, { url: 'https://github.com/o/r/pull/1', runScripts: 'outside-only' });
  const win = dom.window as any;

  win.ARGUS_CONFIG = {
    owner: 'o',
    repo: 'r',
    prNumber: 1,
    headSha: 'abc',
    fetchedAt: new Date(0).toISOString(),
    pollIntervalMs: 999_999,
    isHistoricalView: false,
    isCrossRevisionView: false,
    isCurrentRevisionExplicit: false,
    hideWhitespace: false,
    lazyDiffs: false,
    commentFiles: {},
  };
  win.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ head_sha: 'abc' }) });

  const errors: unknown[] = [];
  win.addEventListener('error', (e: any) => errors.push(e.error ?? e.message));

  // Throws out of eval if the script fails at load, which is the failure mode being guarded.
  win.eval(PR_JS);

  return { win, doc: win.document, errors };
}

describe('pr.js', () => {
  let clicked: string[] = [];

  beforeEach(() => {
    clicked = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and runs init() without throwing', () => {
    const { errors } = load(buildPage({ files: 2, commits: 1 }));
    expect(errors).toEqual([]);
  });

  it('completes init(): work after the review-progress seed still runs', () => {
    // The regression this guards: a throw partway through init() left every later setup
    // step unregistered, silently. The directory "Review all" seeding is one of them.
    const page = buildPage({ files: 1, commits: 0 }).replace(
      '<div id="diff-container">',
      `<div id="diff-container">
        <div class="diff-directory">
          <input type="checkbox" class="dir-review-all-toggle">
          <div class="directory-children">
            <input type="checkbox" class="file-reviewed-toggle" data-path="a.ts" checked>
          </div>
        </div>`
    );
    const { doc, errors } = load(page);
    expect(errors).toEqual([]);
    const dirToggle = doc.querySelector('.dir-review-all-toggle') as HTMLInputElement;
    expect(dirToggle.checked).toBe(true);
  });

  describe('the `c` shortcut', () => {
    const pressC = (win: any) => {
      win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    };

    it('checks for updates when no banner is showing', () => {
      const { win } = load(buildPage({ files: 1, commits: 0 }));
      pressC(win);
      expect(win.fetch).toHaveBeenCalledWith('/pr/o/r/1/head');
    });

    it('clicks the reload link instead once updates are pending', () => {
      const { win, doc } = load(buildPage({ files: 1, commits: 0 }));
      doc.getElementById('reload-link').addEventListener('click', (e: any) => {
        e.preventDefault();
        clicked.push('reload');
      });

      doc.getElementById('updates-banner').classList.remove('hidden');
      pressC(win);

      expect(clicked).toEqual(['reload']);
      expect(win.fetch).not.toHaveBeenCalled();
    });

    it('goes back to checking once the banner is dismissed', () => {
      const { win, doc } = load(buildPage({ files: 1, commits: 0 }));
      doc.getElementById('updates-banner').classList.remove('hidden');
      doc.getElementById('dismiss-banner').click();
      pressC(win);
      expect(win.fetch).toHaveBeenCalledWith('/pr/o/r/1/head');
    });
  });
});
