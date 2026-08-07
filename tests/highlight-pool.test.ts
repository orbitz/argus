import { describe, it, expect } from 'vitest';
import { highlightOnWorker } from '../src/lib/highlight-pool.js';
import { highlightLines, getHighlighterInstance } from '../src/lib/syntax-highlighter.js';
import { THEME, tokensToLineHtml } from '../src/lib/highlight-core.js';

/**
 * The pool is designed to fail soft: if a worker can't spawn or can't resolve its imports,
 * highlighting silently falls back in-process and the only symptom is that the render is
 * slow again. That makes it exactly the thing worth asserting on — nothing else would notice.
 */
describe('highlight pool', () => {
  const SOURCE = [
    'const greeting: string = "hello";',
    '/* a block comment',
    '   spanning lines */',
    'function add(a: number, b: number) {',
    '  return a + b; // trailing',
    '}',
  ];

  async function inProcess(lines: string[], lang: string): Promise<string[]> {
    const highlighter = await getHighlighterInstance();
    const { tokens } = highlighter.codeToTokens(lines.join('\n'), {
      lang: lang as any,
      theme: THEME,
    });
    return tokensToLineHtml(lines, tokens);
  }

  it('spawns a worker and highlights on it', async () => {
    const { html } = await highlightOnWorker(SOURCE, 'typescript');
    expect(html).toHaveLength(SOURCE.length);
    expect(html[0]).toContain('<span style="color:');
  }, 30000);

  it('produces byte-identical output to highlighting in-process', async () => {
    const [{ html }, expected] = await Promise.all([
      highlightOnWorker(SOURCE, 'typescript'),
      inProcess(SOURCE, 'typescript'),
    ]);
    expect(html).toEqual(expected);
  }, 30000);

  it('rejects an unknown language so the caller falls back rather than rendering wrong', async () => {
    await expect(highlightOnWorker(SOURCE, 'not-a-language')).rejects.toThrow();
  }, 30000);

  it('keeps concurrent callers on a single shared highlighter', async () => {
    // Caching the resolved instance instead of the promise let every concurrent caller start
    // its own createHighlighter, which exhausted Oniguruma's WASM heap and dropped the whole
    // render back to unhighlighted text.
    const instances = await Promise.all(
      Array.from({ length: 8 }, () => getHighlighterInstance())
    );
    for (const instance of instances) expect(instance).toBe(instances[0]);
  }, 30000);

  it('highlights short runs without a worker, matching the worker output', async () => {
    // Below the worker threshold highlightLines stays in-process; both paths must agree.
    const short = SOURCE.slice(0, 2);
    expect(await highlightLines(short, 'typescript')).toEqual(await inProcess(short, 'typescript'));
  }, 30000);

  it('escapes an unknown language plainly instead of throwing', async () => {
    expect(await highlightLines(['a < b && c > d'], 'not-a-language')).toEqual([
      'a &lt; b &amp;&amp; c &gt; d',
    ]);
  }, 30000);
});
