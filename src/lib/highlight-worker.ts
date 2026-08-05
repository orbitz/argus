/**
 * Worker-thread side of the syntax-highlighting pool.
 *
 * Owns its own Shiki highlighter and turns {lines, lang} into one HTML string per line.
 * Returning finished HTML rather than token objects is deliberate: only flat strings cross
 * the thread boundary (cheap to structured-clone), and the escaping and <span> assembly —
 * the other per-line cost — moves off the main thread along with the tokenizing.
 *
 * Note the shared helpers arrive by dynamic import of a URL the pool resolved for us, rather
 * than a static `./highlight-core.js`. Under the dev runner a worker gets tsx's transpiler
 * but not its `.js`-means-`.ts` resolution, so that specifier is looked up literally and the
 * worker dies on a missing module. The parent already knows which extension is real (it had
 * to pick one to spawn this file), so it just tells us.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { createHighlighter, type Highlighter } from 'shiki';
import type * as HighlightCore from './highlight-core.js';

if (!parentPort) throw new Error('highlight-worker must be run as a worker thread');
const port = parentPort;

export interface HighlightRequest {
  id: number;
  lines: string[];
  lang: string;
}

const core: typeof HighlightCore = await import((workerData as { coreUrl: string }).coreUrl);

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    // No grammars up front. Loading all 22 costs ~74MB per worker, and multiplied across the
    // pool that dwarfed everything else the process holds — while a given PR almost always
    // touches one or two languages. Each worker instead pays for what it is actually asked
    // to highlight, once.
    highlighterPromise = createHighlighter({ themes: [core.THEME], langs: [] });
  }
  return highlighterPromise;
}

const loaded = new Map<string, Promise<void>>();

async function ensureLanguage(highlighter: Highlighter, lang: string): Promise<void> {
  let pending = loaded.get(lang);
  if (!pending) {
    // Cache the promise, not its completion: two requests for the same new language arrive
    // back to back and must not both start a load.
    pending = highlighter.loadLanguage(lang as any).then(() => undefined);
    loaded.set(lang, pending);
    pending.catch(() => loaded.delete(lang));
  }
  return pending;
}

port.on('message', async (req: HighlightRequest) => {
  try {
    const highlighter = await getHighlighter();
    if (!core.HIGHLIGHT_LANGS.includes(req.lang as any)) {
      // Unsupported language: the parent escapes plainly, same as the inline path.
      port.postMessage({ id: req.id, error: `unsupported language: ${req.lang}` });
      return;
    }
    await ensureLanguage(highlighter, req.lang);
    const start = performance.now();
    const { tokens } = highlighter.codeToTokens(req.lines.join('\n'), {
      lang: req.lang as any,
      theme: core.THEME,
    });
    const html = core.tokensToLineHtml(req.lines, tokens);
    port.postMessage({ id: req.id, html, ms: performance.now() - start, ready: true });
  } catch (err: any) {
    port.postMessage({ id: req.id, error: err?.message || String(err) });
  }
});

// Tell the parent this worker booted. The pool uses this only to know spawning succeeded;
// the highlighter itself is still built lazily on the first real request.
port.postMessage({ id: -1, html: [], ms: 0, ready: true });
