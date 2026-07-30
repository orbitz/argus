/**
 * Syntax Highlighter using Shiki
 * Provides server-side syntax highlighting for code diffs
 */

import { createHighlighter, type Highlighter } from 'shiki';
import { bump } from './perf-counters.js';

let highlighterInstance: Highlighter | null = null;

/**
 * Get or create the Shiki highlighter instance (singleton)
 */
export async function getHighlighterInstance(): Promise<Highlighter> {
  if (!highlighterInstance) {
    highlighterInstance = await createHighlighter({
      themes: ['github-light'],
      langs: [
        'javascript',
        'typescript',
        'python',
        'java',
        'go',
        'rust',
        'c',
        'cpp',
        'csharp',
        'ruby',
        'php',
        'html',
        'css',
        'json',
        'yaml',
        'markdown',
        'shell',
        'sql',
        'bash',
        'dockerfile',
        'xml',
        'ocaml',
      ],
    });
  }
  return highlighterInstance;
}

/**
 * Detect programming language from file extension
 */
export function detectLanguage(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return null;

  const languageMap: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    java: 'java',
    go: 'go',
    rs: 'rust',
    c: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'css',
    sass: 'css',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    sh: 'shell',
    bash: 'bash',
    sql: 'sql',
    dockerfile: 'dockerfile',
    xml: 'xml',
    ml: 'ocaml',
    mli: 'ocaml',
  };

  return languageMap[ext] || null;
}

// Shiki's FontStyle bitflags (not exported from the package root).
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

function tokenStyle(color: string | undefined, fontStyle: number | undefined): string {
  const parts: string[] = [];
  if (color) parts.push(`color:${color}`);
  if (fontStyle && fontStyle > 0) {
    if (fontStyle & FONT_STYLE_ITALIC) parts.push('font-style:italic');
    if (fontStyle & FONT_STYLE_BOLD) parts.push('font-weight:bold');
    if (fontStyle & FONT_STYLE_UNDERLINE) parts.push('text-decoration:underline');
  }
  return parts.join(';');
}

/**
 * Highlight many lines in a single Shiki pass, returning one HTML string per input line.
 *
 * This replaces a per-line codeToHtml() call, which was both the dominant CPU cost of
 * rendering a diff and *less accurate*: tokenizing each line in isolation gives the
 * grammar no context, so multi-line strings, template literals and block comments were
 * highlighted wrongly.
 *
 * The lines are tokenized as one contiguous document, so callers must only pass lines that
 * really are contiguous in the source. Handing this the concatenation of several diff hunks
 * makes the grammar step straight over the elided regions between them: a block comment
 * opened in one hunk and closed in the gap never gets closed, and every following hunk comes
 * back coloured as comment. Prefer highlightSource() with the real file whenever it is
 * available; use this only for a single contiguous run.
 */
export async function highlightLines(lines: string[], lang: string): Promise<string[]> {
  if (lines.length === 0) return [];

  try {
    const highlighter = await getHighlighterInstance();
    if (!highlighter.getLoadedLanguages().includes(lang as any)) {
      return lines.map(escapeHtml);
    }

    // codeToTokens is synchronous CPU work — this span is the real highlighting cost, and it
    // blocks the event loop, so no amount of Promise.all around callers parallelizes it.
    const tokenizeStart = performance.now();
    const { tokens } = highlighter.codeToTokens(lines.join('\n'), {
      lang: lang as any,
      theme: 'github-light',
    });
    bump('shikiMs', performance.now() - tokenizeStart);
    bump('shikiCalls', 1);
    bump('linesTokenized', lines.length);

    // codeToTokens yields one token array per line (empty array for a blank line).
    return lines.map((line, i) => {
      const lineTokens = tokens[i];
      if (!lineTokens) return escapeHtml(line); // defensive: line-count mismatch
      return lineTokens
        .map((t) => {
          const style = tokenStyle(t.color, t.fontStyle);
          const content = escapeHtml(t.content);
          return style ? `<span style="${style}">${content}</span>` : content;
        })
        .join('');
    });
  } catch (err) {
    console.error('Batch syntax highlighting failed:', err);
    return lines.map(escapeHtml);
  }
}

/**
 * Highlight a whole source file, returning one HTML string per line, indexable by
 * (1-based line number - 1).
 *
 * Unlike highlightLines this is guaranteed gap-free, which is the whole point: it is the
 * only way to colour a diff line the way it would look in the real file, both for a
 * construct whose terminator was elided and for a hunk that starts inside one.
 */
export async function highlightSource(source: string, lang: string): Promise<string[]> {
  return highlightLines(source.split('\n'), lang);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
