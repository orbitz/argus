/**
 * Stacked-PR detection for the /pulls screen.
 *
 * A "stack" is a chain (or tree) of PRs linked by branch: PR B is stacked on PR A
 * when B's base branch is A's head branch (`B.baseRef === A.headRef`). Since each PR
 * targets exactly one base branch, every PR has at most one parent, so a connected
 * group of stacked PRs forms a tree rooted at the PR closest to the trunk (e.g. `main`).
 *
 * This module is intentionally pure (no Octokit, no DB) so it can be unit-tested in
 * isolation, matching the testing style of diff-parser.ts / git.ts.
 *
 * The output precomputes the "rail" glyphs (git-log style) per node so the EJS template
 * carries no graph logic — it just maps each cell token to a CSS class.
 */

export interface StackablePR {
  number: number;
  headRef: string;
  baseRef: string;
  /**
   * True only when the PR's head lives in the same repo as its base. Cross-fork PRs
   * (and PRs whose head branch was deleted, where `head.repo` is null) are never used
   * as stack links — two forks can share a branch name like `main`, which would produce
   * bogus links.
   */
  sameRepo: boolean;
  /** ISO timestamp; used to order stacks (most recently updated first). Optional. */
  updatedAt?: string;
  // Arbitrary display fields (title, draft, approved, otherApprovers, user, ...) pass through.
  [k: string]: unknown;
}

export type RailConnector = 'root' | 'linear' | 'tee' | 'elbow';

/** One gutter cell of a node's rail row, mapped to a CSS class by the template. */
export type RailCell = 'blank' | 'through' | 'tee' | 'elbow' | 'node' | 'node-branch';

export interface StackNode<T extends StackablePR> {
  pr: T;
  /** Indent level. Incremented only at real branch points; linear runs keep their column. */
  column: number;
  parentNumber: number | null;
  isRoot: boolean;
  /** No children — the tip of its branch. */
  isTip: boolean;
  /** Ancestor trunk state for columns [0 .. column-1]. */
  guides: Array<'vertical' | 'blank'>;
  /** Shape drawn at `column`, leading into the node dot. */
  connector: RailConnector;
  /** Precomputed rail cells, length `column + 1` (last is the node dot cell). */
  cells: RailCell[];
}

export interface Stack<T extends StackablePR> {
  /** The branch the root targets, e.g. "main". */
  base: string;
  size: number;
  /** Base-first (root on top), DFS pre-order. */
  nodes: StackNode<T>[];
}

function buildCells(
  column: number,
  connector: RailConnector,
  guides: Array<'vertical' | 'blank'>
): RailCell[] {
  const isBranch = connector === 'tee' || connector === 'elbow';
  const cells: RailCell[] = [];
  for (let c = 0; c < column; c++) {
    if (isBranch && c === column - 1) {
      // The junction (├ / └) sits at the parent's column, not the child's own.
      cells.push(connector);
    } else {
      cells.push(guides[c] === 'vertical' ? 'through' : 'blank');
    }
  }
  cells.push(isBranch ? 'node-branch' : 'node');
  return cells;
}

/**
 * Group PRs into stacks (trees of size >= 2) and standalone PRs.
 *
 * Ordering: stacks come out sorted by their most-recently-updated member (desc);
 * standalone PRs preserve the input order (the route feeds them updated-desc already).
 */
export function buildStacks<T extends StackablePR>(
  prs: T[]
): { stacks: Stack<T>[]; standalone: T[] } {
  // headRef -> PR, same-repo only, first wins on duplicate head branches (ambiguous link guard).
  const byHead = new Map<string, T>();
  for (const pr of prs) {
    if (pr.sameRepo && !byHead.has(pr.headRef)) byHead.set(pr.headRef, pr);
  }

  const parentOf = new Map<number, T | null>();
  const childrenOf = new Map<number, T[]>();
  for (const pr of prs) childrenOf.set(pr.number, []);
  for (const pr of prs) {
    let parent: T | null = null;
    if (pr.sameRepo) {
      const cand = byHead.get(pr.baseRef);
      if (cand && cand.number !== pr.number) parent = cand;
    }
    parentOf.set(pr.number, parent);
  }
  for (const pr of prs) {
    const parent = parentOf.get(pr.number);
    if (parent) childrenOf.get(parent.number)!.push(pr);
  }
  // Stable child order by PR number.
  for (const list of childrenOf.values()) list.sort((a, b) => a.number - b.number);

  // Count a root's subtree size (cycle-guarded, though roots can't be in a cycle).
  const subtreeSize = (root: T): number => {
    const seen = new Set<number>();
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur.number)) continue;
      seen.add(cur.number);
      for (const k of childrenOf.get(cur.number)!) stack.push(k);
    }
    return seen.size;
  };

  const walk = (
    pr: T,
    guides: Array<'vertical' | 'blank'>,
    connector: RailConnector,
    column: number,
    out: StackNode<T>[],
    seen: Set<number>
  ): void => {
    if (seen.has(pr.number)) return; // defensive: no cycles are reachable from a root
    seen.add(pr.number);
    const kids = childrenOf.get(pr.number)!;
    out.push({
      pr,
      column,
      parentNumber: parentOf.get(pr.number)?.number ?? null,
      isRoot: connector === 'root',
      isTip: kids.length === 0,
      guides: guides.slice(),
      connector,
      cells: buildCells(column, connector, guides),
    });
    const branching = kids.length >= 2;
    kids.forEach((kid, i) => {
      const isLast = i === kids.length - 1;
      if (branching) {
        // Real branch point: child indents one column; the trunk at this node's column
        // continues past the child's subtree while younger siblings remain.
        walk(kid, [...guides, isLast ? 'blank' : 'vertical'], isLast ? 'elbow' : 'tee', column + 1, out, seen);
      } else {
        // Linear run: single child stays in the same column (no runaway indentation).
        walk(kid, guides, 'linear', column, out, seen);
      }
    });
  };

  const inStack = new Set<number>();
  const stacks: Stack<T>[] = [];
  for (const pr of prs) {
    if (parentOf.get(pr.number) != null) continue; // only roots start a component
    if (subtreeSize(pr) < 2) continue; // size-1 => standalone
    const nodes: StackNode<T>[] = [];
    walk(pr, [], 'root', 0, nodes, new Set());
    for (const n of nodes) inStack.add(n.pr.number);
    stacks.push({ base: pr.baseRef, size: nodes.length, nodes });
  }

  const maxUpdated = (s: Stack<T>): string =>
    s.nodes.reduce((m, n) => {
      const u = n.pr.updatedAt ?? '';
      return u > m ? u : m;
    }, '');
  stacks.sort((a, b) => maxUpdated(b).localeCompare(maxUpdated(a)));

  // Everything not placed in a stack (including any cycle members) stays standalone,
  // in the original input order.
  const standalone = prs.filter((p) => !inStack.has(p.number));

  return { stacks, standalone };
}
