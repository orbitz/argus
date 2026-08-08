import { describe, it, expect } from 'vitest';
import { inlineRelativeImages, renderMarkdown } from '../src/lib/markdown.js';

describe('inlineRelativeImages', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const fetchAll = async () => png;
  const fetchNone = async () => null;

  it('inlines a relative image as a data: URI', async () => {
    const html = '<img src="diagram.png" alt="d">';
    const result = await inlineRelativeImages(html, 'docs', fetchAll);
    expect(result).toContain(`src="data:image/png;base64,${png.toString('base64')}"`);
    expect(result).toContain('alt="d"');
  });

  it('resolves the path against the file directory', async () => {
    const seen: string[] = [];
    const html = '<img src="img/logo.png">';
    await inlineRelativeImages(html, 'docs/guide', async (p) => {
      seen.push(p);
      return png;
    });
    expect(seen).toEqual(['docs/guide/img/logo.png']);
  });

  it('resolves ../ segments and strips leading ../', async () => {
    const seen: string[] = [];
    const html = '<img src="../assets/x.png">';
    await inlineRelativeImages(html, 'docs/guide', async (p) => {
      seen.push(p);
      return png;
    });
    expect(seen).toEqual(['docs/assets/x.png']);
  });

  it('leaves absolute URLs untouched', async () => {
    const html = '<img src="https://example.com/x.png">';
    const result = await inlineRelativeImages(html, 'docs', fetchAll);
    expect(result).toBe(html);
  });

  it('leaves protocol-relative URLs untouched', async () => {
    const html = '<img src="//example.com/x.png">';
    const result = await inlineRelativeImages(html, 'docs', fetchAll);
    expect(result).toBe(html);
  });

  it('leaves existing data: URIs untouched', async () => {
    const html = '<img src="data:image/png;base64,AAAA">';
    const result = await inlineRelativeImages(html, 'docs', fetchAll);
    expect(result).toBe(html);
  });

  it('leaves the <img> untouched when the fetch returns null', async () => {
    const html = '<img src="missing.png">';
    const result = await inlineRelativeImages(html, 'docs', fetchNone);
    expect(result).toBe(html);
  });

  it('does not fetch unknown image extensions', async () => {
    let called = false;
    const html = '<img src="diagram.tiff">';
    const result = await inlineRelativeImages(html, 'docs', async () => {
      called = true;
      return png;
    });
    expect(called).toBe(false);
    expect(result).toBe(html);
  });

  it('fetches each unique path only once', async () => {
    let calls = 0;
    const html = '<img src="a.png"><img src="a.png">';
    await inlineRelativeImages(html, 'docs', async () => {
      calls++;
      return png;
    });
    expect(calls).toBe(1);
  });
});

describe('markdown sanitisation', () => {
  // Everything here arrives from GitHub, written by whoever opened the PR or comment.
  it('escapes a <style> element instead of opening one', async () => {
    // The real incident: a PR description mentioning `<style>` opened a style element,
    // and the browser consumed the rest of the page as CSS.
    const html = await renderMarkdown('swept across CSS, `<style>` blocks and inline `style=` attributes');
    expect(html).not.toMatch(/<style[ >]/i);
    expect(html).toContain('&lt;style&gt;');
  });

  it('strips script tags', async () => {
    const html = await renderMarkdown('hello <script>alert(document.cookie)</script>');
    expect(html).not.toMatch(/<script/i);
  });

  it('strips event handlers', async () => {
    const html = await renderMarkdown('<img src="x" onerror="fetch(\'/pr/o/r/1/merge\',{method:\'POST\'})">');
    expect(html).not.toMatch(/onerror/i);
  });

  it('drops javascript: links', async () => {
    const html = await renderMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toMatch(/javascript:/i);
  });

  it('strips iframes and objects', async () => {
    const html = await renderMarkdown('<iframe src="https://evil.example"></iframe><object data="x"></object>');
    expect(html).not.toMatch(/<iframe|<object/i);
  });

  it('keeps the formatting GitHub markdown actually produces', async () => {
    const html = await renderMarkdown('**bold** and `code` and [link](https://example.com)');
    expect(html).toContain('<strong>');
    expect(html).toContain('<code>');
    expect(html).toContain('href="https://example.com"');
  });

  it('keeps task lists, tables and details blocks', async () => {
    const tasks = await renderMarkdown('- [x] done\n- [ ] todo');
    expect(tasks).toContain('type="checkbox"');

    const table = await renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(table).toContain('<table>');

    const details = await renderMarkdown('<details><summary>more</summary>hidden</details>');
    expect(details).toContain('<details>');
    expect(details).toContain('<summary>');
  });

  it('keeps syntax-highlighted code spans', async () => {
    const html = await renderMarkdown('```js\nconst x = 1;\n```');
    expect(html).toMatch(/<pre|<code/);
  });
});

describe('document-swallowing HTML blocks', () => {
  it('keeps parsing markdown after a mention of <style>', async () => {
    // CommonMark runs a <style> block to its closing tag; without the closing tag that is
    // the rest of the document, so everything below rendered as raw text.
    const html = await renderMarkdown('swept across `<style>` blocks\n\n- first\n- second');
    expect(html).toContain('<li>first</li>');
    expect(html).toContain('<li>second</li>');
    expect(html).not.toMatch(/<style[ >]/i);
  });

  it('does the same for <script> and <textarea>', async () => {
    for (const tag of ['script', 'textarea', 'pre']) {
      const html = await renderMarkdown(`mentions <${tag}> here\n\n**after**`);
      expect(html, tag).toContain('<strong>after</strong>');
    }
  });

  it('leaves the raw HTML GitHub actually supports alone', async () => {
    const html = await renderMarkdown('<details><summary>more</summary>\n\n**inside**\n\n</details>');
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>');
  });
});

describe('list items', () => {
  it('renders inline markdown inside list items', async () => {
    // These used to emit the item's raw source, so every bullet in every PR description
    // showed its asterisks and backticks.
    const html = await renderMarkdown('- **bold** and `code` and [link](https://example.com)');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('**bold**');
  });

  it('renders nested lists', async () => {
    const html = await renderMarkdown('- outer\n  - inner **bold**');
    expect(html).toContain('<strong>bold</strong>');
    expect(html.match(/<ul>/g) ?? []).toHaveLength(2);
  });

  it('renders task lists with formatting, disabled', async () => {
    const html = await renderMarkdown('- [x] **done** thing\n- [ ] todo');
    expect(html).toContain('type="checkbox" checked disabled');
    expect(html).toContain('<strong>done</strong>');
  });
});
