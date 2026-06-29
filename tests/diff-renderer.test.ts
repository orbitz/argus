import { describe, it, expect } from 'vitest';
import { renderFile, renderFileShell } from '../src/lib/diff-renderer.js';
import { parsePatch } from '../src/lib/diff-parser.js';

const PATCH = `@@ -1,3 +1,4 @@
 line 1
+new line
 line 2
 line 3
`;

describe('diff-renderer', () => {
  describe('renderFileShell', () => {
    it('renders a collapsed lazy shell with the same chrome as the full render', async () => {
      const file = parsePatch(PATCH, 'src/foo.ts', 'modified');
      const shell = renderFileShell(file, 'src-foo-ts', 'abc123', false, false, 'sha1');

      // Shell is marked lazy, collapsed (no `open`), and has only a placeholder body.
      expect(shell).toContain('data-lazy="1"');
      expect(shell).toContain('class="diff-lazy-placeholder"');
      expect(shell).not.toContain('<table class="diff-table">');
      expect(shell).not.toMatch(/<details[^>]*\sopen[>\s]/);

      // Chrome that the sidebar / go-to-file / review toggles key off is present and matches.
      expect(shell).toContain('data-file-id="src-foo-ts"');
      expect(shell).toContain('data-path="src/foo.ts"');
      expect(shell).toContain('data-additions="1"');
      expect(shell).toContain('data-deletions="0"');
      expect(shell).toContain('class="file-reviewed-toggle"');
      expect(shell).toContain('id="file-src-foo-ts"');
    });

    it('produces a header byte-identical to renderFile (minus the open attr and body)', async () => {
      const file = parsePatch(PATCH, 'src/foo.ts', 'modified');
      const full = await renderFile(file, 'src-foo-ts', 'abc123', 'o', 'r', 1, [], false, false, 'sha1');
      const shell = renderFileShell(file, 'src-foo-ts', 'abc123', false, false, 'sha1');

      const summaryOf = (html: string) => html.slice(html.indexOf('<summary'), html.indexOf('</summary>'));
      expect(summaryOf(shell)).toBe(summaryOf(full));
    });
  });

  describe('renderFile', () => {
    it('no longer bakes a per-line inline comment form into the diff body', async () => {
      const file = parsePatch(PATCH, 'src/foo.ts', 'modified');
      const html = await renderFile(file, 'src-foo-ts', 'abc123', 'o', 'r', 1, [], false, false, 'sha1');

      // The heavy per-line <form>/<textarea> is gone; the comment "+" affordance remains.
      expect(html).not.toContain('inline-comment-form-row');
      expect(html).not.toContain('<textarea');
      expect(html).toContain('line-comment-btn');
    });
  });
});
