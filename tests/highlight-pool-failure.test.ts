import { describe, it, expect } from 'vitest';
import { warmHighlightPool, __workersForTest } from '../src/lib/highlight-pool.js';
import { highlightLines } from '../src/lib/syntax-highlighter.js';

/**
 * Killing the pool permanently disables it for the whole module, so this lives in its own
 * file: vitest gives each test file a fresh module registry, and the surviving-pool tests in
 * highlight-pool.test.ts would otherwise run against a corpse.
 */
describe('highlight pool failure handling', () => {
  it('settles every caller when the workers die mid-flight', async () => {
    const source = Array.from({ length: 200 }, (_, i) => `const value${i}: number = ${i};`);

    warmHighlightPool();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const inflight = Promise.all(
      Array.from({ length: 12 }, () => highlightLines(source, 'typescript'))
    );

    // Kill everything while those calls are queued or running. The dangerous outcome is not a
    // rejection but a hang: a queued job with no worker left to run it never settles, and the
    // request behind it never responds.
    setTimeout(() => {
      for (const entry of __workersForTest()) void entry.worker.terminate();
    }, 50);

    const results = await inflight;

    expect(results).toHaveLength(12);
    // Every call still produced correct output, via the in-process fallback.
    for (const lines of results) {
      expect(lines).toHaveLength(source.length);
      expect(lines[0]).toContain('<span style="color:');
    }
  }, 60000);
});
