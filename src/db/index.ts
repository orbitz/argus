import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

let db: Database.Database | null = null;

export function initDb(dbPath: string): Database.Database {
  // Ensure directory exists
  const dir = dirname(dbPath);
  if (dir && dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // NORMAL is the standard pairing with WAL: durable across process crashes, and only at
  // risk from an OS-level crash. The default FULL costs an fsync per commit, which is
  // significant here because cache writes are individual implicit transactions.
  db.pragma('synchronous = NORMAL');

  // Default is 0, meaning a concurrent writer fails immediately with SQLITE_BUSY instead
  // of waiting.
  db.pragma('busy_timeout = 5000');

  // Negative value = KiB. 64 MB of page cache comfortably holds the hot cache tables.
  db.pragma('cache_size = -64000');

  // Memory-map the database (256 MB) so reads avoid a copy through the page cache.
  db.pragma('mmap_size = 268435456');

  statementCache = new WeakMap();

  return db;
}

/**
 * Prepared statements keyed by SQL text. query() used to call prepare() on every single
 * invocation — on the dashboard that meant hundreds of re-parses per request. Keyed off
 * the Database object so a reopened connection starts clean.
 */
let statementCache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

function prepareCached(database: Database.Database, sql: string): Database.Statement {
  let forDb = statementCache.get(database);
  if (!forDb) {
    forDb = new Map();
    statementCache.set(database, forDb);
  }
  let stmt = forDb.get(sql);
  if (!stmt) {
    stmt = database.prepare(sql);
    forDb.set(sql, stmt);
  }
  return stmt;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb first.');
  }
  return db;
}

// Query helper that mimics pg's interface for easier migration
export function query<T = any>(
  sql: string,
  params: any[] = []
): { rows: T[] } {
  const database = getDb();

  // Check if it's a SELECT query
  const isSelect = sql.trim().toUpperCase().startsWith('SELECT');

  const stmt = prepareCached(database, sql);
  if (isSelect) {
    return { rows: stmt.all(...params) as T[] };
  }
  stmt.run(...params);
  return { rows: [] };
}

// Run a single statement (for migrations, etc.)
export function run(sql: string, params: any[] = []): Database.RunResult {
  const database = getDb();
  const stmt = database.prepare(sql);
  return stmt.run(...params);
}

// Execute multiple statements (for migrations)
export function exec(sql: string): void {
  const database = getDb();
  database.exec(sql);
}

export function closeDb(): void {
  if (!db) return;

  const dbRef = db;
  db = null;

  try {
    // Force WAL checkpoint to ensure all data is written
    dbRef.pragma('wal_checkpoint(TRUNCATE)');
  } catch (err) {
    console.error('WAL checkpoint failed:', err);
  }

  try {
    dbRef.close();
  } catch (err) {
    console.error('Database close failed:', err);
  }
}
