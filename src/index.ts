import Fastify from 'fastify';
import pino from 'pino';
import fastifyView from '@fastify/view';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import ejs from 'ejs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { initDb, closeDb, query } from './db/index.js';
import { cleanupOctokit, initOctokit } from './lib/github.js';
import { cleanupGitProcesses } from './lib/git.js';
import { authRoutes } from './routes/auth.js';
import { homeRoutes } from './routes/home.js';
import { prRoutes } from './routes/pr.js';
import { repoRoutes } from './routes/repos.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { notificationRoutes } from './routes/notifications.js';
import { authMiddleware, initTokenAuth } from './middleware/auth.js';

const isDev = process.env.NODE_ENV !== 'production';

// In dev, run pino-pretty as an in-process stream rather than a `transport`.
// A transport runs pino-pretty in a worker thread via thread-stream, which
// crashes ("this should not happen: undefined") when the worker inherits the
// `--import tsx/esm` loader from the dev runner. An in-process stream avoids
// the worker thread entirely while keeping the same pretty output.
// pino-pretty is a devDependency, so only import it when actually in dev.
const logger = isDev
  ? pino(
      { level: 'info' },
      (await import('pino-pretty')).default({
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      })
    )
  : pino({ level: 'info' }); // Plain JSON logging in production

const fastify = Fastify({ logger });

async function start() {
  try {
    // Initialize database
    initDb(config.databasePath);

    // Initialize GitHub token authentication
    await initTokenAuth();

    // Initialize Octokit singleton
    initOctokit(config.githubToken);

    // Register plugins
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

    // Clean up old file reviews on startup and daily
    const cleanupOldFileReviews = () => {
      try {
        query(`DELETE FROM file_reviews WHERE reviewed_at < datetime('now', '-30 days')`);
      } catch (err) {
        console.error('Failed to clean up old file reviews:', err);
      }
    };
    cleanupOldFileReviews();
    setInterval(cleanupOldFileReviews, 24 * 60 * 60 * 1000);

    // Start server
    await fastify.listen({ port: config.port, host: config.host });
    console.log(`Server running at http://${config.host}:${config.port}`);
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
