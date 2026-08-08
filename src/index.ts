import Fastify from 'fastify';
import pino from 'pino';
import fastifyView from '@fastify/view';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyCompress from '@fastify/compress';
import ejs from 'ejs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { initDb, closeDb, query } from './db/index.js';
import { cleanupOctokit, initOctokit } from './lib/github.js';
import { evictExpiredCache } from './lib/api-cache.js';
import { getHighlighterInstance } from './lib/syntax-highlighter.js';
import { warmHighlightPool } from './lib/highlight-pool.js';
import { startPrefetch, stopPrefetch } from './lib/prefetch.js';
import { cleanupGitProcesses, setGitLogger } from './lib/git.js';
import { authRoutes } from './routes/auth.js';
import { homeRoutes } from './routes/home.js';
import { prRoutes } from './routes/pr.js';
import { repoRoutes } from './routes/repos.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { notificationRoutes } from './routes/notifications.js';
import { githubCompatRoutes } from './routes/github-compat.js';
import { authMiddleware, initTokenAuth } from './middleware/auth.js';

const isDev = process.env.NODE_ENV !== 'production';

// In dev, run pino-pretty as an in-process stream rather than a `transport`.
// A transport runs pino-pretty in a worker thread via thread-stream, which
// crashes ("this should not happen: undefined") when the worker inherits the
// `--import tsx/esm` loader from the dev runner. An in-process stream avoids
// the worker thread entirely while keeping the same pretty output.
// pino-pretty is a devDependency, so only import it when actually in dev.
// LOG_LEVEL=debug surfaces the per-git-command timings from lib/git.ts, which is how you tell
// a cold repo (one slow network fetch) from a warm one (several wasted local spawns).
const logLevel = process.env.LOG_LEVEL || 'info';

const logger = isDev
  ? pino(
      { level: logLevel },
      (await import('pino-pretty')).default({
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      })
    )
  : pino({ level: logLevel }); // Plain JSON logging in production

const fastify = Fastify({ logger });

async function start() {
  try {
    // Initialize database
    initDb(config.databasePath);

    // Initialize GitHub token authentication
    await initTokenAuth();

    // Initialize Octokit singleton
    initOctokit(config.githubToken);

    // Let git.ts report per-command timings (visible at LOG_LEVEL=debug).
    setGitLogger(fastify.log);

    // Register plugins
    // Rendered diffs are large HTML tables that compress extremely well.
    await fastify.register(fastifyCompress, { global: true, encodings: ['br', 'gzip', 'deflate'] });

    await fastify.register(fastifyCookie);

    await fastify.register(fastifyFormbody);

    await fastify.register(fastifyView, {
      engine: { ejs },
      root: join(__dirname, 'templates'),
      viewExt: 'ejs',
      defaultContext: {
        baseUrl: config.baseUrl,
      },
    });

    await fastify.register(fastifyStatic, {
      root: join(__dirname, '..', 'public'),
      prefix: '/static/',
      // Previously served with max-age=0, so pr.js (56 KB) was revalidated on every
      // navigation. Assets still carry ETags, so a deploy is picked up on the next
      // revalidation after this window.
      maxAge: '5m',
    });

    // Add auth context to all requests
    fastify.decorateRequest('user', null);
    fastify.addHook('preHandler', authMiddleware);

    // Register routes
    await fastify.register(homeRoutes);
    await fastify.register(authRoutes, { prefix: '/auth' });
    await fastify.register(repoRoutes);
    await fastify.register(prRoutes);
    await fastify.register(dashboardRoutes);
    await fastify.register(notificationRoutes);
    // Registered last: these are catch-all-shaped param routes for github.com's own URLs,
    // and every route above is more specific than they are.
    await fastify.register(githubCompatRoutes);

    // Clean up old file reviews and expired cache rows on startup and daily.
    // api_cache previously grew without bound, so writes got slower over time.
    const runDailyCleanup = () => {
      try {
        query(`DELETE FROM file_reviews WHERE reviewed_at < datetime('now', '-30 days')`);
      } catch (err) {
        console.error('Failed to clean up old file reviews:', err);
      }
      try {
        evictExpiredCache();
      } catch (err) {
        console.error('Failed to evict expired api_cache rows:', err);
      }
      try {
        query(`DELETE FROM diff_cache WHERE fetched_at < datetime('now', '-7 days')`);
      } catch (err) {
        console.error('Failed to clean up old diff cache:', err);
      }
    };
    runDailyCleanup();
    // unref so a pending timer never holds the process open during shutdown.
    setInterval(runDailyCleanup, 24 * 60 * 60 * 1000).unref();

    // Load Shiki's WASM engine and grammars now rather than inside the first PR render.
    // In watch mode this cost was paid again after every restart. The pool's workers each
    // build their own highlighter, so they need the same treatment — otherwise the first PR
    // after a restart pays ~1s of grammar loading on every worker at once.
    getHighlighterInstance().catch((err: unknown) =>
      fastify.log.warn({ err }, 'Shiki pre-warm failed; will initialize on first use')
    );
    warmHighlightPool();

    // Start server
    await fastify.listen({ port: config.port, host: config.host });
    console.log(`Server running at http://${config.host}:${config.port}`);

    startPrefetch(fastify.log);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  const shutdownStart = Date.now();

  // Reduced timeout - should complete in <1s normally
  const forceExitTimer = setTimeout(() => {
    console.error('Forced shutdown after 3s timeout');
    process.exit(1);
  }, 3000);

  try {
    // 0. Stop background cache warming so it can't start new work mid-shutdown
    stopPrefetch();

    // 1. Close Fastify server (stops accepting new connections)
    await fastify.close();
    console.log(`Fastify closed (${Date.now() - shutdownStart}ms)`);

    // 2. Terminate any active git processes
    cleanupGitProcesses();
    console.log(`Git cleanup (${Date.now() - shutdownStart}ms)`);

    // 3. Close HTTP agents (Octokit cleanup)
    cleanupOctokit();
    console.log(`HTTP agents closed (${Date.now() - shutdownStart}ms)`);

    // 4. Close database with WAL checkpoint
    closeDb();
    console.log(`Database closed (${Date.now() - shutdownStart}ms)`);

    // Clean exit
    clearTimeout(forceExitTimer);
    const totalTime = Date.now() - shutdownStart;
    console.log(`Shutdown completed in ${totalTime}ms`);
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    clearTimeout(forceExitTimer);
    process.exit(1);
  }
}

// Handle shutdown signals
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  shutdown('unhandledRejection');
});

start();
