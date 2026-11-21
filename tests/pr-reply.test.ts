import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { FastifyInstance } from 'fastify';
import { initDb, closeDb, query } from '../src/db/index.js';

/**
 * The `/reply` endpoint was written before its producer was removed, so it has never been
 * exercised. These tests hold the two halves that make the diff's reply dialog work: the
 * redirect that keeps the reader in the diff, and the `/file-diff` cache gate that would
 * otherwise serve a comment-free table over a file that just gained a comment.
 */

const PATCH = '@@ -1,3 +1,4 @@\n line 1\n+new line\n line 2\n line 3\n';
const USER_ID = 42;

const mocks = vi.hoisted(() => ({
  replyToReviewComment: vi.fn(),
  fetchReviewComments: vi.fn(),
}));

vi.mock('../src/lib/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/github.js')>();
  return {
    ...actual,
    replyToReviewComment: mocks.replyToReviewComment,
    fetchReviewComments: mocks.fetchReviewComments,
    // createUserOctokit hands back the singleton, which throws before initOctokit runs.
    // The mocked fetchers above never touch the client, so a stand-in is enough.
    createUserOctokit: () => ({}) as any,
    fetchPR: async () => ({ head: { sha: 'abc' }, base: { sha: 'base' } }),
    fetchPRFiles: async () => [
      {
        filename: 'src/foo.ts',
        status: 'modified',
        sha: 'file-sha',
        additions: 1,
        deletions: 0,
        patch: PATCH,
      },
    ],
  };
});

describe('reply and the file-diff comment gate', () => {
  let fastify: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'test-token';

    dir = mkdtempSync(join(tmpdir(), 'argus-reply-test-'));
    initDb(join(dir, 'test.db'));
    query(`CREATE TABLE api_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key TEXT NOT NULL UNIQUE,
      etag TEXT,
      data TEXT,
      fetched_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    )`);
    query(`CREATE TABLE user_preferences (
      user_id INTEGER NOT NULL,
      preference_key TEXT NOT NULL,
      preference_value TEXT NOT NULL,
      PRIMARY KEY (user_id, preference_key)
    )`);
    query(`CREATE TABLE diff_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      file_path TEXT NOT NULL,
      highlighted INTEGER NOT NULL DEFAULT 1,
      diff_data TEXT NOT NULL,
      rendered_html TEXT,
      fetched_at TEXT DEFAULT (datetime('now')),
      UNIQUE(owner, repo, head_sha, file_path, highlighted)
    )`);
    // Highlighting off keeps the render off the git cache, which this test does not set up.
    query(`INSERT INTO user_preferences (user_id, preference_key, preference_value)
           VALUES (?, ?, ?)`, [USER_ID, 'syntax_o/r', '0']);

    const { prRoutes } = await import('../src/routes/pr.js');

    fastify = Fastify();
    fastify.decorateRequest('user', null);
    fastify.decorateReply('view', function (this: any, template: string) {
      return this.type('text/plain').send(`view:${template}`);
    });
    // Stand-in for the auth middleware.
    fastify.addHook('onRequest', async (request) => {
      (request as any).user = {
        accessToken: 'token',
        githubUserId: USER_ID,
        login: 'reviewer',
        avatarUrl: '',
      };
    });

    await fastify.register(prRoutes);
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify?.close();
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  const postReply = (payload: Record<string, string>) => fastify.inject({
    method: 'POST',
    url: '/pr/o/r/1/reply',
    payload,
  });

  it('sends the reply and returns to the diff, anchored on the new comment', async () => {
    mocks.replyToReviewComment.mockResolvedValue(999);

    const res = await postReply({ comment_id: '7', body: 'thanks', return_to: 'review' });

    expect(mocks.replyToReviewComment).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/pr/o/r/1?tab=review#comment-999');
  });

  it('still lands on the conversation tab without return_to', async () => {
    mocks.replyToReviewComment.mockResolvedValue(1000);

    const res = await postReply({ comment_id: '7', body: 'thanks' });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/pr/o/r/1?tab=conversation');
  });

  it('renders a commented file live instead of serving its comment-free cache row', async () => {
    query(`INSERT OR REPLACE INTO diff_cache
             (owner, repo, head_sha, file_path, highlighted, diff_data, rendered_html)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['o', 'r', 'abc', 'src/foo.ts', 0, PATCH,
        '<table class="diff-table"><tbody><tr><td>CACHED-TABLE</td></tr></tbody></table>']);
    mocks.fetchReviewComments.mockResolvedValue([{
      id: 7,
      path: 'src/foo.ts',
      line: 2,
      side: 'RIGHT',
      body: 'a comment',
      user: { login: 'alice', avatar_url: '' },
      created_at: new Date(0).toISOString(),
    }]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/pr/o/r/1/file-diff?path=src/foo.ts',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().html).toContain('comment-thread');
    expect(res.json().html).not.toContain('CACHED-TABLE');
  });

  it('keeps serving the cache row for a file with no comments', async () => {
    mocks.fetchReviewComments.mockResolvedValue([]);

    const res = await fastify.inject({
      method: 'GET',
      url: '/pr/o/r/1/file-diff?path=src/foo.ts',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().html).toContain('CACHED-TABLE');
  });
});
