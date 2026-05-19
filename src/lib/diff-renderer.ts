import { DiffFile, DiffLine, DiffHunk, parseHunkString } from './diff-parser.js';
import { detectLanguage, highlightCode } from './syntax-highlighter.js';

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

// Render a single diff line
async function renderLine(
  line: DiffLine,
  fileId: string,
  path: string,
  headSha: string,
  owner: string,
  repo: string,
  prNumber: number,
  language: string | null,
  enableHighlighting: boolean
): Promise<string> {
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

  // Apply syntax highlighting if enabled
  let contentHtml = escapeHtml(line.content);
  if (enableHighlighting && language) {
    try {
      contentHtml = await highlightCode(line.content, language);
    } catch (err) {
      // Fall back to escaped HTML on error
      contentHtml = escapeHtml(line.content);
    }
  }

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
    </tr>
    ${commentLine ? renderInlineCommentFormRow(formId, path, commentLine, commentSide, headSha, owner, repo, prNumber) : ''}`;
}

// Render inline comment form row (hidden by default, shown via CSS :target)
function renderInlineCommentFormRow(
  formId: string,
  path: string,
  line: number,
  side: string,
  headSha: string,
  owner: string,
  repo: string,
  prNumber: number
): string {
  return `
    <tr class="inline-comment-form-row" id="${formId}">
      <td colspan="4">
        <form class="inline-comment-form" method="POST" action="/pr/${owner}/${repo}/${prNumber}/inline-comment">
          <input type="hidden" name="path" value="${escapeHtml(path)}">
          <input type="hidden" name="line" value="${line}">
          <input type="hidden" name="side" value="${side}">
          <input type="hidden" name="commit_id" value="${headSha}">
          <div class="comment-form-header">
            <span class="comment-form-file">${escapeHtml(path)}:${line}</span>
            <a href="#f${path.replace(/[^a-zA-Z0-9]/g, '-')}-close" class="comment-form-close">&times;</a>
          </div>
          <textarea name="body" placeholder="Leave a comment..." rows="3" required class="comment-textarea"></textarea>
          <div class="comment-form-actions">
            <a href="#" class="btn btn-secondary btn-small">Cancel</a>
            <button type="submit" class="btn btn-primary btn-small">Comment</button>
          </div>
        </form>
      </td>
    </tr>`;
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
  fileSha: string = ''
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
  const statusBadges: Record<string, { class: string; text: string }> = {
    added: { class: 'badge-added', text: 'A' },
    deleted: { class: 'badge-deleted', text: 'D' },
    modified: { class: 'badge-modified', text: 'M' },
    renamed: { class: 'badge-renamed', text: 'R' },
  };
  const badge = statusBadges[file.status] || statusBadges.modified;

  // Detect language for syntax highlighting
  const language = detectLanguage(path);

  // Syntax toggle checkbox
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

  // Full file toggle checkbox
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

  // Rendered preview checkbox for markdown/asciidoc files
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

  // Render diff table (await async renderLine calls)
  let tableRows = '';
  for (const hunk of mergedHunks) {
    tableRows += renderHunkHeader(hunk.header);
    for (const line of hunk.lines) {
      tableRows += await renderLine(line, fileId, path, headSha, owner, repo, prNumber, language, enableHighlighting);

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

  return `
    <details class="diff-file ${isReviewed ? 'file-reviewed' : ''}" data-file-id="${fileId}" data-path="${escapeHtml(path)}" data-sha="${headSha}" data-additions="${file.additions}" data-deletions="${file.deletions}" ${isReviewed ? '' : 'open'}>
      <summary class="file-header" id="file-${fileId}">
        <span class="file-header-info">
          <span class="status-badge ${badge.class}">${badge.text}</span>
          <a class="file-path file-deep-link" href="#file-${fileId}" onclick="event.stopPropagation()" style="text-decoration: none; color: inherit;">
            <span class="file-directory">${escapeHtml(directory)}</span>
            <span class="file-name">${escapeHtml(filename)}</span>
          </a>
        </span>
        <span class="file-stats">${statsHtml}${syntaxToggle}${fullFileCheckbox}${renderedCheckbox}${reviewCheckbox}</span>
      </summary>
      <div class="diff-content">
        <table class="diff-table">
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    </details>`;
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
