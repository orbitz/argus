import { describe, it, expect } from 'vitest';
import { inlineRelativeImages } from '../src/lib/markdown.js';

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
