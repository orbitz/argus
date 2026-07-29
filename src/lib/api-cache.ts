/**
 * GitHub API response cache.
 *
 * The previous implementation read the cache only to obtain an ETag and then always
 * issued the HTTP request, so a warm cache saved bandwidth but zero latency. This layer
 * serves fresh entries entirely from SQLite (no network at all) and serves stale entries
 * immediately while revalidating in the background.
 */

import { config } from '../config.js';
import { query } from '../db/index.js';

export type CacheMode = 'normal' | 'bypass';

export interface CachedResult<T> {
  data: T;
  /** When the underlying data was last confirmed against GitHub. */
  fetchedAt: Date;
  /** True when served past its TTL with a background revalidation in flight. */
  stale: boolean;
  /** False when this request had to block on the network. */
  fromCache: boolean;
}

export interface FetchResult<T> {
  data: T;
  etag: string | null;
}

export interface CacheOptions {
  ttlMs: number;
  mode?: CacheMode;
  /**
   * Hard ceiling on serving stale data. Past this age we block on the network rather
   * than hand back something very old, so a persistently failing revalidation can't
   * silently pin the UI to an ancient snapshot. Defaults to 10x the TTL.
   */
  maxStaleMs?: number;
}

interface CacheRow {
  data: string;
  etag: string | null;
  fetched_at: string;
  expires_at: string | null;
}

// Skip caching payloads above this size. Guards against both SQLite bloat and V8's
// max string length (~512M chars): a huge PR's file list can exceed it and make
// JSON.stringify throw "Invalid string length". Oversized responses simply aren't cached.
const MAX_CACHE_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Concurrent requests for the same key share one network call. Without this a page load
 * and a background prefetch pass can easily duplicate every request.
 */
const inflight = new Map<string, Promise<unknown>>();

/** SQLite's datetime('now') yields 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker. */
function parseDbTime(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return new Date(`${value.replace(' ', 'T')}Z`);
  }
  return new Date(value);
}

function toDbTime(date: Date): string {
  return date.toISOString();
}

function readRow(cacheKey: string): CacheRow | null {
  // Deliberately unfiltered by expires_at: an expired row still carries a usable ETag
  // and a body worth serving while we revalidate. The old query hid both.
  const { rows } = query<CacheRow>(
    `SELECT data, etag, fetched_at, expires_at FROM api_cache WHERE cache_key = ?`,
    [cacheKey]
  );
  return rows.length > 0 ? rows[0] : null;
}

function writeRow(cacheKey: string, etag: string | null, data: unknown, ttlMs: number): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return; // e.g. RangeError: Invalid string length — too big to cache, not fatal
  }
  if (serialized.length > MAX_CACHE_BYTES) return;

  const now = new Date();
  query(
    `INSERT INTO api_cache (cache_key, etag, data, fetched_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (cache_key) DO UPDATE SET
       etag = excluded.etag,
       data = excluded.data,
       fetched_at = excluded.fetched_at,
       expires_at = excluded.expires_at`,
    [cacheKey, etag, serialized, toDbTime(now), toDbTime(new Date(now.getTime() + ttlMs))]
  );
}

/**
 * Extend the TTL without rewriting the body. Used when GitHub confirms nothing changed
 * (304, or a 200 whose ETag matches), which avoids re-serializing a multi-KB payload on
 * every load — the dashboard alone did that hundreds of times per request.
 */
function touchRow(cacheKey: string, ttlMs: number): void {
  const now = new Date();
  query(
    `UPDATE api_cache SET fetched_at = ?, expires_at = ? WHERE cache_key = ?`,
    [toDbTime(now), toDbTime(new Date(now.getTime() + ttlMs)), cacheKey]
  );
}

function performFetch<T>(
  cacheKey: string,
  ttlMs: number,
  fetcher: (headers: Record<string, string>) => Promise<FetchResult<T>>,
  etag: string | null,
  fallback: string | null
): Promise<T> {
  const existing = inflight.get(cacheKey);
  if (existing) return existing as Promise<T>;

  const promise = (async (): Promise<T> => {
    const headers: Record<string, string> = {};
    if (etag) headers['If-None-Match'] = etag;

    try {
      const result = await fetcher(headers);
      if (result.etag && etag && result.etag === etag) {
        touchRow(cacheKey, ttlMs);
      } else {
        writeRow(cacheKey, result.etag, result.data, ttlMs);
      }
      return result.data;
    } catch (err: any) {
      // Octokit throws on 304 rather than returning it.
      if (err?.status === 304 && fallback !== null) {
        touchRow(cacheKey, ttlMs);
        return JSON.parse(fallback) as T;
      }
      throw err;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, promise);
  return promise;
}

/**
 * Fetch through the cache.
 *
 * - fresh (within TTL)      → returned from SQLite, no network
 * - stale (past TTL)        → returned immediately, revalidated in the background
 * - too stale / missing     → blocks on the network
 * - mode 'bypass'           → always blocks on the network (backs the Refresh button)
 */
export async function cachedFetch<T>(
  cacheKey: string,
  opts: CacheOptions,
  fetcher: (headers: Record<string, string>) => Promise<FetchResult<T>>
): Promise<CachedResult<T>> {
  const mode = opts.mode ?? 'normal';
  const maxStaleMs = opts.maxStaleMs ?? opts.ttlMs * 10;
  const row = readRow(cacheKey);

  // On bypass we skip the serve-from-cache paths but still reuse the stored ETag below,
  // so an unchanged resource costs a cheap 304 instead of a full transfer.
  if (mode === 'normal' && row) {
    let parsed: T | undefined;
    try {
      parsed = JSON.parse(row.data) as T;
    } catch {
      parsed = undefined; // corrupt row — fall through to a blocking fetch
    }

    if (parsed !== undefined) {
      const fetchedAt = parseDbTime(row.fetched_at);
      const expiresAt = row.expires_at ? parseDbTime(row.expires_at) : null;
      const now = Date.now();

      if (expiresAt && expiresAt.getTime() > now) {
        return { data: parsed, fetchedAt, stale: false, fromCache: true };
      }

      if (now - fetchedAt.getTime() < maxStaleMs) {
        void performFetch(cacheKey, opts.ttlMs, fetcher, row.etag, row.data).catch(() => {
          // Background revalidation failure is not user-visible; the stale copy stands
          // and the next request will try again.
        });
        return { data: parsed, fetchedAt, stale: true, fromCache: true };
      }
    }
  }

  const data = await performFetch(
    cacheKey,
    opts.ttlMs,
    fetcher,
    row?.etag ?? null,
    row?.data ?? null
  );
  return { data, fetchedAt: new Date(), stale: false, fromCache: false };
}

/** True while a background revalidation for this key is in flight. */
export function isRevalidating(cacheKey: string): boolean {
  return inflight.has(cacheKey);
}

/** When the key was last confirmed against GitHub, or null if not cached. */
export function getFetchedAt(cacheKey: string): Date | null {
  const row = readRow(cacheKey);
  return row ? parseDbTime(row.fetched_at) : null;
}

/**
 * Drop cache entries so the next read blocks on fresh data. Called after every mutation
 * (comment, review, merge) — without this, serving from local cache would let a user's
 * own action vanish behind a stale snapshot.
 */
export function invalidateCache(keys: string[]): void {
  if (keys.length === 0) return;
  const placeholders = keys.map(() => '?').join(', ');
  query(`DELETE FROM api_cache WHERE cache_key IN (${placeholders})`, keys);
  for (const key of keys) inflight.delete(key);
}

/** Every cache key belonging to a single PR, for invalidation after mutations. */
export function prCacheKeys(owner: string, repo: string, prNumber: number): string[] {
  const suffix = `${owner}/${repo}#${prNumber}`;
  return [
    `pr:${suffix}`,
    `pr-files:${suffix}`,
    `pr-reviews:${suffix}`,
    `pr-review-comments:${suffix}`,
    `pr-issue-comments:${suffix}`,
    `pr-commits:${suffix}`,
    `pr-timeline:${suffix}`,
    `pr-head-sha:${suffix}`,
  ];
}

/** Delete expired entries. api_cache previously grew without bound. */
export function evictExpiredCache(maxAgeMs = 24 * 60 * 60 * 1000): number {
  const cutoff = toDbTime(new Date(Date.now() - maxAgeMs));
  const { rows } = query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM api_cache WHERE fetched_at < ?`,
    [cutoff]
  );
  query(`DELETE FROM api_cache WHERE fetched_at < ?`, [cutoff]);
  return rows[0]?.n ?? 0;
}

/** TTLs per resource kind. Checks and statuses move far more often than comments. */
export const TTL = {
  pr: config.cacheTtl * 1000,
  files: config.cacheTtl * 1000,
  reviews: config.cacheTtl * 1000,
  comments: config.cacheTtl * 1000,
  commits: config.cacheTtl * 1000,
  timeline: config.cacheTtl * 1000,
  checks: 20_000,
  status: 20_000,
  headSha: 30_000,
  dashboard: config.cacheTtl * 1000,
  reviewRequests: 30_000,
} as const;
