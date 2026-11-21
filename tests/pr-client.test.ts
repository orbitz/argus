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

  describe('the delete card of a move', () => {
    // A move splits into two cards and the one at the vacated path shows a notice
    // instead of a diff body. It carries the same review checkbox as every other card
    // (see diff-renderer), so it is an ordinary review item: a stop for n/p, a target
    // for `r`, and part of the review denominator.
    const page = () => buildPage({ files: 1, commits: 0 }).replace(
      '<div id="diff-container">',
      `<div id="diff-container">
        <details class="diff-file" data-path="old/file.ts" data-additions="0" data-deletions="0">
          <input type="checkbox" class="file-reviewed-toggle" data-path="old/file.ts" data-file-sha="">
        </details>`
    );

    const press = (win: any, key: string) =>
      win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true }));

    it('is a navigation stop for n', () => {
      const { win, doc } = load(page());
      win.Element.prototype.scrollIntoView = () => {};
      press(win, 'n');
      expect(doc.querySelector('.review-item-current')!.getAttribute('data-path')).toBe('old/file.ts');
      // Every item is unreviewed, so the second press wraps around to it again.
      press(win, 'n');
      expect(doc.querySelector('.review-item-current')!.getAttribute('data-path')).toBe('old/file.ts');
    });

    it('marks the card reviewed when `r` is pressed', async () => {
      const { win, doc } = load(page());
      win.Element.prototype.scrollIntoView = () => {};
      win.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reviewed: true }) });

      press(win, 'r');
      await new Promise((r) => setTimeout(r, 0));

      expect(win.fetch).toHaveBeenCalledWith(
        '/pr/o/r/1/file-review',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ file_path: 'old/file.ts', head_sha: 'abc', file_sha: '' }),
        })
      );
      expect(doc.querySelector('[data-path="old/file.ts"]')!.classList.contains('file-reviewed')).toBe(true);
      expect(doc.querySelector('[data-path="old/file.ts"]')!.hasAttribute('open')).toBe(false);
    });

    it('is counted in the review denominator', async () => {
      const { win, doc } = load(page());
      win.Element.prototype.scrollIntoView = () => {};
      win.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reviewed: true }) });
      const cb = doc.querySelector('[data-path="src/file-0.ts"] .file-reviewed-toggle') as HTMLInputElement;
      cb.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(doc.getElementById('files-section-count')!.textContent).toBe('1 / 2 reviewed');
    });
  });

  describe('the inline thread reply dialog', () => {
    // The round trip must survive both a real newline and a literal backslash-n.
    const BODY = 'first line\nsecond \\n line';

    const escapeAttr = (value: string) =>
      value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

    const REPLY_TEMPLATE = `
      <template id="reply-comment-form-template">
        <tr class="inline-comment-form-row reply-comment-form-row inline-comment-form-js">
          <td colspan="4">
            <form class="inline-comment-form reply-form" method="POST">
              <input type="hidden" name="comment_id" value="">
              <input type="hidden" name="return_to" value="">
              <textarea name="body" rows="3" required class="comment-textarea"></textarea>
              <div class="comment-form-actions">
                <button type="button" class="btn btn-small cancel-inline-comment">Cancel</button>
                <button type="submit" class="btn btn-small">Reply</button>
              </div>
            </form>
          </td>
        </tr>
      </template>`;

    // Two threads in a diff body, i.e. content a lazy fetch injects after init().
    const page = () => buildPage({ files: 1, commits: 0 }).replace(
      '<div id="diff-container">',
      `<div id="diff-container">
        <details class="diff-file" data-path="src/file-0.ts" open>
          <div class="diff-content">
            <table class="diff-table"><tbody>
              ${[7, 8].map((id) => `
              <tr class="comment-thread-row"><td colspan="4"><div class="comment-thread">
                <div class="inline-comment" id="comment-${id}" data-comment-id="${id}">
                  <button type="button" class="btn btn-small reply-to-comment"
                          data-author="alice" data-comment-id="${id}"
                          data-body="${escapeAttr(JSON.stringify(BODY))}">Reply</button>
                </div>
              </div></td></tr>`).join('')}
            </tbody></table>
          </div>
        </details>
        ${REPLY_TEMPLATE}
      </div>`
    );

    const clickReply = (doc: any, index = 0) =>
      doc.querySelectorAll('.reply-to-comment[data-comment-id]')[index].click();

    it('opens a prefilled reply form under the clicked thread', () => {
      const { doc, errors } = load(page());
      clickReply(doc, 0);

      const formRow = doc.querySelector('.reply-comment-form-row');
      expect(formRow).not.toBeNull();
      expect(formRow.previousElementSibling.classList.contains('comment-thread-row')).toBe(true);

      const form = formRow.querySelector('form');
      expect(form.getAttribute('action')).toBe('/pr/o/r/1/reply');
      expect(form.querySelector('input[name="comment_id"]').value).toBe('7');
      expect(form.querySelector('input[name="return_to"]').value).toBe('review');
      expect(form.querySelector('textarea').value).toBe('@alice\n\n> first line\n> second \\n line\n\n');
      expect(errors).toEqual([]);
    });

    it('keeps one reply form open at a time', () => {
      const { doc } = load(page());
      clickReply(doc, 0);
      clickReply(doc, 1);

      const rows = doc.querySelectorAll('.reply-comment-form-row');
      expect(rows).toHaveLength(1);
      expect(rows[0].querySelector('input[name="comment_id"]').value).toBe('8');
    });

    it('removes the form on Cancel and on Escape', () => {
      const { win, doc } = load(page());

      clickReply(doc, 0);
      doc.querySelector('.reply-comment-form-row .cancel-inline-comment').click();
      expect(doc.querySelector('.reply-comment-form-row')).toBeNull();

      clickReply(doc, 0);
      doc.querySelector('.reply-comment-form-row textarea')
        .dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(doc.querySelector('.reply-comment-form-row')).toBeNull();
    });
  });
});
