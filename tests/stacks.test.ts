import { describe, it, expect } from 'vitest';
import { buildStacks, StackablePR } from '../src/lib/stacks.js';

// Minimal PR factory. `updatedAt` defaults keep ordering deterministic per number.
function pr(
  number: number,
  headRef: string,
  baseRef: string,
  extra: Partial<StackablePR> = {}
): StackablePR {
  return {
    number,
    headRef,
    baseRef,
    sameRepo: true,
    updatedAt: `2026-01-0${number}T00:00:00Z`,
    ...extra,
  };
}

describe('buildStacks', () => {
  it('detects a linear chain, base-first, without indenting', () => {
    const { stacks, standalone } = buildStacks([
      pr(1, 'a', 'main'),
      pr(2, 'b', 'a'),
      pr(3, 'c', 'b'),
    ]);

    expect(standalone).toHaveLength(0);
    expect(stacks).toHaveLength(1);

    const s = stacks[0];
    expect(s.base).toBe('main');
    expect(s.size).toBe(3);
    expect(s.nodes.map((n) => n.pr.number)).toEqual([1, 2, 3]); // base-first
    expect(s.nodes.map((n) => n.column)).toEqual([0, 0, 0]); // linear runs never indent
    expect(s.nodes.map((n) => n.connector)).toEqual(['root', 'linear', 'linear']);
    expect(s.nodes[0].isRoot).toBe(true);
    expect(s.nodes[2].isTip).toBe(true);
  });

  it('renders a branch (2 children) with tee/elbow connectors', () => {
    const { stacks } = buildStacks([
      pr(1, 'a', 'main'),
      pr(2, 'b', 'a'),
      pr(3, 'c', 'a'),
    ]);

    expect(stacks).toHaveLength(1);
    const byNum = new Map(stacks[0].nodes.map((n) => [n.pr.number, n]));

    expect(byNum.get(1)!.connector).toBe('root');
    expect(byNum.get(2)!.column).toBe(1);
    expect(byNum.get(2)!.connector).toBe('tee'); // #2 has a younger sibling (#3)
    expect(byNum.get(3)!.column).toBe(1);
    expect(byNum.get(3)!.connector).toBe('elbow'); // #3 is the last child
  });

  it('keeps a linear child under a branch in the same column with a continuing guide', () => {
    // A -> [B, C]; B -> D. Pre-order: A, B, D, C.
    const { stacks } = buildStacks([
      pr(1, 'a', 'main'),
      pr(2, 'b', 'a'),
      pr(3, 'c', 'a'),
      pr(4, 'd', 'b'),
    ]);

    expect(stacks).toHaveLength(1);
    expect(stacks[0].nodes.map((n) => n.pr.number)).toEqual([1, 2, 4, 3]);

    const byNum = new Map(stacks[0].nodes.map((n) => [n.pr.number, n]));
    const d = byNum.get(4)!;
    expect(d.column).toBe(1); // linear under B, no extra indent
    expect(d.connector).toBe('linear');
    expect(d.guides[0]).toBe('vertical'); // A's trunk continues down to C across B's subtree
  });

  it('treats unrelated PRs as standalone, preserving input order', () => {
    const { stacks, standalone } = buildStacks([pr(1, 'a', 'main'), pr(2, 'b', 'main')]);
    expect(stacks).toHaveLength(0);
    expect(standalone.map((p) => p.number)).toEqual([1, 2]);
  });

  it('never links cross-fork PRs even when branch names collide', () => {
    const { stacks, standalone } = buildStacks([
      pr(1, 'a', 'main'),
      pr(2, 'b', 'a', { sameRepo: false }), // base "a" matches #1's head, but it's a fork
    ]);
    expect(stacks).toHaveLength(0);
    expect(standalone.map((p) => p.number)).toEqual([1, 2]);
  });

  it('handles duplicate head branches deterministically (first wins)', () => {
    const { stacks, standalone } = buildStacks([
      pr(1, 'dup', 'main'),
      pr(2, 'dup', 'x'), // same head as #1
      pr(3, 'c', 'dup'), // links to whichever "dup" won — #1
    ]);
    expect(stacks).toHaveLength(1);
    expect(stacks[0].nodes.map((n) => n.pr.number)).toEqual([1, 3]);
    expect(standalone.map((p) => p.number)).toEqual([2]);
  });

  it('terminates on a base/head cycle and drops the members to standalone', () => {
    const { stacks, standalone } = buildStacks([
      pr(1, 'a', 'b'),
      pr(2, 'b', 'a'),
    ]);
    expect(stacks).toHaveLength(0);
    expect(standalone.map((p) => p.number).sort()).toEqual([1, 2]);
  });

  it('orders stacks by most-recently-updated member (desc)', () => {
    const { stacks } = buildStacks([
      // Older stack: #1 <- #2
      pr(1, 'a', 'main', { updatedAt: '2026-01-01T00:00:00Z' }),
      pr(2, 'b', 'a', { updatedAt: '2026-01-02T00:00:00Z' }),
      // Newer stack: #3 <- #4
      pr(3, 'c', 'main', { updatedAt: '2026-01-05T00:00:00Z' }),
      pr(4, 'd', 'c', { updatedAt: '2026-01-06T00:00:00Z' }),
    ]);
    expect(stacks).toHaveLength(2);
    expect(stacks[0].nodes[0].pr.number).toBe(3); // newer stack first
    expect(stacks[1].nodes[0].pr.number).toBe(1);
  });
});
