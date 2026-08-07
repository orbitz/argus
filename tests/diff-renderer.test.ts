import { describe, it, expect } from 'vitest';
import { renderFile, renderFileShell, sourcesFromFullContextPatch } from '../src/lib/diff-renderer.js';
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

  describe('syntax highlighting across elided regions', () => {
    // A file whose block comment opens inside the first hunk and closes in the region the
    // diff elides, before the second hunk picks up again.
    //
    //   1  const a = …;
    //   2  /* opening comment
    //   3     still comment
    //   4     still comment          <- hunk 1 stops here
    //   5  */                        <- the terminator, never shown
    //   6  const b = …;              <- hunk 2 starts here
    //   7  const c = 3;
    //   8  const d = 4;
    const GAPPED_PATCH = [
      '@@ -1,3 +1,3 @@',
      '-const a = 0;',
      '+const a = 1;',
      ' /* opening comment',
      '    still comment',
      '@@ -6,3 +6,3 @@',
      '-const b = 1;',
      '+const b = 2;',
      ' const c = 3;',
      ' const d = 4;',
      '',
    ].join('\n');

    const fileAt = (a: string, b: string) => [
      `const a = ${a};`,
      '/* opening comment',
      '   still comment',
      '   still comment',
      '*/',
      `const b = ${b};`,
      'const c = 3;',
      'const d = 4;',
    ].join('\n');

    const GAPPED_SOURCES = { oldSource: fileAt('0', '1'), newSource: fileAt('1', '2') };

    const render = (patch: string, sources?: { oldSource: string; newSource: string }) =>
      renderFile(
        parsePatch(patch, 'src/foo.ts', 'modified'),
        'src-foo-ts', 'abc123', 'o', 'r', 1, [], false, true, 'sha1', sources
      );

    // The colour of the first highlighted token on a line, addressed by side and line
    // number since the line's text is split across token spans. Comparing colours to each
    // other rather than to literal hex keeps this independent of the theme.
    const tokenColor = (html: string, side: 'LEFT' | 'RIGHT', lineNum: number) => {
      const id = `id="f-src-foo-ts-L${side}${lineNum}"`;
      const row = html.split('<tr ').find((r) => r.includes(id));
      if (!row) throw new Error(`no diff row for ${side} line ${lineNum}`);
      const match = row.match(/<span style="color:([^";]+)/);
      return match ? match[1] : null;
    };

    it('does not bleed an unterminated comment into the hunks below it', async () => {
      const html = await render(GAPPED_PATCH, GAPPED_SOURCES);

      // `const` in the second hunk must be coloured as the keyword it is — the same as the
      // `const` in the first hunk — not swallowed by the comment opened above.
      const keyword = tokenColor(html, 'RIGHT', 1); // const a = 1;
      expect(keyword).toBeTruthy();
      expect(tokenColor(html, 'RIGHT', 7)).toBe(keyword); // const c = 3;
      expect(tokenColor(html, 'RIGHT', 8)).toBe(keyword); // const d = 4;

      // Sanity check that the assertion above can actually fail: lines that really are
      // inside the comment are coloured differently.
      expect(tokenColor(html, 'RIGHT', 3)).not.toBe(keyword); //    still comment
    });

    it('isolates each hunk when the file contents are unavailable', async () => {
      const html = await render(GAPPED_PATCH);

      // No sources, so a hunk opening mid-construct can't be got right — but state still
      // must not cross the gap into the next hunk.
      const keyword = tokenColor(html, 'RIGHT', 1); // const a = 1;
      expect(keyword).toBeTruthy();
      expect(tokenColor(html, 'RIGHT', 7)).toBe(keyword); // const c = 3;
    });

    it('colours a hunk that starts inside a comment as comment', async () => {
      // This hunk shows only lines 3-5, all of them inside the block comment opened at
      // line 2. Only the real file reveals that.
      const MID_COMMENT_PATCH = [
        '@@ -3,3 +3,3 @@',
        '    still comment',
        '-   still comment',
        '+   still comment two',
        ' */',
        '',
      ].join('\n');
      const oldSource = fileAt('1', '2');
      const newSource = oldSource.replace(
        '   still comment\n*/',
        '   still comment two\n*/'
      );

      const withSources = await render(MID_COMMENT_PATCH, { oldSource, newSource });
      const isolated = await render(MID_COMMENT_PATCH);

      // Line 4 is the edited line, line 5 the `*/` that closes the comment it sits in.
      expect(tokenColor(withSources, 'RIGHT', 4)).toBe(tokenColor(withSources, 'RIGHT', 5));
      expect(tokenColor(withSources, 'RIGHT', 4)).not.toBe(tokenColor(isolated, 'RIGHT', 4));
    });

    it('falls back rather than trusting sources that do not match the patch', async () => {
      // Line numbers that don't line up (a stale base, say) would otherwise hand every line
      // some other line's colours.
      const shifted = {
        oldSource: `import x from 'x';\n${GAPPED_SOURCES.oldSource}`,
        newSource: `import x from 'x';\n${GAPPED_SOURCES.newSource}`,
      };

      expect(await render(GAPPED_PATCH, shifted)).toBe(await render(GAPPED_PATCH));
    });
  });

  describe('sourcesFromFullContextPatch', () => {
    it('reconstructs both sides of the file from a full-context patch', () => {
      const patch = [
        '@@ -1,3 +1,3 @@',
        ' const a = 1;',
        '-const b = 1;',
        '+const b = 2;',
        ' const c = 3;',
      ].join('\n');

      expect(sourcesFromFullContextPatch(patch)).toEqual({
        oldSource: 'const a = 1;\nconst b = 1;\nconst c = 3;',
        newSource: 'const a = 1;\nconst b = 2;\nconst c = 3;',
      });
    });

    it('handles a newly added file, which has no old side', () => {
      const patch = ['@@ -0,0 +1,2 @@', '+const a = 1;', '+const b = 2;'].join('\n');

      expect(sourcesFromFullContextPatch(patch)).toEqual({
        oldSource: '',
        newSource: 'const a = 1;\nconst b = 2;',
      });
    });

    it('rejects a patch that skips lines, since that is not the whole file', () => {
      // Two hunks with a gap between them: exactly what these sources exist to avoid.
      const patch = [
        '@@ -1,1 +1,1 @@',
        ' const a = 1;',
        '@@ -9,1 +9,1 @@',
        ' const z = 26;',
      ].join('\n');

      expect(sourcesFromFullContextPatch(patch)).toBeNull();
    });
  });
});
