import { describe, it, expect } from 'vitest';
import ejs from 'ejs';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'templates');

/**
 * Templates are compiled on first request, not at build time, so `tsc` and the whole test
 * suite can pass with a template that throws the moment anyone loads the page — which is
 * exactly what a bad edit produced: eleven templates carrying a stray escape, every page
 * a 500, and nothing red until it was deployed.
 *
 * Compiling is not rendering: this catches syntax, not a missing variable.
 */
const templates = readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.ejs'));

describe('EJS templates', () => {
  it('finds the templates to check', () => {
    expect(templates.length).toBeGreaterThan(5);
  });

  it.each(templates)('%s compiles', (name) => {
    const file = join(TEMPLATE_DIR, name);
    expect(() =>
      ejs.compile(readFileSync(file, 'utf8'), { filename: file })
    ).not.toThrow();
  });

  it('compiles the partials too, which are only reached through an include', () => {
    const partialDir = join(TEMPLATE_DIR, 'partials');
    const partials = readdirSync(partialDir).filter((f) => f.endsWith('.ejs'));
    expect(partials.length).toBeGreaterThan(0);

    for (const name of partials) {
      const file = join(partialDir, name);
      expect(() => ejs.compile(readFileSync(file, 'utf8'), { filename: file })).not.toThrow();
    }
  });
});
