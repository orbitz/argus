import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, query } from '../src/db/index.js';
import {
  cachedFetch,
  invalidateCache,
  getFetchedAt,
  evictExpiredCache,
  prCacheKeys,
} from '../src/lib/api-cache.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'argus-cache-test-'));
  initDb(join(dir, 'test.db'));
  query(`CREATE TABLE api_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cache_key TEXT NOT NULL UNIQUE,
    etag TEXT,
    data TEXT,
    fetched_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT
  )`);
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

/** A fetcher that counts calls and records the headers it was handed. */
function spy<T>(value: T, etag: string | null = 'etag-1') {
  const calls: Array<Record<string, string>> = [];
  const fn = async (headers: Record<string, string>) => {
    calls.push({ ...headers });
    return { data: value, etag };
  };
  return { fn, calls };
}

/** Wait for background revalidation promises to settle. */
const flush = () => new Promise((r) => setImmediate(r));

describe('cachedFetch', () => {
  it('fetches and caches on a miss', async () => {
    const s = spy({ n: 1 });
    const result = await cachedFetch('k', { ttlMs: 60_000 }, s.fn);

    expect(result.data).toEqual({ n: 1 });
    expect(result.fromCache).toBe(false);
    expect(result.stale).toBe(false);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]['If-None-Match']).toBeUndefined();
  });

  it('serves a fresh entry from local storage without any network call', async () => {
    const s = spy({ n: 1 });
    await cachedFetch('k', { ttlMs: 60_000 }, s.fn);
    const second = await cachedFetch('k', { ttlMs: 60_000 }, s.fn);

    expect(second.data).toEqual({ n: 1 });
    expect(second.fromCache).toBe(true);
    expect(second.stale).toBe(false);
    // The whole point: a warm read costs zero requests.
    expect(s.calls).toHaveLength(1);
  });

  it('serves a stale entry immediately and revalidates in the background', async () => {
    const s = spy({ n: 1 });
    await cachedFetch('k', { ttlMs: 60_000 }, s.fn);

    // Expire the entry without changing fetched_at beyond the stale ceiling.
    query(`UPDATE api_cache SET expires_at = ? WHERE cache_key = ?`, [
      new Date(Date.now() - 1000).toISOString(),
      'k',
    ]);

    const s2 = spy({ n: 2 }, 'etag-2');
    const result = await cachedFetch('k', { ttlMs: 60_000 }, s2.fn);

    // Returns the old value straight away rather than blocking.
    expect(result.data).toEqual({ n: 1 });
    expect(result.stale).toBe(true);
    expect(result.fromCache).toBe(true);

    await flush();
    // ...but a refresh was kicked off, and it sent the stored ETag.
    expect(s2.calls).toHaveLength(1);
    expect(s2.calls[0]['If-None-Match']).toBe('etag-1');

    // The next read sees the refreshed value.
    const s3 = spy({ n: 99 });
    const third = await cachedFetch('k', { ttlMs: 60_000 }, s3.fn);
    expect(third.data).toEqual({ n: 2 });
    expect(s3.calls).toHaveLength(0);
  });

  it('blocks rather than serving data older than maxStaleMs', async () => {
    const s = spy({ n: 1 });
    await cachedFetch('k', { ttlMs: 60_000 }, s.fn);

    query(`UPDATE api_cache SET fetched_at = ?, expires_at = ? WHERE cache_key = ?`, [
      new Date(Date.now() - 60 * 60_000).toISOString(),
      new Date(Date.now() - 59 * 60_000).toISOString(),
      'k',
    ]);

    const s2 = spy({ n: 2 }, 'etag-2');
    const result = await cachedFetch('k', { ttlMs: 60_000, maxStaleMs: 5_000 }, s2.fn);

    expect(result.data).toEqual({ n: 2 });
    expect(result.stale).toBe(false);
    expect(s2.calls).toHaveLength(1);
  });

  it('bypass mode skips the cache but still sends the stored ETag', async () => {
    const s = spy({ n: 1 });
    await cachedFetch('k', { ttlMs: 60_000 }, s.fn);

    const s2 = spy({ n: 2 }, 'etag-2');
    const result = await cachedFetch('k', { ttlMs: 60_000, mode: 'bypass' }, s2.fn);

    expect(result.data).toEqual({ n: 2 });
    expect(s2.calls).toHaveLength(1);
    expect(s2.calls[0]['If-None-Match']).toBe('etag-1');
  });

  it('returns the cached body when the fetcher reports 304', async () => {
    const s = spy({ n: 1 });
    await cachedFetch('k', { ttlMs: 60_000 }, s.fn);

    let called = 0;
    const notModified = async () => {
      called++;
      throw Object.assign(new Error('Not Modified'), { status: 304 });
    };

    const result = await cachedFetch('k', { ttlMs: 60_000, mode: 'bypass' }, notModified);
    expect(result.data).toEqual({ n: 1 });
    expect(called).toBe(1);
  });

  it('deduplicates concurrent fetches for the same key', async () => {
    let calls = 0;
    const slow = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { data: { n: 1 }, etag: 'e' };
    };

    const results = await Promise.all([
      cachedFetch('k', { ttlMs: 60_000 }, slow),
      cachedFetch('k', { ttlMs: 60_000 }, slow),
      cachedFetch('k', { ttlMs: 60_000 }, slow),
    ]);

    expect(calls).toBe(1);
    for (const r of results) expect(r.data).toEqual({ n: 1 });
  });

  it('does not rewrite the body when the ETag is unchanged', async () => {
    const s = spy({ n: 1 }, 'same-etag');
    await cachedFetch('k', { ttlMs: 60_000 }, s.fn);

    // Corrupt the stored body; if the unchanged-ETag path rewrote it, this would be
    // replaced by the fetcher's value.
    query(`UPDATE api_cache SET data = ?, expires_at = ? WHERE cache_key = ?`, [
      JSON.stringify({ sentinel: true }),
      new Date(Date.now() - 1000).toISOString(),
      'k',
    ]);

    await cachedFetch('k', { ttlMs: 60_000, mode: 'bypass' }, s.fn);

    const { rows } = query<{ data: string }>(
      `SELECT data FROM api_cache WHERE cache_key = ?`,
      ['k']
    );
    expect(JSON.parse(rows[0].data)).toEqual({ sentinel: true });
  });

  it('falls back to a blocking fetch when the cached row is corrupt', async () => {
    const s = spy({ n: 1 });
    await cachedFetch('k', { ttlMs: 60_000 }, s.fn);
    query(`UPDATE api_cache SET data = ? WHERE cache_key = ?`, ['not json', 'k']);

    const s2 = spy({ n: 2 });
    const result = await cachedFetch('k', { ttlMs: 60_000 }, s2.fn);
    expect(result.data).toEqual({ n: 2 });
    expect(s2.calls).toHaveLength(1);
  });
});

describe('invalidateCache', () => {
  it('forces the next read to hit the network', async () => {
    const s = spy({ n: 1 });
    await cachedFetch('k', { ttlMs: 60_000 }, s.fn);
    invalidateCache(['k']);

    const s2 = spy({ n: 2 });
    const result = await cachedFetch('k', { ttlMs: 60_000 }, s2.fn);

    expect(result.data).toEqual({ n: 2 });
    expect(result.fromCache).toBe(false);
    expect(s2.calls[0]['If-None-Match']).toBeUndefined();
  });

  it('is a no-op for an empty key list', () => {
    expect(() => invalidateCache([])).not.toThrow();
  });
});

describe('prCacheKeys', () => {
  it('covers every resource the PR page fetches', () => {
    const keys = prCacheKeys('o', 'r', 7);
    expect(keys).toContain('pr:o/r#7');
    expect(keys).toContain('pr-files:o/r#7');
    expect(keys).toContain('pr-reviews:o/r#7');
    expect(keys).toContain('pr-review-comments:o/r#7');
    expect(keys).toContain('pr-issue-comments:o/r#7');
    expect(keys).toContain('pr-commits:o/r#7');
    expect(keys).toContain('pr-timeline:o/r#7');
  });
});

describe('getFetchedAt / evictExpiredCache', () => {
  it('reports when a key was last confirmed', async () => {
    expect(getFetchedAt('missing')).toBeNull();
    await cachedFetch('k', { ttlMs: 60_000 }, spy({ n: 1 }).fn);
    const at = getFetchedAt('k');
    expect(at).toBeInstanceOf(Date);
    expect(Date.now() - at!.getTime()).toBeLessThan(5_000);
  });

  it('deletes rows older than the cutoff and keeps recent ones', async () => {
    await cachedFetch('old', { ttlMs: 60_000 }, spy({ n: 1 }).fn);
    await cachedFetch('new', { ttlMs: 60_000 }, spy({ n: 2 }).fn);
    query(`UPDATE api_cache SET fetched_at = ? WHERE cache_key = ?`, [
      new Date(Date.now() - 48 * 3600_000).toISOString(),
      'old',
    ]);

    evictExpiredCache(24 * 3600_000);

    const { rows } = query<{ cache_key: string }>(`SELECT cache_key FROM api_cache`);
    expect(rows.map((r) => r.cache_key)).toEqual(['new']);
  });
});
