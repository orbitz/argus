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
