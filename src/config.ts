import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, defaultValue: string = ''): string {
  return process.env[name] || defaultValue;
}

export const config = {
  // Server
  port: parseInt(optional('PORT', '3000'), 10),
  host: optional('HOST', '0.0.0.0'),
  baseUrl: optional('BASE_URL', 'http://localhost:3000'),

  // Database (SQLite)
  databasePath: optional('DATABASE_PATH', './data/argus.db'),

  // GitHub Token
  githubToken: required('GITHUB_TOKEN'),

  // Cache
  cacheTtl: parseInt(optional('CACHE_TTL', '60'), 10),

  github: {
    requestTimeoutMs: parseInt(optional('GITHUB_REQUEST_TIMEOUT_MS', '30000'), 10),
    // The dashboard is built from GitHub search (see lib/dashboard-overview.ts), so it has
    // no repo/PR limits to tune: what it shows is scoped by the search queries themselves.
  },

  // Background cache warming
  prefetch: {
    enabled: optional('PREFETCH_ENABLED', '1') !== '0',
    intervalMs: parseInt(optional('PREFETCH_INTERVAL_MS', '180000'), 10),
    // Cap on PRs warmed per pass, after unchanged ones are skipped.
    maxPRsPerPass: parseInt(optional('PREFETCH_MAX_PRS', '20'), 10),
    concurrency: parseInt(optional('PREFETCH_CONCURRENCY', '4'), 10),
  },

  // UI defaults
  ui: {
    pollIntervalMs: 45000,
  },

  // Diff rendering
  diff: {
    // When a PR changes more than this many files, the Files view renders lightweight
    // file shells and loads each file's diff body lazily on expand (keeps very large
    // PRs responsive). Below the threshold, all diffs render eagerly as before.
    lazyFileThreshold: parseInt(optional('LAZY_DIFF_FILE_THRESHOLD', '75'), 10),
    // A file-count threshold alone misses the other shape of expensive PR: a handful of
    // files with enormous diffs. Syntax highlighting costs ~0.5ms per line, so 20k changed
    // lines is ~10s of render regardless of how few files they live in.
    // Measured: a 28-file, ~3,700-changed-line PR rendered 5,447 diff rows into a 4.15 MB
    // document — served in 95ms, then slow enough in the browser that scrolling and reload
    // stalled. The threshold was 5000, so a PR of that shape rendered eagerly. Changed
    // lines undercount the rows actually emitted, since each hunk carries context too.
    lazyLineThreshold: parseInt(optional('LAZY_DIFF_LINE_THRESHOLD', '2500'), 10),
    // Syntax highlighting tokenizes the whole file, not just the diff, so that constructs
    // closed inside an elided region are still seen (see getFullContextPatches). Past this
    // many lines that stops paying for itself and highlighting falls back to per-hunk.
    fullContextMaxLines: parseInt(optional('FULL_CONTEXT_MAX_LINES', '20000'), 10),
    // Worker threads used for syntax highlighting. Shiki's tokenizer is synchronous, so
    // in-process it blocks the event loop for the whole render. Each worker costs ~57MB
    // resident, so this is a memory-for-latency trade: 0 disables the pool and highlights
    // inline; -1 (the default) sizes it from the machine, up to four.
    highlightWorkers: parseInt(optional('HIGHLIGHT_WORKERS', '-1'), 10),
  },

  // Git operations
  git: {
    cacheDir: optional('GIT_CACHE_DIR', '/tmp/argus-git-cache'),
    // Diff-only operations (git diff A B) only need the trees at each commit,
    // so a depth-1 fetch is enough.
    shallowDepth: 1,
    // Starting depth for history-dependent ops (merge-base); deepened on demand.
    mergeBaseDepth: 50,
    fetchDepth: 200,
    fetchDeepDepth: 500,
    commandTimeout: 60000,
  },
} as const;
