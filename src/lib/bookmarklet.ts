/**
 * Builds the bookmarklet that opens the page you are on in Argus.
 *
 * A bookmark cannot discover the Argus server when you click it, so the address goes into
 * the string when /help renders it. That is all that goes in: the bookmarklet sends the
 * page URL to /bookmarklet, and that endpoint maps it with mapGitHubUrl — the function the
 * github.com compatibility routes call too. One mapping serves both entry points, so the
 * bookmarklet cannot drift away from what github.com URLs do.
 */

/**
 * The javascript: URL for the Argus server at `origin` (scheme, host and port).
 *
 * The body holds no `#`, no `%` and no double quote, so it passes through an HTML
 * attribute and a bookmark address field without an encoding step.
 *
 * @param origin The browser-facing Argus address, for example `http://localhost:3000`.
 */
export function bookmarkletUrl(origin: string): string {
  const target = `${origin.replace(/\/+$/, '')}/bookmarklet?url=`;
  return `javascript:location.href='${target}'+encodeURIComponent(location.href)`;
}
