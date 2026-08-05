import { DiffFile, DiffLine, DiffHunk, parseHunkString, parsePatch } from './diff-parser.js';
import { detectLanguage, highlightLines } from './syntax-highlighter.js';

/**
 * The complete text of both sides of a file, used purely as syntax-highlighting context.
 *
 * Never rendered — the reader still sees only the diff's own hunks. See buildHighlightMap.
 */
export interface FileSources {
  oldSource: string;
  newSource: string;
}

// Convert a file path to a URL-safe slug for stable deep linking
export function fileSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

// Escape HTML characters
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Line type display mappings (excludes 'header' which is handled separately)
type ContentLineType = 'add' | 'del' | 'context';

const LINE_TYPE_CLASSES: Record<ContentLineType, string> = {
  add: 'diff-line-add',
  del: 'diff-line-del',
  context: 'diff-line-context',
};

const LINE_TYPE_PREFIXES: Record<ContentLineType, string> = {
  add: '+',
  del: '-',
  context: ' ',
};

/**
 * Does every line of this hunk sit at the line number the sources say it does?
 *
 * Cheap insurance against feeding the highlighter a file that does not match the patch:
 * a merge-base skew, or the synthetic hunks injectOrphanedCommentHunks rebuilds from a
 * comment's stale `diff_hunk`. Checking each line's text against the source at its own line
 * number catches all of that before a single wrong colour is emitted.
 */
function hunkAlignsWithSources(
  hunk: DiffHunk,
  oldSrc: string[],
  newSrc: string[]
): boolean {
  for (const line of hunk.lines) {
    if (line.type === 'del') {
      if (line.oldLineNum === null || oldSrc[line.oldLineNum - 1] !== line.content) return false;
    } else {
      if (line.newLineNum === null || newSrc[line.newLineNum - 1] !== line.content) return false;
    }
  }
  return true;
}

/**
 * Highlight hunks in isolation, one Shiki pass per hunk per side.
 *
 * The fallback for when the real file isn't available. Grammar state still can't be right
 * for a hunk that opens inside a construct started above it, but confining each pass to one
 * hunk means state cannot leak *across* the elided gap between hunks — which is the failure
 * that turns the whole rest of a file into one comment.
 */
async function addIsolatedHunkHighlighting(
  hunks: DiffHunk[],
  language: string,
  map: Map<DiffLine, string>
): Promise<void> {
  await Promise.all(hunks.map(async (hunk) => {
    // The two sides are tokenized separately: interleaving added and deleted lines would
    // feed the grammar a document that never existed (both versions of a changed line back
    // to back). Deletions plus context are the old file, additions plus context the new one.
    const oldLines: DiffLine[] = [];
    const newLines: DiffLine[] = [];
    for (const line of hunk.lines) {
      if (line.type === 'del') oldLines.push(line);
      else if (line.type === 'add') newLines.push(line);
      else {
        oldLines.push(line);
        newLines.push(line);
      }
    }

    const [oldHtml, newHtml] = await Promise.all([
      highlightLines(oldLines.map((l) => l.content), language),
      highlightLines(newLines.map((l) => l.content), language),
    ]);

    // Context lines appear in both passes; the new side wins (they are identical anyway,
    // but the new side's surrounding context is the one the reader is looking at).
    oldLines.forEach((line, i) => map.set(line, oldHtml[i]));
    newLines.forEach((line, i) => map.set(line, newHtml[i]));
  }));
}

/**
 * Highlight every line of a file, keyed by line identity.
 *
 * Given the file's real contents, each side is tokenized once as a whole document and every
 * diff line takes the colours of its own line number. That is the only way to get this
 * right: a diff is a set of excerpts, so tokenizing the excerpts — however many at a time —
 * hides whatever the elided regions contain. A block comment opened in one hunk and closed
 * in the gap below it would otherwise never close, and every hunk after it comes back
 * coloured as comment.
 *
 * Hunks the sources don't corroborate, and every hunk when there are no sources, fall back
 * to isolated per-hunk highlighting.
 */
async function buildHighlightMap(
  hunks: DiffHunk[],
  language: string,
  sources?: FileSources
): Promise<Map<DiffLine, string>> {
  const oldSrc = sources ? sources.oldSource.split('\n') : null;
  const newSrc = sources ? sources.newSource.split('\n') : null;

  const aligned: DiffHunk[] = [];
  const isolated: DiffHunk[] = [];
  for (const hunk of hunks) {
    if (oldSrc && newSrc && hunkAlignsWithSources(hunk, oldSrc, newSrc)) aligned.push(hunk);
    else isolated.push(hunk);
  }

  const map = new Map<DiffLine, string>();

  if (aligned.length > 0 && oldSrc && newSrc) {
    // Tokenizing to EOF is wasted work: grammar state only ever flows forward, so a line's
    // colours depend on everything *above* it and nothing below. Stopping at the last line
    // any hunk actually asks for gives byte-identical output for those lines while skipping
    // the tail — which on a small change near the top of a big file is nearly the whole file.
    // A side no aligned hunk reads (a pure-addition file's old side, say) is skipped outright.
    let maxOld = 0;
    let maxNew = 0;
    for (const hunk of aligned) {
      for (const line of hunk.lines) {
        if (line.type === 'del') {
          if (line.oldLineNum !== null && line.oldLineNum > maxOld) maxOld = line.oldLineNum;
        } else if (line.newLineNum !== null && line.newLineNum > maxNew) {
          maxNew = line.newLineNum;
        }
      }
    }

    const [oldHtml, newHtml] = await Promise.all([
      highlightLines(oldSrc.slice(0, maxOld), language),
      highlightLines(newSrc.slice(0, maxNew), language),
    ]);

    for (const hunk of aligned) {
      for (const line of hunk.lines) {
        const html = line.type === 'del'
          ? (line.oldLineNum === null ? undefined : oldHtml[line.oldLineNum - 1])
          : (line.newLineNum === null ? undefined : newHtml[line.newLineNum - 1]);
        // A miss leaves the line out of the map; renderLine escapes it plainly.
        if (html !== undefined) map.set(line, html);
      }
    }
  }

  if (isolated.length > 0) {
    await addIsolatedHunkHighlighting(isolated, language, map);
  }

  return map;
}

/**
 * Reconstruct both complete sides of a file from a full-context (`-U99999`) patch.
 *
 * With no elided regions, deletions plus context are the entire old file and additions plus
 * context the entire new one. Returns null if the patch has hunks that skip lines, i.e. it
 * wasn't produced with full context after all — highlighting against a file with holes in it
 * is exactly the bug this exists to avoid.
 */
export function sourcesFromFullContextPatch(patch: string): FileSources | null {
  const parsed = parsePatch(patch, '', 'modified');
  const oldLines: string[] = [];
  const newLines: string[] = [];

  // A side with a zero count (a created or deleted file) has no line to be contiguous with,
  // so only a non-empty side is held to starting where the previous hunk left off.
  let expectedOld = 1;
  let expectedNew = 1;
  for (const hunk of parsed.hunks) {
    if (hunk.oldCount > 0 && hunk.oldStart !== expectedOld) return null;
    if (hunk.newCount > 0 && hunk.newStart !== expectedNew) return null;
    for (const line of hunk.lines) {
      if (line.type !== 'add') oldLines.push(line.content);
      if (line.type !== 'del') newLines.push(line.content);
    }
    if (hunk.oldCount > 0) expectedOld = hunk.oldStart + hunk.oldCount;
    if (hunk.newCount > 0) expectedNew = hunk.newStart + hunk.newCount;
  }

  if (oldLines.length === 0 && newLines.length === 0) return null;
  return { oldSource: oldLines.join('\n'), newSource: newLines.join('\n') };
}

// Render a single diff line
function renderLine(
  line: DiffLine,
  fileId: string,
  path: string,
  headSha: string,
  owner: string,
  repo: string,
  prNumber: number,
  language: string | null,
  enableHighlighting: boolean,
  highlighted: Map<DiffLine, string> | null
): string {
  const contentType = line.type as ContentLineType;
  const lineClass = LINE_TYPE_CLASSES[contentType];
  const oldNum = line.oldLineNum ?? '';
  const newNum = line.newLineNum ?? '';
  const prefix = LINE_TYPE_PREFIXES[contentType];

  // For commenting, use the new line number for additions/context, old for deletions
  const commentLine = line.type === 'del' ? line.oldLineNum : line.newLineNum;
  const commentSide = line.type === 'del' ? 'LEFT' : 'RIGHT';

  // Unique ID for this line's comment form (for CSS :target)
  const lineId = `f-${fileId}-L${commentSide}${commentLine}`;
  const formId = `comment-${lineId}`;

  // Comment button - links to the form anchor for no-JS support
  const commentBtn = commentLine ? `
    <a href="#${formId}" class="line-comment-btn" title="Add comment" aria-label="Add comment on line ${commentLine}">+</a>
  ` : '';

  // Syntax highlighting is computed for the whole file up front (see buildHighlightMap);
  // this is just a lookup.
  const contentHtml =
    enableHighlighting && language && highlighted
      ? highlighted.get(line) ?? escapeHtml(line.content)
      : escapeHtml(line.content);

  return `
    <tr class="diff-line ${lineClass}" id="${lineId}"
        data-path="${escapeHtml(path)}"
        data-line="${commentLine || ''}"
        data-side="${commentSide}"
        data-sha="${headSha}">
      <td class="diff-line-num diff-line-num-old">${oldNum}</td>
      <td class="diff-line-num diff-line-num-new">${newNum}</td>
      <td class="diff-line-action">${commentBtn}</td>
      <td class="diff-line-content"><span class="diff-line-prefix">${prefix}</span>${contentHtml}</td>
    </tr>`;
  // Note: the inline comment form is no longer rendered per-line. It is built on demand
  // in the client from the #inline-comment-form-template (see renderInlineCommentForm and
  // public/js/pr.js). This removes one <form>/<textarea> per commentable line — the single
  // largest source of DOM bloat on very large diffs.
}

// Render a hunk header
function renderHunkHeader(header: string): string {
  // Extract the @@ part and any function context
  const match = header.match(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)(.*)$/);
  const range = match ? match[1] : header;
  const context = match ? match[2] : '';

  return `
    <tr class="diff-hunk-header">
      <td class="diff-line-num"></td>
      <td class="diff-line-num"></td>
      <td class="diff-line-action"></td>
      <td class="diff-hunk-content">
        <span class="diff-hunk-range">${escapeHtml(range)}</span>
        ${context ? `<span class="diff-hunk-context">${escapeHtml(context)}</span>` : ''}
      </td>
    </tr>`;
}

// Check if a line number + side already exists in any hunk
function isLineInHunks(line: number, side: 'LEFT' | 'RIGHT', hunks: DiffHunk[]): boolean {
  for (const hunk of hunks) {
    for (const diffLine of hunk.lines) {
      if (side === 'LEFT' && diffLine.oldLineNum === line && diffLine.type === 'del') return true;
      if (side === 'RIGHT' && diffLine.newLineNum === line && diffLine.type !== 'del') return true;
    }
  }
  return false;
}

// Inject synthetic hunks for comments on lines not in any existing hunk
function injectOrphanedCommentHunks(
  hunks: DiffHunk[],
  comments: Array<{ line: number | null; side: 'LEFT' | 'RIGHT'; diff_hunk?: string }>
): DiffHunk[] {
  const syntheticHunks = new Map<string, DiffHunk>();

  for (const comment of comments) {
    if (comment.line === null || !comment.diff_hunk) continue;
    if (isLineInHunks(comment.line, comment.side, hunks)) continue;

    const parsed = parseHunkString(comment.diff_hunk);
    if (parsed.lines.length === 0) continue;

    // Deduplicate by hunk header
    if (!syntheticHunks.has(parsed.header)) {
      syntheticHunks.set(parsed.header, parsed);
    }
  }

  if (syntheticHunks.size === 0) return hunks;

  const merged = [...hunks, ...syntheticHunks.values()];
  merged.sort((a, b) => a.newStart - b.newStart);
  return merged;
}

const STATUS_BADGES: Record<string, { class: string; text: string }> = {
  added: { class: 'badge-added', text: 'A' },
  deleted: { class: 'badge-deleted', text: 'D' },
  modified: { class: 'badge-modified', text: 'M' },
  renamed: { class: 'badge-renamed', text: 'R' },
};

// Build the <details> opening-tag attributes and <summary> for a normal (non-binary,
// non-empty) file. Shared by renderFile (eager) and renderFileShell (lazy) so both produce
// a byte-identical header — the sidebar, go-to-file modal, review toggles and progress bar
// all key off these attributes.
function buildNormalFileChrome(
  file: DiffFile,
  fileId: string,
  isReviewed: boolean,
  enableHighlighting: boolean,
  fileSha: string,
  headSha: string
): { attrs: string; summary: string } {
  const path = file.newPath || file.oldPath;
  const filename = path.split('/').pop() || path;
  const directory = path.substring(0, path.length - filename.length);

  const statsHtml = `<span class="file-stat additions">+${file.additions}</span>
       <span class="file-stat deletions">-${file.deletions}</span>`;

  const badge = STATUS_BADGES[file.status] || STATUS_BADGES.modified;
  const language = detectLanguage(path);

  const syntaxToggle = language ? `
    <span class="syntax-checkbox">
      <input type="checkbox"
             id="syntax-${fileId}"
             class="syntax-toggle"
             data-file-id="${fileId}"
             title="Toggle syntax highlighting"
             ${enableHighlighting ? 'checked' : ''}>
      <label for="syntax-${fileId}">Syntax</label>
    </span>
  ` : '';

  const fullFileCheckbox = `
    <span class="full-file-checkbox">
      <input type="checkbox"
             id="full-file-${fileId}"
             class="full-file-toggle"
             data-path="${escapeHtml(path)}"
             title="Show full file with diff context">
      <label for="full-file-${fileId}">Full file</label>
    </span>
  `;

  const isRenderable = /\.(md|adoc)$/i.test(path);
  const renderedCheckbox = isRenderable ? `
    <span class="rendered-checkbox">
      <input type="checkbox"
             id="rendered-${fileId}"
             class="rendered-toggle"
             data-path="${escapeHtml(path)}"
             title="Show rendered preview">
      <label for="rendered-${fileId}">Rendered</label>
    </span>
  ` : '';

  const reviewCheckbox = `
    <span class="file-review-checkbox">
      <input type="checkbox"
             id="file-reviewed-${fileId}"
             class="file-reviewed-toggle"
             data-path="${escapeHtml(path)}"
             data-file-sha="${escapeHtml(fileSha)}"
             ${isReviewed ? 'checked' : ''}
             autocomplete="off"
             title="Mark as reviewed">
      <label for="file-reviewed-${fileId}">Reviewed</label>
    </span>
  `;

  const attrs = `class="diff-file ${isReviewed ? 'file-reviewed' : ''}" data-file-id="${fileId}" data-path="${escapeHtml(path)}" data-sha="${headSha}" data-additions="${file.additions}" data-deletions="${file.deletions}"`;

  const summary = `
      <summary class="file-header" id="file-${fileId}">
        <span class="file-header-info">
          <span class="status-badge ${badge.class}">${badge.text}</span>
          <a class="file-path file-deep-link" href="#file-${fileId}" onclick="event.stopPropagation()" style="text-decoration: none; color: inherit;">
            <span class="file-directory">${escapeHtml(directory)}</span>
            <span class="file-name">${escapeHtml(filename)}</span>
          </a>
        </span>
        <span class="file-stats">${statsHtml}${syntaxToggle}${fullFileCheckbox}${renderedCheckbox}${reviewCheckbox}</span>
      </summary>`;

  return { attrs, summary };
}

// Render a lazy "shell" for a normal file: identical <details>/<summary> chrome as renderFile,
// but with an empty placeholder body and data-lazy="1". The diff body is fetched on demand
// (when the <details> is opened) from the /file-diff endpoint. Always rendered collapsed.
export function renderFileShell(
  file: DiffFile,
  fileId: string,
  headSha: string,
  isReviewed: boolean = false,
  enableHighlighting: boolean = false,
  fileSha: string = ''
): string {
  const { attrs, summary } = buildNormalFileChrome(
    file, fileId, isReviewed, enableHighlighting, fileSha, headSha
  );
  return `
    <details ${attrs} data-lazy="1">${summary}
      <div class="diff-content">
        <div class="diff-lazy-placeholder">Loading diff…</div>
      </div>
    </details>`;
}

// Render a file diff
export async function renderFile(
  file: DiffFile,
  fileId: string,
  headSha: string,
  owner: string,
  repo: string,
  prNumber: number,
  comments: Array<{
    id: number;
    user: { login: string; avatar_url: string };
    body: string;
    renderedBody: string;
    created_at: string;
    path: string;
    line: number | null;
    side: 'LEFT' | 'RIGHT';
    diff_hunk?: string;
  }> = [],
  isReviewed: boolean = false,
  enableHighlighting: boolean = false,
  fileSha: string = '',
  sources?: FileSources
): Promise<string> {
  const path = file.newPath || file.oldPath;
  const filename = path.split('/').pop() || path;
  const directory = path.substring(0, path.length - filename.length);

  // File stats
  const statsHtml = file.isBinary
    ? '<span class="file-stat binary">Binary</span>'
    : `<span class="file-stat additions">+${file.additions}</span>
       <span class="file-stat deletions">-${file.deletions}</span>`;

  // Status badge
  const badge = STATUS_BADGES[file.status] || STATUS_BADGES.modified;

  // Detect language for syntax highlighting
  const language = detectLanguage(path);

  // Syntax toggle checkbox (binary/empty files only show this toggle in their header)
  const syntaxToggle = language ? `
    <span class="syntax-checkbox">
      <input type="checkbox"
             id="syntax-${fileId}"
             class="syntax-toggle"
             data-file-id="${fileId}"
             title="Toggle syntax highlighting"
             ${enableHighlighting ? 'checked' : ''}>
      <label for="syntax-${fileId}">Syntax</label>
    </span>
  ` : '';

  // Review checkbox — collapses the diff when checked (via client-side JS)
  const reviewCheckbox = `
    <span class="file-review-checkbox">
      <input type="checkbox"
             id="file-reviewed-${fileId}"
             class="file-reviewed-toggle"
             data-path="${escapeHtml(path)}"
             data-file-sha="${escapeHtml(fileSha)}"
             ${isReviewed ? 'checked' : ''}
             autocomplete="off"
             title="Mark as reviewed">
      <label for="file-reviewed-${fileId}">Reviewed</label>
    </span>
  `;

  // Binary file
  if (file.isBinary) {
    return `
      <details class="diff-file ${isReviewed ? 'file-reviewed' : ''}" data-file-id="${fileId}" data-path="${escapeHtml(path)}" data-additions="${file.additions}" data-deletions="${file.deletions}" ${isReviewed ? '' : 'open'}>
        <summary class="file-header" id="file-${fileId}">
          <span class="file-header-info">
            <span class="status-badge ${badge.class}">${badge.text}</span>
            <span class="file-path">
              <span class="file-directory">${escapeHtml(directory)}</span>
              <span class="file-name">${escapeHtml(filename)}</span>
            </span>
          </span>
          <span class="file-stats">${statsHtml}${syntaxToggle}${reviewCheckbox}</span>
        </summary>
        <div class="diff-content">
          <div class="diff-binary-notice">Binary file not shown</div>
        </div>
      </details>`;
  }

  // Empty file
  if (file.hunks.length === 0) {
    return `
      <details class="diff-file ${isReviewed ? 'file-reviewed' : ''}" data-file-id="${fileId}" data-path="${escapeHtml(path)}" data-additions="${file.additions}" data-deletions="${file.deletions}" ${isReviewed ? '' : 'open'}>
        <summary class="file-header" id="file-${fileId}">
          <span class="file-header-info">
            <span class="status-badge ${badge.class}">${badge.text}</span>
            <span class="file-path">
              <span class="file-directory">${escapeHtml(directory)}</span>
              <span class="file-name">${escapeHtml(filename)}</span>
            </span>
          </span>
          <span class="file-stats">${statsHtml}${syntaxToggle}${reviewCheckbox}</span>
        </summary>
        <div class="diff-content">
          <div class="diff-empty-notice">No changes</div>
        </div>
      </details>`;
  }

  // Group comments by line and side for inline rendering
  const commentsByLineAndSide = new Map<string, typeof comments>();
  for (const comment of comments) {
    if (comment.line !== null) {
      const key = `${comment.side}-${comment.line}`;
      if (!commentsByLineAndSide.has(key)) {
        commentsByLineAndSide.set(key, []);
      }
      commentsByLineAndSide.get(key)!.push(comment);
    }
  }

  // Merge in synthetic hunks for orphaned comments (comments on lines outside visible hunks)
  const mergedHunks = injectOrphanedCommentHunks(file.hunks, comments);

  // One Shiki pass for the entire file, instead of one per line.
  const highlighted =
    enableHighlighting && language
      ? await buildHighlightMap(mergedHunks, language, sources)
      : null;

  // Render diff table
  let tableRows = '';
  for (const hunk of mergedHunks) {
    tableRows += renderHunkHeader(hunk.header);
    for (const line of hunk.lines) {
      tableRows += renderLine(line, fileId, path, headSha, owner, repo, prNumber, language, enableHighlighting, highlighted);

      // Render comments for this line
      const lineNumber = line.type === 'del' ? line.oldLineNum : line.newLineNum;
      const side = line.type === 'del' ? 'LEFT' : 'RIGHT';
      if (lineNumber !== null) {
        const key = `${side}-${lineNumber}`;
        const lineComments = commentsByLineAndSide.get(key);
        if (lineComments && lineComments.length > 0) {
          tableRows += renderInlineCommentThread(lineComments);
        }
      }
    }
  }

  const { attrs, summary } = buildNormalFileChrome(
    file, fileId, isReviewed, enableHighlighting, fileSha, headSha
  );
  return `
    <details ${attrs} ${isReviewed ? '' : 'open'}>${summary}
      <div class="diff-content">
        <table class="diff-table">
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    </details>`;
}

/**
 * Wrap an already-rendered diff table (from diff_cache) in the same <details> chrome
 * renderFile produces.
 *
 * The table body is expensive and depends only on (head SHA, file path); the chrome is
 * cheap but depends on per-user state (review status, syntax preference), so only the
 * table is cached. This lets a repeat page load skip parsing and syntax highlighting
 * entirely while still reflecting the current user's toggles.
 */
export function wrapCachedFileTable(
  file: DiffFile,
  fileId: string,
  isReviewed: boolean,
  enableHighlighting: boolean,
  fileSha: string,
  headSha: string,
  tableHtml: string
): string {
  const { attrs, summary } = buildNormalFileChrome(
    file, fileId, isReviewed, enableHighlighting, fileSha, headSha
  );
  return `
    <details ${attrs} ${isReviewed ? '' : 'open'}>${summary}
      <div class="diff-content">
        ${tableHtml}
      </div>
    </details>`;
}

/** Extract the diff table from a full renderFile() result, for storing in diff_cache. */
export function extractDiffTable(renderedHtml: string): string | null {
  const match = renderedHtml.match(/<table class="diff-table">[\s\S]*?<\/table>/);
  return match ? match[0] : null;
}

// Render file sidebar item
export function renderFileSidebarItem(file: DiffFile, fileId: string): string {
  const path = file.newPath || file.oldPath;
  const filename = path.split('/').pop() || path;
  const directory = path.substring(0, path.length - filename.length);

  const statsHtml = file.isBinary
    ? '<span class="sidebar-stat binary">bin</span>'
    : `<span class="sidebar-stat additions">+${file.additions}</span>
       <span class="sidebar-stat deletions">-${file.deletions}</span>`;

  return `
    <a href="#file-${fileId}" class="file-sidebar-item status-${file.status}" data-file-id="${fileId}">
      <span class="sidebar-file-path" title="${escapeHtml(path)}">
        ${directory ? `<span class="sidebar-dir">${escapeHtml(directory)}</span>` : ''}
        <span class="sidebar-name">${escapeHtml(filename)}</span>
      </span>
      <span class="sidebar-stats">${statsHtml}</span>
    </a>`;
}

// Inline comment form template (for JS-enhanced experience)
export function renderInlineCommentForm(): string {
  return `
    <template id="inline-comment-form-template">
      <tr class="inline-comment-form-row inline-comment-form-js">
        <td colspan="4">
          <form class="inline-comment-form" method="POST">
            <input type="hidden" name="path" value="">
            <input type="hidden" name="line" value="">
            <input type="hidden" name="side" value="">
            <input type="hidden" name="commit_id" value="">
            <textarea name="body" placeholder="Leave a comment..." rows="3" required class="comment-textarea"></textarea>
            <div class="comment-form-actions">
              <button type="button" class="btn btn-secondary btn-small cancel-inline-comment">Cancel</button>
              <button type="submit" class="btn btn-primary btn-small">Comment</button>
            </div>
          </form>
        </td>
      </tr>
    </template>`;
}

// Render inline comment thread (for displaying comments inline with diff lines)
function renderInlineCommentThread(
  comments: Array<{
    id: number;
    user: { login: string; avatar_url: string };
    body: string;
    renderedBody: string;
    created_at: string;
    line: number | null;
  }>
): string {
  const commentsHtml = comments
    .map((comment, index) => {
      const date = new Date(comment.created_at);
      const timeAgo = formatTimeAgo(date);

      // Escape body for data attribute (replace quotes and newlines)
      const escapedBody = comment.body
        .replace(/"/g, '&quot;')
        .replace(/\n/g, '\\n');

      // Only show reply buttons on the last comment in the thread
      const replyButtons = index === comments.length - 1 ? `
        <div class="inline-comment-actions">
          <button type="button" class="btn btn-small reply-to-comment"
                  data-author="${escapeHtml(comment.user.login)}"
                  data-comment-id="${comment.id}"
                  style="padding: 0.375rem 0.5rem; margin-right: 0.25rem;">
            Reply
          </button>
          <button type="button" class="btn btn-small reply-to-comment"
                  data-author="${escapeHtml(comment.user.login)}"
                  data-body="${escapedBody}"
                  data-comment-id="${comment.id}"
                  data-quote="true"
                  style="padding: 0.375rem 0.5rem;">
            💬
          </button>
        </div>` : '';

      return `
        <div class="inline-comment" id="comment-${comment.id}" data-comment-id="${comment.id}">
          <div class="inline-comment-header">
            <img src="${escapeHtml(comment.user.avatar_url)}" alt="${escapeHtml(comment.user.login)}" class="comment-avatar">
            <span class="comment-author">${escapeHtml(comment.user.login)}</span>
            <span class="comment-time" title="${date.toISOString()}">${timeAgo}</span>
          </div>
          <div class="inline-comment-body markdown-body">${comment.renderedBody}</div>
          ${replyButtons}
        </div>`;
    })
    .join('');

  return `
    <tr class="comment-thread-row">
      <td colspan="4">
        <div class="comment-thread">${commentsHtml}</div>
      </td>
    </tr>`;
}

// Comment thread renderer
export function renderCommentThread(
  comments: Array<{
    id: number;
    user: { login: string; avatar_url: string };
    body: string;
    created_at: string;
    path: string;
    line: number | null;
    side: string;
  }>,
  owner: string,
  repo: string,
  prNumber: number
): string {
  const rendered = comments
    .map((comment) => {
      const date = new Date(comment.created_at);
      const timeAgo = formatTimeAgo(date);
      return `
        <div class="comment" data-comment-id="${comment.id}">
          <div class="comment-header">
            <img src="${escapeHtml(comment.user.avatar_url)}" alt="${escapeHtml(comment.user.login)}" class="comment-avatar">
            <span class="comment-author">${escapeHtml(comment.user.login)}</span>
            <span class="comment-time" title="${date.toISOString()}">${timeAgo}</span>
          </div>
          <div class="comment-body">${escapeHtml(comment.body)}</div>
        </div>`;
    })
    .join('');

  const replyForm = `
    <form class="reply-form" method="POST" action="/pr/${owner}/${repo}/${prNumber}/reply">
      <input type="hidden" name="comment_id" value="${comments[0]?.id || ''}">
      <textarea name="body" placeholder="Reply..." rows="2" class="comment-textarea"></textarea>
      <div class="comment-form-actions">
        <button type="submit" class="btn btn-small">Reply</button>
      </div>
    </form>`;

  return `
    <tr class="comment-thread-row">
      <td colspan="4">
        <div class="comment-thread">${rendered}${replyForm}</div>
      </td>
    </tr>`;
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// Render a simple diff hunk (for conversation tab)
export function renderSimpleHunk(hunk: import('./diff-parser.js').DiffHunk): string {
  const rows = hunk.lines.map(line => {
    const contentType = line.type as ContentLineType;
    const lineClass = LINE_TYPE_CLASSES[contentType];
    const oldNum = line.oldLineNum ?? '';
    const newNum = line.newLineNum ?? '';
    const prefix = LINE_TYPE_PREFIXES[contentType];

    return `
      <tr class="diff-line ${lineClass}">
        <td class="diff-line-num diff-line-num-old">${oldNum}</td>
        <td class="diff-line-num diff-line-num-new">${newNum}</td>
        <td class="diff-line-content"><span class="diff-line-prefix">${prefix}</span>${escapeHtml(line.content)}</td>
      </tr>`;
  }).join('');

  return `
    <div class="diff-hunk-simple">
      <table class="diff-table">
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>`;
}

/**
 * Render directory tree with collapsible sections
 */
export function renderDirectoryTree(
  node: import('./file-tree-builder.js').DirectoryNode | import('./file-tree-builder.js').FileNode,
  depth: number = 0
): string {
  if (node.type === 'file') {
    // Render file
    return node.fileData.renderedHtml || '';
  }

  // Directory node
  if (depth === 0) {
    // Root: render children directly without a wrapper
    return Array.from(node.children.values())
      .map(child => renderDirectoryTree(child, depth + 1))
      .join('\n');
  }

  const { name, stats, path } = node;
  const childrenHtml = Array.from(node.children.values())
    .map(child => renderDirectoryTree(child, depth + 1))
    .join('\n');

  return `
    <details class="diff-directory" open data-path="${escapeHtml(path)}">
      <summary class="directory-header">
        <span class="dir-icon">▶</span>
        <span class="dir-name">${escapeHtml(name)}/</span>
        <span class="dir-stats">
          ${stats.totalFiles} ${stats.totalFiles === 1 ? 'file' : 'files'}
          <span class="additions">+${stats.additions}</span>
          <span class="deletions">-${stats.deletions}</span>
        </span>
        <span class="dir-controls">
          <label class="dir-checkbox">
            <input type="checkbox" class="dir-collapse-toggle" data-path="${escapeHtml(path)}">
            Collapsed
          </label>
          <label class="dir-checkbox">
            <input type="checkbox" class="dir-review-all-toggle" data-path="${escapeHtml(path)}">
            Review all
          </label>
        </span>
      </summary>
      <div class="directory-children">
        ${childrenHtml}
      </div>
    </details>`;
}
