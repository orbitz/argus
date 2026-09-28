import { describe, it, expect } from 'vitest';
import { expandRenamedFile, type SplitSourceFile } from '../src/lib/rename-split.js';

function renamed(overrides: Partial<SplitSourceFile> = {}): SplitSourceFile {
  return {
    filename: 'src/new-name.ts',
    status: 'renamed',
    additions: 4,
    deletions: 2,
    previous_filename: 'src/old-name.ts',
    patch: '@@ -1,2 +1,4 @@',
    sha: 'abc123',
    ...overrides,
  };
}

describe('expandRenamedFile', () => {
  it('passes a modified file through untouched', () => {
    const file: SplitSourceFile = { filename: 'a.txt', status: 'modified', additions: 1, deletions: 1 };
    expect(expandRenamedFile(file)).toEqual([file]);
  });

  it('passes a renamed record without previous_filename through untouched', () => {
    const file: SplitSourceFile = { ...renamed(), previous_filename: undefined };
    expect(expandRenamedFile(file)).toEqual([file]);
  });

  it('splits a rename into a delete card then an add card', () => {
    const [del, add] = expandRenamedFile(renamed());
    expect(del.filename).toBe('src/old-name.ts');
    expect(del.status).toBe('deleted');
    expect(del.additions).toBe(0);
    expect(del.deletions).toBe(0);
    expect(del.patch).toBeUndefined();
    expect(del.sha).toBeUndefined();
    expect(del.movedTo).toBe('src/new-name.ts');
    expect(add.filename).toBe('src/new-name.ts');
    expect(add.status).toBe('added');
    expect(add.movedFrom).toBe('src/old-name.ts');
    expect(add.previous_filename).toBe('src/old-name.ts');
  });

  it('keeps patch, stats and SHA only on the add card', () => {
    const [, add] = expandRenamedFile(renamed());
    expect(add.patch).toBe('@@ -1,2 +1,4 @@');
    expect(add.additions).toBe(4);
    expect(add.deletions).toBe(2);
    expect(add.sha).toBe('abc123');
  });

  it('emits the delete card first so the old path lists above the new one', () => {
    const cards = expandRenamedFile(renamed());
    expect(cards.map(c => c.filename)).toEqual(['src/old-name.ts', 'src/new-name.ts']);
  });
});
