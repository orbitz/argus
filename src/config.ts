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
    // Fetch the dashboard in one GraphQL query instead of ~316 REST calls. Falls back
    // to the REST path automatically on error; set to '0' to disable outright.
    dashboardGraphql: optional('DASHBOARD_GRAPHQL', '1') !== '0',
    // How many repos the dashboard considers, and open PRs per repo.
    dashboardRepoLimit: parseInt(optional('DASHBOARD_REPO_LIMIT', '15'), 10),
    dashboardPrsPerRepo: parseInt(optional('DASHBOARD_PRS_PER_REPO', '10'), 10),
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
    lazyLineThreshold: parseInt(optional('LAZY_DIFF_LINE_THRESHOLD', '5000'), 10),
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
