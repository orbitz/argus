import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * A merge GitHub refuses cannot be made to succeed by asking again, but the retry plugin
 * did not know that: 405 (branch protection blocked the merge) and 409 (the head moved)
 * are absent from its default doNotRetry list, so every refused merge was sent four times
 * with backoff before the error reached the user — the whole time behind a loading
 * overlay, looking hung.
 *
 * These tests drive the real Octokit instance Argus builds, with fetch stubbed, so they
 * assert the wiring rather than a copy of it.
 */
describe('octokit retry policy', () => {
  let calls: string[];

  async function octokit() {
    process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'test-token';
    vi.resetModules();
    const { initOctokit } = await import('../src/lib/github.js');
    return initOctokit('test-token');
  }

  function stubFetch(status: number, body: unknown) {
    calls = [];
    vi.stubGlobal('fetch', async (url: any, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
  }

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not retry a 405 — the merge GitHub refuses on branch protection', async () => {
    stubFetch(405, {
      message: 'At least 1 approving review is required by reviewers with write access.',
    });
    const kit = await octokit();

    await expect(
      kit.pulls.merge({ owner: 'o', repo: 'r', pull_number: 1 })
    ).rejects.toMatchObject({ status: 405 });

    expect(calls).toHaveLength(1);
  });

  it('does not retry a 409 — the head branch moved under the merge', async () => {
    stubFetch(409, { message: 'Head branch was modified. Review and try the merge again.' });
    const kit = await octokit();

    await expect(
      kit.pulls.merge({ owner: 'o', repo: 'r', pull_number: 1 })
    ).rejects.toMatchObject({ status: 409 });

    expect(calls).toHaveLength(1);
  });

  it('still retries a 500, which is what the retry plugin is for', async () => {
    stubFetch(500, { message: 'Server Error' });
    const kit = await octokit();

    await expect(
      kit.request('GET /repos/{owner}/{repo}', {
        owner: 'o',
        repo: 'r',
        request: { retries: 2, retryAfter: 0 },
      })
    ).rejects.toMatchObject({ status: 500 });

    expect(calls.length).toBeGreaterThan(1);
  });
}, 30_000);
