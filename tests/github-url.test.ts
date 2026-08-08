import { describe, it, expect } from 'vitest';
import { mapGitHubUrl } from '../src/lib/github-url.js';

describe('mapGitHubUrl', () => {
  describe('entry points', () => {
    it('sends the github.com root to the dashboard', () => {
      expect(mapGitHubUrl('/')).toBe('/dashboard');
    });

    it('sends /pulls to the dashboard', () => {
      expect(mapGitHubUrl('/pulls')).toBe('/dashboard');
    });
  });

  describe('pull request pages', () => {
    it('maps a PR to the conversation tab', () => {
      expect(mapGitHubUrl('/octocat/hello-world/pull/42')).toBe(
        '/pr/octocat/hello-world/42?tab=conversation'
      );
    });

    it('maps files and commits onto the merged Review tab', () => {
      expect(mapGitHubUrl('/octocat/hello-world/pull/42/files')).toBe(
        '/pr/octocat/hello-world/42?tab=review'
      );
      expect(mapGitHubUrl('/octocat/hello-world/pull/42/commits')).toBe(
        '/pr/octocat/hello-world/42?tab=review'
      );
    });

    it('maps checks onto the checks tab', () => {
      expect(mapGitHubUrl('/octocat/hello-world/pull/42/checks')).toBe(
        '/pr/octocat/hello-world/42?tab=checks'
      );
    });

    it('maps a single commit to the commit view', () => {
      expect(
        mapGitHubUrl('/octocat/hello-world/pull/42/commits/0123456789abcdef0123456789abcdef01234567')
      ).toBe('/pr/octocat/hello-world/42/commit/0123456789abcdef0123456789abcdef01234567');
    });

    it('falls back to the conversation tab for sub-pages Argus has no view for', () => {
      expect(mapGitHubUrl('/octocat/hello-world/pull/42/conflicts')).toBe(
        '/pr/octocat/hello-world/42?tab=conversation'
      );
    });

    it('treats a non-sha commits argument as the commit list, not a commit', () => {
      expect(mapGitHubUrl('/octocat/hello-world/pull/42/commits/not-a-sha')).toBe(
        '/pr/octocat/hello-world/42?tab=review'
      );
    });

    it('ignores a trailing slash', () => {
      expect(mapGitHubUrl('/octocat/hello-world/pull/42/')).toBe(
        '/pr/octocat/hello-world/42?tab=conversation'
      );
    });

    it('rejects a non-numeric PR number', () => {
      expect(mapGitHubUrl('/octocat/hello-world/pull/abc')).toBeNull();
    });
  });

  describe('repo pull request lists', () => {
    it('maps /owner/repo/pulls', () => {
      expect(mapGitHubUrl('/octocat/hello-world/pulls')).toBe('/repos/octocat/hello-world/pulls');
    });

    it('drops GitHub search syntax it cannot honour', () => {
      expect(mapGitHubUrl('/octocat/hello-world/pulls', { q: 'is:open author:me' })).toBe(
        '/repos/octocat/hello-world/pulls'
      );
    });
  });

  describe('query handling', () => {
    it('carries the ignore-whitespace flag across', () => {
      expect(mapGitHubUrl('/octocat/hello-world/pull/42/files', { w: '1' })).toBe(
        '/pr/octocat/hello-world/42?tab=review&w=1'
      );
    });

    it('drops GitHub-only view options', () => {
      expect(mapGitHubUrl('/octocat/hello-world/pull/42/files', { diff: 'split' })).toBe(
        '/pr/octocat/hello-world/42?tab=review'
      );
    });

    it('takes the first value of a repeated parameter', () => {
      expect(mapGitHubUrl('/octocat/hello-world/pull/42', { w: ['1', '0'] })).toBe(
        '/pr/octocat/hello-world/42?tab=conversation&w=1'
      );
    });
  });

  describe('paths that belong to GitHub', () => {
    it.each([
      '/octocat/hello-world',
      '/octocat/hello-world/issues/7',
      '/octocat/hello-world/actions',
      '/octocat/hello-world/commit/abc123',
      '/settings/profile',
      '/orgs/acme/people',
      '/login',
      '/notifications/beta',
      '/octocat/hello-world/info/refs',
      '/octocat/hello-world/git-upload-pack',
    ])('returns null for %s', (path) => {
      expect(mapGitHubUrl(path)).toBeNull();
    });

    it('does not treat a reserved first segment as an owner', () => {
      expect(mapGitHubUrl('/settings/repo/pulls')).toBeNull();
      expect(mapGitHubUrl('/apps/some-app/pull/1')).toBeNull();
    });
  });

  it('encodes owner and repo names', () => {
    expect(mapGitHubUrl('/oct cat/hello world/pull/1')).toBe(
      '/pr/oct%20cat/hello%20world/1?tab=conversation'
    );
  });
});
