/*
 * Argus service worker.
 *
 * Installability shell only: no fetch handler, so it cannot interfere with navigation.
 * That matters more here than in most apps — every page is live review state behind a
 * GitHub token, and a cached one would show a PR as it was, not as it is.
 *
 * Structured so caching or push can be added in place later rather than by rewriting:
 * bump CACHE_VERSION if a fetch handler ever introduces a cache, so activate can prune.
 */

const CACHE_VERSION = 'v1';

self.addEventListener('install', () => {
  // Activate immediately instead of waiting for existing tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take control of already-open pages right away.
  event.waitUntil(self.clients.claim());
});
