import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { config } from '../config.js';
import { bump } from './perf-counters.js';

/**
 * Optional logger for per-command timing. Set once at startup (see src/index.ts); left unset
 * this module stays silent, which keeps tests and scripts that import git.ts free of logging.
 */
interface GitLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
}
let gitLogger: GitLogger | null = null;

export function setGitLogger(logger: GitLogger): void {
  gitLogger = logger;
}

// Track active git processes for cleanup during shutdown
const activeProcesses = new Set<ChildProcess>();

// Cache for computeCrossDiff results (keyed by owner/repo:fromSha..toSha:flags)
interface CrossDiffCacheEntry {
  data: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>;
  lastAccessed: number;
}

const crossDiffCache = new Map<string, CrossDiffCacheEntry>();

// Cache for getFullContextPatches results (keyed by owner/repo:fromSha..toSha)
interface FullContextCacheEntry {
  data: Map<string, string>;
  // Paths this entry is known to have looked at, or null when it covers the whole diff.
  // A path may be absent from `data` and still be covered (binary, or over the line cap).
  covered: Set<string> | null;
  lastAccessed: number;
}

const fullContextCache = new Map<string, FullContextCacheEntry>();

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_EVICT_INTERVAL_MS = 6 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const cache of [crossDiffCache, fullContextCache]) {
    for (const [key, entry] of cache) {
      if (now - entry.lastAccessed > CACHE_MAX_AGE_MS) {
        cache.delete(key);
      }
    }
  }
}, CACHE_EVICT_INTERVAL_MS).unref();

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RangeDiffResult {
  output: string;
  hasChanges: boolean;
}

/**
 * Get the path to a bare git repository in the cache
 */
export function getRepoPath(owner: string, repo: string): string {
  return join(config.git.cacheDir, owner, `${repo}.git`);
}

/**
 * Build authenticated GitHub URL
 */
export function buildAuthUrl(owner: string, repo: string, token: string): string {
  return `https://oauth2:${token}@github.com/${owner}/${repo}.git`;
}

/**
 * Sanitize error messages to remove tokens
 */
export function sanitizeError(message: string, token: string): string {
  if (!token) return message;
  // Remove token from URLs and error messages
  return message.replace(new RegExp(token, 'g'), '***TOKEN***');
}

/**
 * Subcommands that talk to the remote. Counted separately because a slow local spawn and a
 * slow network fetch call for completely different fixes.
 */
const NETWORK_SUBCOMMANDS = new Set(['fetch', 'clone', 'ls-remote', 'push']);

/**
 * Execute a git command with timeout
 */
async function execGit(
  args: string[],
  cwd: string,
  token?: string,
  timeout: number = config.git.commandTimeout
): Promise<GitCommandResult> {
  const startedAt = performance.now();
  const isNetwork = NETWORK_SUBCOMMANDS.has(args[0]);

  // Record on both the success and failure paths — a git command that fails slowly (a fetch
  // that times out) is exactly the kind of thing we're hunting for. Guarded because the
  // timeout path calls cleanup() and then kills the process, which fires 'close' and calls
  // cleanup() a second time.
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    const elapsed = performance.now() - startedAt;
    bump('gitSpawns', 1);
    bump('gitMs', elapsed);
    if (isNetwork) {
      bump('gitNetworkSpawns', 1);
      bump('gitNetworkMs', elapsed);
    }
    gitLogger?.debug(
      { args: token ? args.map((a) => sanitizeError(a, token)) : args, cwd, ms: Math.round(elapsed), network: isNetwork },
      'git command'
    );
  };

  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    // Track the process
    activeProcesses.add(proc);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Auto-cleanup helper
    const cleanup = () => {
      clearTimeout(timer);
      activeProcesses.delete(proc);
      record();
    };

    const timer = setTimeout(() => {
      cleanup();
      timedOut = true;
      proc.kill();
      reject(new Error(`Git command timed out after ${timeout}ms`));
    }, timeout);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      cleanup();
      if (timedOut) return;

      const result = {
        stdout,
        stderr,
        exitCode: code || 0,
      };

      if (code !== 0) {
        const sanitizedStderr = token ? sanitizeError(stderr, token) : stderr;
        reject(new Error(`Git command failed (exit ${code}): ${sanitizedStderr}`));
      } else {
        resolve(result);
      }
    });

    proc.on('error', (err) => {
      cleanup();
      if (timedOut) return;
      const sanitizedMessage = token ? sanitizeError(err.message, token) : err.message;
      reject(new Error(`Git command error: ${sanitizedMessage}`));
    });
  });
}

/**
 * Ensure a bare clone exists in the cache, with a blobless promisor `origin`
 * remote configured. Storing the authenticated remote lets `git diff`/merge
 * lazily fetch only the blobs they actually need instead of every blob in the
 * repo snapshot — the key speedup for large repositories.
 */
export async function ensureRepo(owner: string, repo: string, token: string): Promise<void> {
  const repoPath = getRepoPath(owner, repo);
  const parentDir = dirname(repoPath);
  const authUrl = buildAuthUrl(owner, repo, token);

  // Create parent directory if needed
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  // If repo doesn't exist, create it as an empty bare repo.
  // Refs are fetched on demand (shallow + blobless) by fetchRefs.
  if (!existsSync(repoPath)) {
    try {
      await execGit(['init', '--bare', repoPath], parentDir);
    } catch (err: any) {
      throw new Error(`Failed to initialize repository: ${sanitizeError(err.message, token)}`);
    }
  }

  // (Re)configure `origin` to the current authenticated URL as a blobless
  // promisor remote. set-url updates the token if it rotated; if origin is
  // missing (older cache repos), fall back to add. Both are cheap local ops.
  try {
    await execGit(['remote', 'set-url', 'origin', authUrl], repoPath, token);
  } catch {
    await execGit(['remote', 'add', 'origin', authUrl], repoPath, token);
  }
  await execGit(['config', 'remote.origin.promisor', 'true'], repoPath, token);
  await execGit(['config', 'remote.origin.partialclonefilter', 'blob:none'], repoPath, token);
}

/**
 * Fetch specific refs from the `origin` remote (blobless partial fetch).
 * Retries with a deeper fetch if a shallow-clone error occurs.
 *
 * `depth` controls history depth only; blob contents are always filtered out
 * and fetched lazily on demand. Callers that just diff two commits should pass
 * `config.git.shallowDepth` (1); history-dependent callers pass more.
 */
export async function fetchRefs(
  owner: string,
  repo: string,
  refs: string[],
  token: string,
  depth?: number
): Promise<void> {
  const repoPath = getRepoPath(owner, repo);

  const fetchDepth = depth || config.git.fetchDepth;
  const baseArgs = ['fetch', '--no-tags', '--filter=blob:none'];
  const args = [...baseArgs, '--depth', fetchDepth.toString(), 'origin', ...refs];

  try {
    await execGit(args, repoPath, token);
  } catch (err: any) {
    const errorMsg = err.message.toLowerCase();

    // Check if it's a shallow clone error
    if (errorMsg.includes('shallow') || errorMsg.includes('unshallow')) {
      console.log(`Shallow fetch failed, retrying with depth ${config.git.fetchDeepDepth}`);
      const deepArgs = [...baseArgs, '--depth', config.git.fetchDeepDepth.toString(), 'origin', ...refs];
      try {
        await execGit(deepArgs, repoPath, token);
      } catch (deepErr: any) {
        throw new Error(`Failed to fetch refs (even with deep fetch): ${sanitizeError(deepErr.message, token)}`);
      }
    } else {
      throw new Error(`Failed to fetch refs: ${sanitizeError(err.message, token)}`);
    }
  }
}

/**
 * Check if a ref/SHA already exists in the local repo
 */
async function hasRef(repoPath: string, sha: string, token?: string): Promise<boolean> {
  try {
    await execGit(['cat-file', '-t', sha], repoPath, token);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to compute a merge-base, returning null if none is reachable in the
 * currently-fetched (shallow) history rather than throwing.
 */
async function tryMergeBase(
  repoPath: string,
  ref1: string,
  ref2: string,
  token: string
): Promise<string | null> {
  try {
    const result = await execGit(['merge-base', ref1, ref2], repoPath, token);
    const sha = result.stdout.trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Compute merge-base between two refs.
 *
 * Starts from a modest shallow depth and deepens progressively until a common
 * ancestor is found, instead of always paying for a deep fetch up front. Most
 * PR branches share an ancestor within a few dozen commits, so this is far
 * faster on large repos while still handling long-lived branches.
 */
export async function computeMergeBase(
  owner: string,
  repo: string,
  ref1: string,
  ref2: string,
  token: string
): Promise<string> {
  const repoPath = getRepoPath(owner, repo);

  await ensureRepo(owner, repo, token);

  // Initial fetch of any missing refs at the starting depth.
  const refsToFetch: string[] = [];
  if (!await hasRef(repoPath, ref1, token)) refsToFetch.push(ref1);
  if (!await hasRef(repoPath, ref2, token)) refsToFetch.push(ref2);
  let depth: number = config.git.mergeBaseDepth;
  if (refsToFetch.length > 0) {
    await fetchRefs(owner, repo, refsToFetch, token, depth);
  }

  let mergeBase = await tryMergeBase(repoPath, ref1, ref2, token);

  // Deepen progressively until a merge-base is reachable or we hit the cap.
  while (!mergeBase && depth < config.git.fetchDeepDepth) {
    depth = Math.min(depth * 4, config.git.fetchDeepDepth);
    await fetchRefs(owner, repo, [ref1, ref2], token, depth);
    mergeBase = await tryMergeBase(repoPath, ref1, ref2, token);
  }

  if (!mergeBase) {
    throw new Error(`Failed to compute merge-base: no common ancestor found within depth ${depth}`);
  }
  return mergeBase;
}

/**
 * Compute range-diff between two commit ranges
 */
export async function computeRangeDiff(
  owner: string,
  repo: string,
  oldBase: string,
  oldHead: string,
  newBase: string,
  newHead: string,
  token: string
): Promise<RangeDiffResult> {
  const repoPath = getRepoPath(owner, repo);

  await ensureRepo(owner, repo, token);
  await fetchRefs(owner, repo, [oldBase, oldHead, newBase, newHead], token);

  try {
    const result = await execGit(
      ['range-diff', `${oldBase}..${oldHead}`, `${newBase}..${newHead}`],
      repoPath,
      token
    );

    const output = result.stdout.trim();
    const hasChanges = output.length > 0;

    return { output, hasChanges };
  } catch (err: any) {
    throw new Error(`Failed to compute range-diff: ${sanitizeError(err.message, token)}`);
  }
}

/**
 * Split the output of a multi-file `git diff` into per-file patches.
 *
 * Returns [filename, patch] pairs in diff order, where the patch starts at the first `@@`
 * line. A file with no `@@` at all (binary, mode-only change) yields `undefined` so callers
 * can still see that the file was touched.
 */
function splitDiffByFile(diffOutput: string): Array<[string, string | undefined]> {
  const out: Array<[string, string | undefined]> = [];

  for (const fileDiff of diffOutput.split(/^diff --git /m).slice(1)) {
    const lines = fileDiff.split('\n');
    // Extract filename from the diff header: "a/path b/path"
    const headerMatch = lines[0].match(/^a\/(.*?) b\/(.*)$/);
    if (!headerMatch) continue;
    const filename = headerMatch[2];

    // Find where the patch starts (after the header lines)
    let patchStartIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].startsWith('@@')) {
        patchStartIdx = i;
        break;
      }
    }

    out.push([
      filename,
      patchStartIdx >= 0 ? lines.slice(patchStartIdx).join('\n').trimEnd() : undefined,
    ]);
  }

  return out;
}

/**
 * Full-context (`-U99999`) patches for every file changed between two commits, keyed by
 * filename.
 *
 * Used as *tokenizer context* for syntax highlighting, never for display: a full-context
 * patch contains every line of both sides of the file, so `del + context` reconstructs the
 * complete old file and `add + context` the complete new one. Highlighting against those
 * instead of against the gapped diff is what stops a block comment closed inside an elided
 * region from bleeding into every hunk below it.
 *
 * One `git diff` for the whole PR rather than one per file: the diff machinery prefetches
 * all the blobs it is missing in a single round trip, which a per-file `git show` on our
 * blobless clone would not.
 *
 * Files whose full-context patch exceeds `config.diff.fullContextMaxLines` are omitted —
 * tokenizing a huge generated file to colour a three-line change is not worth it, and the
 * caller falls back to per-hunk highlighting.
 */
export async function getFullContextPatches(
  owner: string,
  repo: string,
  fromSha: string,
  toSha: string,
  token: string,
  paths?: string[]
): Promise<Map<string, string>> {
  const cacheKey = `${owner}/${repo}:${fromSha}..${toSha}`;
  const cached = fullContextCache.get(cacheKey);
  // A filtered entry only answers requests it already covers — an unfiltered caller asking
  // for every file must not be handed one built for a single path.
  if (cached && (cached.covered === null || (paths && paths.every((p) => cached.covered!.has(p))))) {
    cached.lastAccessed = Date.now();
    return cached.data;
  }

  const repoPath = getRepoPath(owner, repo);

  await ensureRepo(owner, repo, token);

  const refsToFetch: string[] = [];
  if (!await hasRef(repoPath, fromSha, token)) refsToFetch.push(fromSha);
  if (!await hasRef(repoPath, toSha, token)) refsToFetch.push(toSha);
  if (refsToFetch.length > 0) await fetchRefs(owner, repo, refsToFetch, token, config.git.shallowDepth);

  const filtered = paths !== undefined && paths.length > 0;
  const pathArgs = filtered ? ['--', ...paths] : [];
  const result = await execGit(
    ['diff', '-U99999', '--no-color', fromSha, toSha, ...pathArgs],
    repoPath,
    token
  );

  const patches = new Map<string, string>();
  for (const [filename, patch] of splitDiffByFile(result.stdout)) {
    if (!patch) continue;
    if (patch.split('\n').length > config.diff.fullContextMaxLines) continue;
    patches.set(filename, patch);
  }

  // Accumulate across filtered runs (a lazily-expanded PR asks one path at a time) rather
  // than letting each one throw away what the last learned.
  const merged = cached && cached.covered !== null
    ? new Map([...cached.data, ...patches])
    : patches;
  const covered = filtered
    ? new Set([...(cached?.covered ?? []), ...paths])
    : null;
  fullContextCache.set(cacheKey, { data: merged, covered, lastAccessed: Date.now() });

  return merged;
}

/**
 * Compute a two-dot diff between two commits, returning file-level patches
 * similar to GitHub's PRFile format.
 */
export async function computeCrossDiff(
  owner: string,
  repo: string,
  fromSha: string,
  toSha: string,
  token: string,
  options?: { ignoreWhitespace?: boolean }
): Promise<Array<{
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}>> {
  const cacheKey = `${owner}/${repo}:${fromSha}..${toSha}:${options?.ignoreWhitespace ? 'w' : ''}`;
  const cached = crossDiffCache.get(cacheKey);
  if (cached) {
    cached.lastAccessed = Date.now();
    return cached.data;
  }

  const repoPath = getRepoPath(owner, repo);

  await ensureRepo(owner, repo, token);

  // Only fetch refs not already available locally
  const refsToFetch: string[] = [];
  if (!await hasRef(repoPath, fromSha, token)) refsToFetch.push(fromSha);
  if (!await hasRef(repoPath, toSha, token)) refsToFetch.push(toSha);
  if (refsToFetch.length > 0) await fetchRefs(owner, repo, refsToFetch, token, config.git.shallowDepth);

  const wFlag = options?.ignoreWhitespace ? ['-w'] : [];

  // Get the list of changed files with stats
  const numstatResult = await execGit(
    ['diff', ...wFlag, '--numstat', fromSha, toSha],
    repoPath,
    token
  );

  // Get the full diff with patches
  const diffResult = await execGit(
    ['diff', ...wFlag, '--no-color', fromSha, toSha],
    repoPath,
    token
  );

  // Get file statuses (A/M/D/R)
  const statusResult = await execGit(
    ['diff', ...wFlag, '--name-status', fromSha, toSha],
    repoPath,
    token
  );

  // Parse name-status into a map
  const statusMap = new Map<string, string>();
  for (const line of statusResult.stdout.trim().split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const statusChar = parts[0][0]; // R100 -> R
    const filename = parts.length > 2 ? parts[2] : parts[1]; // renamed: use new name
    const statusName =
      statusChar === 'A' ? 'added' :
      statusChar === 'D' ? 'removed' :
      statusChar === 'R' ? 'renamed' :
      statusChar === 'C' ? 'copied' :
      'modified';
    statusMap.set(filename, statusName);
  }

  // Parse numstat for additions/deletions
  const statsMap = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstatResult.stdout.trim().split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10);
    const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10);
    const filename = parts[2];
    statsMap.set(filename, { additions, deletions });
  }

  // Split full diff into per-file patches
  const files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }> = [];

  for (const [filename, patch] of splitDiffByFile(diffResult.stdout)) {
    const stats = statsMap.get(filename) || { additions: 0, deletions: 0 };

    files.push({
      filename,
      status: statusMap.get(filename) || 'modified',
      additions: stats.additions,
      deletions: stats.deletions,
      patch,
    });
  }

  crossDiffCache.set(cacheKey, { data: files, lastAccessed: Date.now() });
  return files;
}

/**
 * Get full-file diff (maximum context) for a single file between two commits.
 * Returns the raw patch string or null if no diff exists.
 */
export async function getFullFileDiff(
  owner: string,
  repo: string,
  fromSha: string,
  toSha: string,
  filePath: string,
  token: string,
  options?: { ignoreWhitespace?: boolean }
): Promise<string | null> {
  const repoPath = getRepoPath(owner, repo);

  await ensureRepo(owner, repo, token);

  const refsToFetch: string[] = [];
  if (!await hasRef(repoPath, fromSha, token)) refsToFetch.push(fromSha);
  if (!await hasRef(repoPath, toSha, token)) refsToFetch.push(toSha);
  if (refsToFetch.length > 0) await fetchRefs(owner, repo, refsToFetch, token, config.git.shallowDepth);

  const wFlag = options?.ignoreWhitespace ? ['-w'] : [];

  const result = await execGit(
    ['diff', '-U99999', ...wFlag, '--no-color', fromSha, toSha, '--', filePath],
    repoPath,
    token
  );

  const diffOutput = result.stdout;
  if (!diffOutput.trim()) return null;

  // Extract just the patch portion (from first @@ line onward)
  const lines = diffOutput.split('\n');
  let patchStartIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('@@')) {
      patchStartIdx = i;
      break;
    }
  }

  if (patchStartIdx < 0) return null;
  return lines.slice(patchStartIdx).join('\n').trimEnd();
}

/**
 * Run git merge-tree --write-tree, tolerating exit code 1 (conflicts).
 * Returns the tree SHA from the first line of stdout.
 */
async function execGitMergeTree(
  repoPath: string,
  mergeBase: string,
  branch1: string,
  branch2: string,
  token?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'git',
      ['merge-tree', '--write-tree', `--merge-base=${mergeBase}`, branch1, branch2],
      { cwd: repoPath, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }
    );

    activeProcesses.add(proc);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      activeProcesses.delete(proc);
      // exit 0 = clean merge, exit 1 = conflicts (tree still written)
      if (code === 0 || code === 1) {
        const treeSha = stdout.trim().split('\n')[0];
        if (treeSha && /^[0-9a-f]{40,}$/.test(treeSha)) {
          resolve(treeSha);
        } else {
          const sanitized = token ? sanitizeError(stderr, token) : stderr;
          reject(new Error(`merge-tree produced no valid tree SHA: ${sanitized}`));
        }
      } else {
        const sanitized = token ? sanitizeError(stderr, token) : stderr;
        reject(new Error(`merge-tree failed (exit ${code}): ${sanitized}`));
      }
    });

    proc.on('error', (err) => {
      activeProcesses.delete(proc);
      reject(err);
    });
  });
}

/**
 * Compute a cross-revision diff that excludes base branch changes.
 *
 * Uses a three-way merge (via `git merge-tree`) to "rebase" fromHead's
 * changes onto toMergeBase, producing a tree that represents rev1's PR
 * changes as if they were applied to the same base as rev2. Diffing that
 * rebased tree against toHead shows only what the PR author changed between
 * the two revisions.
 *
 * If the merge bases are identical (base branch didn't change), falls back
 * to a simple two-dot diff since no rebasing is needed.
 */
export async function computeCrossRevisionDiff(
  owner: string,
  repo: string,
  fromMergeBase: string,
  fromHead: string,
  toMergeBase: string,
  toHead: string,
  token: string,
  options?: { ignoreWhitespace?: boolean }
): Promise<Array<{
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}>> {
  // If merge bases are the same, no base branch changes to exclude
  if (fromMergeBase === toMergeBase) {
    return computeCrossDiff(owner, repo, fromHead, toHead, token, options);
  }

  const repoPath = getRepoPath(owner, repo);

  await ensureRepo(owner, repo, token);

  // Ensure all refs are available locally
  const refsToFetch: string[] = [];
  for (const ref of [fromMergeBase, fromHead, toMergeBase, toHead]) {
    if (!await hasRef(repoPath, ref, token)) refsToFetch.push(ref);
  }
  if (refsToFetch.length > 0) await fetchRefs(owner, repo, refsToFetch, token, config.git.shallowDepth);

  // Three-way merge: base=fromMergeBase, ours=toMergeBase, theirs=fromHead
  // This produces a tree representing fromHead's PR changes rebased onto toMergeBase.
  // Note: merge-tree exits 0 on clean merge, 1 on conflicts (but still outputs a tree).
  // We use execGitRaw to handle both cases.
  let rebasedSha: string;
  try {
    const rebasedTree = await execGitMergeTree(
      repoPath, fromMergeBase, toMergeBase, fromHead, token
    );

    // Create a commit object from the rebased tree so we can diff it
    const commitResult = await execGit(
      ['commit-tree', rebasedTree, '-p', toMergeBase, '-m', 'virtual-rebased'],
      repoPath,
      token
    );
    rebasedSha = commitResult.stdout.trim();
  } catch {
    // merge-tree failed entirely — fall back to naive diff
    return computeCrossDiff(owner, repo, fromHead, toHead, token, options);
  }

  return computeCrossDiff(owner, repo, rebasedSha, toHead, token, options);
}

export function cleanupGitProcesses(): void {
  if (activeProcesses.size === 0) return;

  console.log(`Terminating ${activeProcesses.size} active git processes...`);

  for (const proc of activeProcesses) {
    try {
      proc.kill('SIGTERM');
    } catch (err) {
      // Process may have already exited
    }
  }

  activeProcesses.clear();
}
