# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Argus is a fast, server-rendered GitHub PR review interface. It prioritizes speed and code understanding over interaction density. Built with Fastify, TypeScript, SQLite, and the GitHub API.

## Development Commands

```bash
# Development (watch mode with hot reload)
npm run dev

# Build TypeScript to JavaScript
npm run build

# Production
npm start

# Database migrations
npm run migrate

# Testing
npm test              # Run all tests once
npm run test:watch    # Watch mode
```

## Architecture

### Request Flow

```
HTTP Request → Authentication Middleware → Route Handler
  ↓
GitHub API (via Octokit) + Local Caching (SQLite)
  ↓
Data Processing (markdown, diff parsing, emoji conversion)
  ↓
EJS Server-Side Rendering
  ↓
HTML Response (with optional client-side JS enhancement)
```

### Core Components

**`src/routes/pr.ts`** - The main PR review interface (~600 lines)
- Handles GET `/pr/:owner/:repo/:number` for PR display
- POST endpoints for comments, reviews, inline comments, and merging
- Orchestrates parallel GitHub API calls for PR data
- Tracks PR revisions to detect force pushes
- Caches rendered diffs and PR snapshots by head SHA

**`src/lib/github.ts`** - GitHub API integration layer (~550 lines)
- Wraps Octokit REST API with caching
- ETag-based cache with configurable TTL
- Functions for fetching PRs, files, checks, comments, reviews, commits
- Functions for posting comments, submitting reviews, merging PRs
- All mutations go through GitHub API (Argus is read-mostly)

**`src/lib/diff-parser.ts`** - Unified diff format parser
- Parses git diff patches into structured data (files, hunks, lines)
- Handles binary files, renames, deletions
- Truncates large files based on `maxLinesPerFile` config

**`src/lib/diff-renderer.ts`** - Diff to HTML converter
- Renders parsed diffs as HTML tables with line numbers
- Supports inline comment forms
- Handles comment threads on specific lines
- Generates file sidebar navigation

**`src/lib/syntax-highlighter.ts`** + **`highlight-pool.ts`** / **`highlight-worker.ts`** / **`highlight-core.ts`** - Shiki highlighting
- Tokenizes each side of a file as one document so constructs closed in an elided region still
  highlight correctly, truncated at the last line the diff actually reads
- Shiki's tokenizer is synchronous, so passes of 40+ lines go to a pool of worker threads
  (`HIGHLIGHT_WORKERS`) rather than blocking the event loop for the whole render
- The pool is an optimization, never a dependency: any spawn failure, worker crash, or
  unsupported language falls back to highlighting in-process

**`src/lib/git.ts`** - Git operations via shell commands
- Clones bare repos to `/tmp/argus-git-cache`
- Computes merge-base for PR base tracking
- Generates range-diffs for force push comparison
- Token sanitization in error messages

**`src/lib/issue-refs.ts`** - Issues referenced from commit messages
- Parses the `#123` and `owner/repo#123` convention out of commit messages. Parsing is pure
  and offline, so the convention is testable without the network
- A lookbehind keeps URLs out (`github.com/owner/repo#3` is not a reference), and the PR's
  own number is dropped as self-reference
- `resolveIssueRefs` fetches the titles in parallel through the same ETag cache as every
  other GitHub resource. A reference that 404s becomes a row with an error, not a failed page
- The lookups chain off the commits promise in `pr.ts`, so they overlap with diff rendering
  rather than adding a round-trip in front of it

**`src/lib/paginate.ts`** - Capped reads of a paginated GitHub list
- `collectCapped` reads pages until a cap is reached and reports whether more remain,
  which the Link header answers exactly (a full last page is not proof of a next one)
- Used by `/repos/:owner/:repo/pulls`, which previously fetched a single `per_page: 50`
  page and so could never show more than 50. GitHub orders by update time descending, so
  the entries a cap drops are always the least recently updated — the reason old PRs
  looked missing. The cap is `MAX_PULLS_LISTED` (default 300), and the page states when
  it truncates rather than hiding it

**`src/lib/markdown.ts`** - Markdown rendering
- Uses `marked` for GitHub-flavored markdown
- Emoji shortcode conversion via `gemoji` (`:thumbsup:` → 👍)
- Custom link renderer (opens in new tab)
- Task list checkbox support

**`src/routes/help.ts`** + **`src/lib/bookmarklet.ts`** - The help screen and its bookmarklet
- `GET /help` renders the bookmarklet. Its origin comes from the request, honouring
  `X-Forwarded-Proto` / `X-Forwarded-Host`, so the same string is right behind the github.com
  proxy. Only characters a URL host may hold pass, because the origin ends up inside a
  `javascript:` URL on the page
- `GET /bookmarklet?url=` is where that bookmarklet sends the click. It maps the page URL
  with `mapGitHubUrl` — the function the github.com compatibility routes call too — and
  redirects. An address that maps nowhere bounces back to itself when it is already an
  Argus address, and shows the "no view" error otherwise. Registered before
  `githubCompatRoutes`

### Database Schema

SQLite with WAL mode. Key tables:

- **api_cache** - GitHub API response caching with ETags
- **pr_snapshots** - Immutable PR data snapshots by head SHA
- **diff_cache** - Rendered diff HTML cache per file
- **pr_revisions** - Timeline of PR head SHAs (force push detection)
- **user_preferences** - User settings (e.g., skip range-diff confirmation)
- **file_reviews** - Per-user "reviewed" state per file, keyed on blob SHA so it survives
  revisions that don't touch the file
- **commit_reviews** - Per-user "reviewed" state per commit. No invalidation needed: a commit
  SHA is its content, so rewritten commits simply start unreviewed

Migrations in `migrations/` directory, applied on startup.

### Authentication

Personal Access Token (PAT) authentication via `GITHUB_TOKEN` environment variable. Token cached as single user object on startup. No OAuth flow currently implemented.

Required GitHub permissions:
- Pull requests: Read/Write
- Contents: Read
- Commit statuses: Read

### Configuration

Environment variables (see `src/config.ts`):

```bash
# Required
GITHUB_TOKEN=github_pat_...

# Optional
PORT=3000
HOST=0.0.0.0
DATABASE_PATH=./data/argus.db
CACHE_TTL=60000          # API cache TTL in ms
MAX_PULLS_LISTED=300     # Cap on the per-repo PR list. Each entry costs one more
                         # (cached) request for its approval state.
PULLS_REVIEW_CONCURRENCY=16  # Batch size for those approval lookups.
HIGHLIGHT_WORKERS=-1     # Syntax-highlighting worker threads. -1 auto-sizes (max 4),
                         # 0 highlights in-process. Each worker costs ~57MB resident.
BASE_URL=http://localhost:3000
```

### Client-Side JavaScript

**`public/js/pr.js`** - Progressive enhancement for PR view
- Polling for PR updates (shows banner when head SHA changes)
- Keyboard shortcuts over "review items" — commits and files are treated alike, in document
  order (commits first): `g` go-to modal, `n`/`p` next/previous unreviewed, `r` toggle
  reviewed, `c` check for updates. The selected item carries `.review-item-current`
- Inline comment form toggling
- Expand/collapse all comments
- Reply button handlers (mention vs quote reply)
- No hydration needed - works without JavaScript

**`public/js/pulls.js`** - Client-side filter for the PR list
- Filters the rows already in the page: no request, no reload. 100ms after the last
  keystroke, so a burst of typing filters once
- The query is an AND over whitespace-separated terms. A term matches by substring
  against the PR number (a leading `#` is dropped) or the title, case-insensitively
- A stack whose rows all filter out hides, as does a section heading over an empty
  section. The rail is hidden while a query is active: a filtered stack is no longer the
  shape the rail draws

### Templates

EJS templates in `src/templates/`. Key templates:

- **pr.ejs** - Main PR review page. Tabs: Conversation, Checks, Review, Issues. The Review tab
  holds two sections — Commits (expandable messages, each markable reviewed) then Files. Legacy
  `?tab=files` / `?tab=commits` links normalize to `review` in the route handler. The Issues tab
  lists the issues the commits reference, each linking out to github.com
- **pulls.ejs** - Per-repo PR list, with the stack rail. Carries a search box that
  `public/js/pulls.js` filters client-side; each row exposes `data-number` / `data-title`
  for it. The box is `hidden` in the markup and revealed by the script, so the page still
  works without JavaScript
- **layout.ejs** - Base HTML wrapper with common header/footer
- **range-diff.ejs** - Force push comparison view
- **help.ejs** - The help screen: the bookmarklet to drag to the bookmarks bar, the address
  to paste into a bookmark instead, and the table of GitHub addresses it opens

Templates receive data from route handlers and render server-side.

### github.com Front End

Argus can be run in place of github.com (`docs/github-proxy.md`): a hosts entry plus the
nginx config in `deploy/nginx/argus-github.conf` terminate TLS for github.com locally, send
the paths Argus owns to Argus, and proxy everything else — git over HTTPS, issues, the `gh`
CLI — on to the real site. `docker-compose.github-proxy.yml` overlays an nginx container
that shares the Argus container's network namespace, so one config file serves both the
Docker and bare-metal deployments.

- **`src/lib/github-url.ts`** - pure mapping from a github.com path + query to an Argus
  path, or null when Argus has no equivalent. GitHub's Files and Commits tabs both fold
  into Argus's Review tab
- **`src/routes/github-compat.ts`** - root-level param routes that 302 to that mapping.
  Registered last in `index.ts`, since every other route is more specific. Always on, no
  configuration: it costs nothing when the proxy is not in use
- `?argus=0` on any URL bypasses Argus at the nginx layer; the "View on GitHub" link in
  `pr.ejs` carries it, or it would resolve back into Argus
- The nginx config resolves the upstream github.com through an explicit `resolver` rather
  than the system one, or the hosts entry would loop it back to itself

## Key Architectural Decisions

1. **Server-rendered HTML** - No client-side framework, no hydration delay
2. **ETag caching** - Minimize GitHub API calls while staying fresh
3. **SQLite with WAL** - Simple embedded DB with good read concurrency
4. **Bare git clones** - Efficient shallow fetches for range-diff computation
5. **Token-based auth** - Simple PAT model for personal/team use

## Code Patterns

### Adding a new GitHub API call

1. Add function to `src/lib/github.ts`:
```typescript
export async function fetchFoo(octokit: Octokit, owner: string, repo: string) {
  const response = await octokit.rest.someNamespace.someMethod({
    owner,
    repo,
  });
  return response.data;
}
```

2. Import and use in route handler:
```typescript
import { fetchFoo } from '../lib/github.js';

const foo = await fetchFoo(octokit, owner, repo);
```

### Adding a new POST endpoint

1. Add route in appropriate file under `src/routes/`:
```typescript
fastify.post('/path', async (request, reply) => {
  if (!requireAuth(request, reply)) return;

  // Extract params/body
  // Call GitHub API
  // Redirect back to PR or return JSON
});
```

2. Add form in template:
```html
<form method="POST" action="/path">
  <input name="field" />
  <button type="submit">Submit</button>
</form>
```

### Adding a new database table

1. Create migration file: `migrations/00X_description.sql`
2. Run migration: `npm run migrate`

## Testing

Tests use Vitest. Focus on lib utilities (diff parsing, git operations). Route testing can use Fastify's inject method.

## Docker

Multi-stage build. Migrations run on container startup. Mount `/app/data` volume for SQLite persistence.

```bash
docker compose up
```
