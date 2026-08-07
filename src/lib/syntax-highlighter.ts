/**
 * Syntax Highlighter using Shiki
 * Provides server-side syntax highlighting for code diffs
 */

import { createHighlighter, type Highlighter } from 'shiki';
import { bump } from './perf-counters.js';
import { HIGHLIGHT_LANGS, THEME, escapeHtml, tokensToLineHtml } from './highlight-core.js';
import { highlightOnWorker, poolAvailable } from './highlight-pool.js';

/**
 * The in-flight or settled creation, not the resolved highlighter.
 *
 * Caching the instance instead leaves a window between the first call and its await in which
 * every other caller still sees null and starts its own createHighlighter. That was harmless
 * while diffs rendered one file at a time; now that they render concurrently it meant a
 * highlighter per file, and enough of them to exhaust Oniguruma's WASM heap outright
 * ("fail to memory allocation") — after which every file fell back to unhighlighted text.
 */
let highlighterPromise: Promise<Highlighter> | null = null;

/**
 * Get or create the Shiki highlighter instance (singleton)
 */
export function getHighlighterInstance(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [THEME],
      langs: [...HIGHLIGHT_LANGS],
    }).catch((err) => {
      // Don't cache a failure: a transient one would otherwise poison every later render.
      highlighterPromise = null;
      throw err;
    });
  }
  return highlighterPromise;
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

/**
 * Below this many lines, the thread hop and structured-clone cost more than just tokenizing
 * here. Small isolated hunks stay in-process; whole-file context passes go to the pool.
 */
const WORKER_MIN_LINES = 40;

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
 * back coloured as comment. Prefer a real file's lines whenever they are available; use this
 * on hunk contents only for a single contiguous run.
 *
 * A *prefix* of a file is fine, and is what buildHighlightMap passes: grammar state flows
 * forward only, so truncating after the last line the caller needs cannot change any line
 * before it.
 */
export async function highlightLines(lines: string[], lang: string): Promise<string[]> {
  if (lines.length === 0) return [];

  bump('shikiCalls', 1);
  bump('linesTokenized', lines.length);

  if (lines.length >= WORKER_MIN_LINES && poolAvailable()) {
    try {
      const { html, ms } = await highlightOnWorker(lines, lang);
      // Bumped here rather than in the pool so AsyncLocalStorage attributes it to the request
      // that asked. It is CPU time summed across threads, so once the pool is doing its job
      // shikiMs legitimately exceeds the wall clock; shikiMs/renderFilesMs is the speedup.
      bump('shikiMs', ms);
      return html;
    } catch {
      // Pool unavailable, worker died, or unknown language — fall through and do it here.
    }
  }

  return highlightInProcess(lines, lang);
}

async function highlightInProcess(lines: string[], lang: string): Promise<string[]> {
  try {
    const highlighter = await getHighlighterInstance();
    if (!highlighter.getLoadedLanguages().includes(lang as any)) {
      return lines.map(escapeHtml);
    }

    // codeToTokens is synchronous CPU work, and on this thread it blocks the event loop —
    // which is exactly why the bulk of it is handed to the worker pool above.
    const tokenizeStart = performance.now();
    const { tokens } = highlighter.codeToTokens(lines.join('\n'), {
      lang: lang as any,
      theme: THEME,
    });
    bump('shikiMs', performance.now() - tokenizeStart);

    // codeToTokens yields one token array per line (empty array for a blank line).
    return tokensToLineHtml(lines, tokens);
  } catch (err) {
    console.error('Batch syntax highlighting failed:', err);
    return lines.map(escapeHtml);
  }
}
