/**
 * Pieces shared by the in-process highlighter and the worker-thread pool.
 *
 * Kept free of any worker_threads or perf-counter imports so the worker can load it without
 * dragging in the server's module graph.
 */

export const THEME = 'github-light';

export const HIGHLIGHT_LANGS = [
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
] as const;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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

/** Turn Shiki's per-line token arrays into one HTML string per input line. */
export function tokensToLineHtml(
  lines: string[],
  tokens: Array<Array<{ content: string; color?: string; fontStyle?: number }>>
): string[] {
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
}
