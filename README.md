# Argus

**A fast, server-rendered interface for GitHub pull requests.**

![Screenshot](screenshot.png)

## Why it exists

GitHub's PR page is slow. Sometimes it takes forever to load.

This is a server-rendered alternative that loads pull requests immediately.

## What you get

- **Static rendering** - Server-rendered HTML that shows up instantly, every time. No client-side hydration.
- **Fast for large diffs** - Smart chunking and collapsible files. No waiting for the client to render thousands of lines.
- **Control over updates** - Get notified when PRs change, reload when you're ready. No surprise reflows.
- **Works with GitHub** - All comments, reviews, and merges sync through the GitHub API. Your workflow stays intact.

## Quick Start

1. **Get a GitHub token** at [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta)
   - Grant permissions: **Pull requests** (Read/Write), **Contents** (Read), **Commit statuses** (Read)

2. **Run it:**
   ```bash
   export GITHUB_TOKEN=github_pat_your_token_here
   npm install
   npm run dev  # Automatically runs migrations
   ```

3. **Open** http://localhost:3000

## Configuration

Optional environment variables:

```bash
PORT=3000                          # Server port (default: 3000)
HOST=0.0.0.0                       # Server host (default: 0.0.0.0)
DATABASE_PATH=./data/argus.db      # SQLite database path
CACHE_TTL=60                       # API cache TTL in seconds (default: 60)
BASE_URL=http://localhost:3000     # Base URL for redirects
```

## Use It As Your github.com

Argus understands GitHub's own URLs, so `github.com/owner/repo/pull/42` opens the Argus PR
page and `github.com` itself opens the Argus dashboard — with everything Argus has no view
for (issues, actions, `git push`, the `gh` CLI) passed through to the real site.

```bash
deploy/nginx/setup.sh ./deploy/nginx/certs
docker compose -f docker-compose.yml -f docker-compose.github-proxy.yml up -d
```

Then point `github.com` at that host in each client's hosts file and trust the generated
CA. See **[docs/github-proxy.md](docs/github-proxy.md)** — including what trusting that
certificate means before you do it.

## Run With Docker

```bash
echo "GITHUB_TOKEN=github_pat_your_token_here" > .env
docker compose up
```

---

Built with [Claude Code](https://claude.com/claude-code). Provided "as is" without warranty.

MIT License
