import path from 'node:path';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { nameToEmoji } from 'gemoji';
import { getHighlighterInstance } from './syntax-highlighter.js';
import { bump } from './perf-counters.js';

// Configure marked for safe rendering with GitHub-flavored markdown
// NOTE: Async work (syntax highlighting) is done in walkTokens, which runs
// before the synchronous parse step. Renderers must be synchronous.
marked.use({
  gfm: true,
  breaks: true,
});

// Async extension: use walkTokens for async work, keep renderers synchronous
marked.use({
  async: true,
  async walkTokens(token: any) {
    if (token.type === 'code' && token.lang) {
      try {
        const highlighter = await getHighlighterInstance();
        const loadedLanguages = highlighter.getLoadedLanguages();
        if (loadedLanguages.includes(token.lang as any)) {
          // Counted alongside diff highlighting: a PR with many fenced code blocks in its
          // comments pays real Shiki time here, and it is not cached anywhere.
          const start = performance.now();
          token._highlighted = highlighter.codeToHtml(token.text, {
            lang: token.lang,
            theme: 'github-light',
          });
          bump('shikiMs', performance.now() - start);
          bump('shikiCalls', 1);
          bump('linesTokenized', token.text.split('\n').length);
        }
      } catch (err) {
        console.error('Markdown code highlighting failed:', err);
      }
    }
  },
  renderer: {
    link({ href, title, tokens }: any) {
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href ?? '')}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    // `text` is the item's raw markdown source, so emitting it left every list item
    // unformatted — "- **bold** and `code`" rendered with the asterisks and backticks
    // showing. The item's parsed tokens are what the body should come from; parse()
    // handles loose items and nested blocks, which parseInline() would flatten.
    listitem(item: any) {
      const body = item.tokens?.length
        ? this.parser.parse(item.tokens, !!item.loose)
        : item.text;

      if (item.task) {
        const checkbox = item.checked
          ? '<input type="checkbox" checked disabled>'
          : '<input type="checkbox" disabled>';
        return `<li class="task-list-item">${checkbox} ${body}</li>`;
      }
      return `<li>${body}</li>`;
    },
    code({ text, lang, _highlighted }: any) {
      if (_highlighted) return _highlighted;
      if (lang) {
        return `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(text)}</code></pre>`;
      }
      return `<pre><code>${escapeHtml(text)}</code></pre>`;
    },
  },
});

// Convert emoji shortcodes to actual emoji
function convertEmoji(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/g, (match, name) => {
    return nameToEmoji[name] || match;
  });
}

// Render markdown to HTML

/**
 * Markdown from GitHub is untrusted input.
 *
 * `marked` passes raw HTML straight through — it dropped its own sanitiser in v5 and
 * points at a real one instead — so a pull request body, an issue, or any comment could
 * put arbitrary elements into an Argus page. That is not theoretical: a PR description
 * containing the text `<style>` opened a real style element, and the browser swallowed
 * the rest of the document as CSS, taking the merge button and the tab handlers with it.
 * The same hole accepts <script>, an <img onerror=...>, or a javascript: link — inside a
 * page that can POST merges and comments with the reader's token.
 *
 * So the rendered HTML is filtered to what GitHub's own markdown produces: formatting,
 * links, code, tables, task lists, and the couple of raw tags GitHub itself permits.
 */
const ALLOWED_STYLE = { '*': { color: [/^#[0-9a-f]{3,8}$/i, /^rgb/], 'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgb/], 'font-weight': [/^\w+$/], 'font-style': [/^\w+$/], 'text-decoration': [/^[\w-]+$/] } };

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'hr', 'div', 'span',
    'strong', 'b', 'em', 'i', 'del', 's', 'sup', 'sub', 'kbd', 'mark',
    'a', 'img',
    'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'input',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'details', 'summary',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    // Shiki emits inline colours on spans; the class hooks GitHub-flavoured styling.
    span: ['class', 'style'],
    code: ['class', 'style'],
    pre: ['class', 'style'],
    div: ['class'],
    li: ['class'],
    ul: ['class'],
    ol: ['start'],
    // Task-list checkboxes, which are rendered disabled.
    input: ['type', 'checked', 'disabled'],
    td: ['align'],
    th: ['align'],
    details: ['open'],
  },
  allowedStyles: ALLOWED_STYLE as any,
  // No javascript:, no data: documents. Images may still be data: URIs, which are inert.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false,
  // Anything not on the list is dropped, but its text is kept — so a description that
  // mentions <style> reads as the words it wrote rather than vanishing.
  disallowedTagsMode: 'escape',
};

/**
 * Neutralise the tags that swallow a document.
 *
 * CommonMark treats <style>, <script>, <textarea> and <pre> as "type 1" HTML blocks: once
 * one opens, everything up to its closing tag is raw HTML, and if the closing tag never
 * arrives that is the rest of the document. A PR description that merely mentions <style>
 * therefore stopped markdown parsing dead and, downstream, opened a real style element in
 * the page. Sanitising the output makes that safe; it does not make it render, because by
 * then the markdown after it has already been abandoned.
 *
 * The opening bracket is swapped for a sentinel before parsing and restored as a proper
 * entity after sanitising. Escaping it up front instead would double-escape — marked turns
 * the & of &lt; into &amp;, and the reader sees "&lt;style>" inside their code span.
 *
 * Tags GitHub genuinely supports (<details>, <summary>, <img>) are untouched.
 */
const LT_SENTINEL = '\uE000';

function escapeDocumentSwallowingTags(markdown: string): string {
  return markdown
    // Strip any pre-existing sentinel so content cannot forge one.
    .split(LT_SENTINEL)
    .join('')
    .replace(/<(\/?)(style|script|textarea|pre)\b/gi, `${LT_SENTINEL}$1$2`);
}

function restoreEscapedTags(html: string): string {
  return html.split(LT_SENTINEL).join('&lt;');
}

export function sanitizeRenderedHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

export async function renderMarkdown(markdown: string | null | undefined): Promise<string> {
  if (!markdown) return '';

  try {
    // Convert emoji shortcodes (like :thumbsup:) to emoji before markdown processing
    const withEmoji = convertEmoji(escapeDocumentSwallowingTags(markdown));
    return restoreEscapedTags(sanitizeRenderedHtml((await marked(withEmoji)) as string));
  } catch (err) {
    console.error('Markdown rendering error:', err);
    return escapeHtml(markdown);
  }
}

// Escape HTML for plain text display
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Truncate text with ellipsis
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

// MIME types for image extensions that can be inlined as data: URIs
const IMG_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

// Inline relative <img src> values as base64 data: URIs. `fetchImage` returns
// the raw bytes for a repo-relative path (or null to leave the <img> as-is).
// Absolute (http://, https://, //) and existing data: URLs are untouched.
export async function inlineRelativeImages(
  html: string,
  baseDir: string,
  fetchImage: (repoPath: string) => Promise<Buffer | null>
): Promise<string> {
  const re = /<img\b[^>]*\bsrc="([^"]*)"[^>]*>/gi;

  const relPaths = new Set<string>();
  for (const m of html.matchAll(re)) {
    const src = m[1];
    if (/^(https?:)?\/\//i.test(src) || /^data:/i.test(src)) continue;
    relPaths.add(src);
  }

  // Resolve + fetch each unique relative path once, in parallel.
  const dataUris = new Map<string, string>();
  await Promise.all(
    [...relPaths].map(async (src) => {
      const repoPath = path.posix
        .normalize(path.posix.join(baseDir, src))
        .replace(/^(\.\.\/)+/, '');
      const mime = IMG_MIME[path.posix.extname(repoPath).toLowerCase()];
      if (!mime) return;
      const buf = await fetchImage(repoPath);
      if (!buf) return;
      dataUris.set(src, `data:${mime};base64,${buf.toString('base64')}`);
    })
  );

  return html.replace(re, (tag, src) => {
    const uri = dataUris.get(src);
    return uri ? tag.replace(`src="${src}"`, `src="${uri}"`) : tag;
  });
}
