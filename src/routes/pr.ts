import path from 'node:path';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import {
  createUserOctokit,
  fetchPR,
  fetchPRFiles,
  fetchChecks,
  fetchCombinedStatus,
  fetchReviewComments,
  fetchIssueComments,
  fetchReviews,
  fetchHeadSha,
  fetchPRCommits,
  fetchCommit,
  compareCommits,
  postComment,
  submitReview,
  createReviewComment,
  replyToReviewComment,
  fetchPRTimeline,
  mergePR,
  fetchFileContent,
  fetchFileBuffer,
} from '../lib/github.js';
import { invalidateCache, prCacheKeys, getFetchedAt, type CacheMode } from '../lib/api-cache.js';
import { query, getDb } from '../db/index.js';
import { parsePatch, DiffFile, parseHunkString } from '../lib/diff-parser.js';
import { renderFile, renderFileShell, renderFileSidebarItem, renderInlineCommentForm, renderSimpleHunk, renderDirectoryTree, fileSlug, wrapCachedFileTable, extractDiffTable, sourcesFromFullContextPatch, type FileSources } from '../lib/diff-renderer.js';
import { renderMarkdown, inlineRelativeImages } from '../lib/markdown.js';
import { startCounters } from '../lib/perf-counters.js';
import { renderAsciidoc } from '../lib/asciidoc.js';
import { config } from '../config.js';
import { computeMergeBase, computeRangeDiff, computeCrossDiff, computeCrossRevisionDiff, getFullFileDiff, getFullContextPatches } from '../lib/git.js';
import { getReviewedFiles, toggleFileReview, markFileReviewed, markFileUnreviewed } from '../lib/file-reviews.js';
import { buildFileTree } from '../lib/file-tree-builder.js';

interface PRParams {
  owner: string;
  repo: string;
  number: string;
}

export async function prRoutes(fastify: FastifyInstance) {
  // Main PR view
  fastify.get(
    '/pr/:owner/:repo/:number',
    async (
      request: FastifyRequest<{ Params: PRParams; Querystring: { revision?: string; from_revision?: string; to_revision?: string; tab?: string; w?: string } }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo, number } = request.params;
      const prNumber = parseInt(number, 10);
      const activeTab = (request.query as { tab?: string }).tab || 'conversation';
      const revisionParam = (request.query as { revision?: string }).revision;
      const isCurrentRevisionExplicit = revisionParam === 'current';
      const fromRevisionParam = (request.query as { from_revision?: string }).from_revision;
      const toRevisionParam = (request.query as { to_revision?: string }).to_revision;
      const hideWhitespace = (request.query as { w?: string }).w === '1';

      if (isNaN(prNumber)) {
        return reply.status(400).view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: 'Invalid PR number',
        });
      }

      try {
        const octokit = createUserOctokit(request.user!.accessToken);

        // --- Performance instrumentation (mirrors the dashboard's breakdown) ---
        const perfStart = performance.now();
        const perf: Record<string, number> = {};
        // Counters filled in by the layers below (git subprocesses, Shiki tokenizing), which
        // are where the real cost lives but are several call frames away from any span.
        const counters = startCounters();
        const counterFields = () => ({
          gitSpawns: counters.gitSpawns,
          gitMs: Math.round(counters.gitMs),
          gitNetworkSpawns: counters.gitNetworkSpawns,
          gitNetworkMs: Math.round(counters.gitNetworkMs),
          shikiCalls: counters.shikiCalls,
          shikiMs: Math.round(counters.shikiMs),
          linesTokenized: counters.linesTokenized,
        });
        const span = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
          const t = performance.now();
          try {
            return await work();
          } finally {
            perf[name] = Math.round(performance.now() - t);
          }
        };

        // ?refresh=1 (the Refresh button) bypasses the local cache for this request.
        const cacheMode: CacheMode =
          (request.query as { refresh?: string }).refresh === '1' ? 'bypass' : 'normal';

        // Fetch PR data in parallel. Checks and combined status only need the head SHA,
        // so chain them off the PR fetch — they start the moment fetchPR resolves and
        // overlap with the rest of the batch instead of waiting for a second round-trip.
        // Both degrade to empty on failure (a PR may have no checks/statuses).
        const prPromise = fetchPR(octokit, owner, repo, prNumber, cacheMode);
        const checksPromise = prPromise
          .then((pr) => fetchChecks(octokit, owner, repo, pr.head.sha, cacheMode))
          .catch(() => [] as any[]);
        const statusPromise = prPromise
          .then((pr) => fetchCombinedStatus(octokit, owner, repo, pr.head.sha, cacheMode))
          .catch(() => ({ state: 'unknown', statuses: [] as any[] }));

        const [pr, files, issueComments, reviewComments, reviews, commits, timeline, checks, combinedStatus] =
          await span('apiMs', () =>
            Promise.all([
              prPromise,
              fetchPRFiles(octokit, owner, repo, prNumber, cacheMode),
              fetchIssueComments(octokit, owner, repo, prNumber, cacheMode),
              fetchReviewComments(octokit, owner, repo, prNumber, cacheMode),
              fetchReviews(octokit, owner, repo, prNumber, cacheMode),
              fetchPRCommits(octokit, owner, repo, prNumber, cacheMode),
              fetchPRTimeline(octokit, owner, repo, prNumber, cacheMode),
              checksPromise,
              statusPromise,
            ])
          );

        // Render each inline comment's markdown exactly once. It is needed both for the
        // per-file grouping below and for the conversation tab; rendering it twice per
        // request was pure duplicated CPU. Rendering in parallel also beats the old
        // sequential await-inside-a-loop.
        const renderedCommentBodies = await span('commentMarkdownMs', async () => {
          const entries = await Promise.all(
            reviewComments.map(
              async (c) => [c.id, await renderMarkdown(c.body || '')] as const
            )
          );
          return new Map<number, string>(entries);
        });

        // Group review comments by file path with rendered markdown
        type CommentWithRenderedBody = (typeof reviewComments)[0] & { renderedBody: string };
        const commentsByFile = new Map<string, CommentWithRenderedBody[]>();
        // Map each inline comment id → its file slug, so the client can resolve a
        // #comment-<id> deep link to a file even when that file's body is lazily unloaded.
        const commentFiles: Record<string, string> = {};
        for (const comment of reviewComments) {
          const path = comment.path;
          if (!commentsByFile.has(path)) {
            commentsByFile.set(path, []);
          }
          commentsByFile.get(path)!.push({
            ...comment,
            renderedBody: renderedCommentBodies.get(comment.id) ?? '',
          });
          if (path) commentFiles[comment.id] = fileSlug(path);
        }

        // Build map of filename → blob SHA for cross-revision review persistence
        const fileShaMap = new Map<string, string>();
        for (const file of files) {
          if (file.sha) {
            fileShaMap.set(file.filename, file.sha);
          }
        }

        // Get reviewed files for this user and PR
        const reviewedFiles = request.user
          ? getReviewedFiles(request.user.githubUserId, owner, repo, prNumber, fileShaMap)
          : [];
        const reviewedFilesSet = new Set(reviewedFiles);


        // Get syntax highlighting preference (default: true)
        let enableHighlighting = true;
        if (request.user) {
          const prefKey = `syntax_${owner}/${repo}`;
          const { rows } = query<{ preference_value: string }>(
            `SELECT preference_value FROM user_preferences
             WHERE user_id = ? AND preference_key = ?`,
            [request.user.githubUserId, prefKey]
          );
          if (rows.length > 0) {
            enableHighlighting = rows[0].preference_value === '1';
          }
        }

        // Backfill all historical revisions from GitHub timeline (reuse the timeline
        // already fetched above instead of fetching it a second time).
        await span('backfillMs', () =>
          backfillRevisions(
            owner,
            repo,
            prNumber,
            pr.base.ref,
            pr.base.sha,
            pr.head.ref,
            pr.head.sha,
            request.user!.accessToken,
            timeline
          )
        );

        // Get all seen revisions
        const revisions = getRevisions(owner, repo, prNumber);

        // Historical revision view
        let isHistoricalView = false;
        let selectedRevisionId: number | null = null;
        let historicalFiles: Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string; sha?: string }> = files;

        // Cross-revision comparison view
        let isCrossRevisionView = false;
        let fromRevisionId: number | null = null;
        let toRevisionId: number | null = null;

        if (fromRevisionParam && toRevisionParam) {
          const fromId = parseInt(fromRevisionParam, 10);
          const toId = parseInt(toRevisionParam, 10);
          if (!isNaN(fromId) && !isNaN(toId)) {
            const fromRev = revisions.find(r => r.id === fromId);
            const toRev = revisions.find(r => r.id === toId);
            if (fromRev && toRev) {
              isCrossRevisionView = true;
              fromRevisionId = fromId;
              toRevisionId = toId;

              // Compute merge-bases for both revisions to exclude base branch changes
              let fromMergeBase = fromRev.merge_base_sha;
              if (!fromMergeBase) {
                fromMergeBase = await computeMergeBase(
                  owner, repo, fromRev.base_sha, fromRev.head_sha, request.user!.accessToken
                );
                query(`UPDATE pr_revisions SET merge_base_sha = ? WHERE id = ?`, [fromMergeBase, fromId]);
              }
              let toMergeBase = toRev.merge_base_sha;
              if (!toMergeBase) {
                toMergeBase = await computeMergeBase(
                  owner, repo, toRev.base_sha, toRev.head_sha, request.user!.accessToken
                );
                query(`UPDATE pr_revisions SET merge_base_sha = ? WHERE id = ?`, [toMergeBase, toId]);
              }

              historicalFiles = await computeCrossRevisionDiff(
                owner, repo, fromMergeBase, fromRev.head_sha, toMergeBase, toRev.head_sha,
                request.user!.accessToken,
                hideWhitespace ? { ignoreWhitespace: true } : undefined
              );
            }
          }
        } else if (revisionParam) {
          const revId = parseInt(revisionParam, 10);
          if (!isNaN(revId)) {
            const selectedRev = revisions.find(r => r.id === revId);
            if (selectedRev && selectedRev.head_sha !== pr.head.sha) {
              isHistoricalView = true;
              selectedRevisionId = revId;

              // Compute merge-base if missing
              let mergeBase = selectedRev.merge_base_sha;
              if (!mergeBase) {
                mergeBase = await computeMergeBase(
                  owner,
                  repo,
                  selectedRev.base_sha,
                  selectedRev.head_sha,
                  request.user!.accessToken
                );
                query(
                  `UPDATE pr_revisions SET merge_base_sha = ? WHERE id = ?`,
                  [mergeBase, revId]
                );
              }

              // Reconstruct historical diff
              if (hideWhitespace) {
                historicalFiles = await computeCrossDiff(
                  owner, repo, mergeBase, selectedRev.head_sha, request.user!.accessToken,
                  { ignoreWhitespace: true }
                );
              } else {
                const comparison = await compareCommits(octokit, owner, repo, mergeBase, selectedRev.head_sha);
                historicalFiles = comparison.files;
              }
            }
          }
        }

        // If hiding whitespace on the current view, use local git diff with -w
        if (hideWhitespace && !isHistoricalView && !isCrossRevisionView) {
          const mergeBase = await computeMergeBase(
            owner, repo, pr.base.sha, pr.head.sha, request.user!.accessToken
          );
          historicalFiles = await computeCrossDiff(
            owner, repo, mergeBase, pr.head.sha, request.user!.accessToken,
            { ignoreWhitespace: true }
          );
        }

        // Parse and render diffs
        const parsedFiles: Array<{
          file: DiffFile;
          path: string;
          renderedHtml: string;
          sidebarHtml: string;
          truncated: boolean;
          totalLines: number;
          comments: CommentWithRenderedBody[];
          commentCount: number;
        }> = [];

        const filesToRender = (isHistoricalView || isCrossRevisionView || hideWhitespace) ? historicalFiles : files;

        // For very large PRs, render lightweight file shells and load each file's diff body
        // lazily on expand (see /file-diff endpoint and public/js/pr.js). Supported for the
        // standard current-revision view and the whitespace-hidden view (the lazy endpoint
        // recomputes the whitespace-ignored per-file diff when ?w=1). Historical and
        // cross-revision views still render eagerly (no per-file lazy endpoint for those).
        const changedLineCount = filesToRender.reduce(
          (sum, f) => sum + (f.additions || 0) + (f.deletions || 0),
          0
        );
        const lazyDiffs =
          !isHistoricalView && !isCrossRevisionView &&
          (filesToRender.length > config.diff.lazyFileThreshold ||
            changedLineCount > config.diff.lazyLineThreshold);

        const diffRenderStart = performance.now();

        // Rendered diff tables are cached by (head SHA, path) and shared with the lazy
        // /file-diff endpoint. Syntax highlighting costs roughly half a millisecond per
        // line, so on a repeat load this is the difference between seconds and nothing.
        // Only valid for the standard current-revision view: historical and
        // cross-revision views render different content, and ?w=1 a different patch.
        const canUseDiffCache =
          !hideWhitespace && !isHistoricalView && !isCrossRevisionView;
        const cachedTables = new Map<string, string>();
        if (canUseDiffCache) {
          const diffCacheReadStart = performance.now();
          // One query for the whole PR rather than one per file.
          const { rows } = query<{ file_path: string; rendered_html: string }>(
            `SELECT file_path, rendered_html FROM diff_cache
             WHERE owner = ? AND repo = ? AND head_sha = ? AND highlighted = ?
               AND rendered_html IS NOT NULL`,
            [owner, repo, pr.head.sha, enableHighlighting ? 1 : 0]
          );
          for (const row of rows) cachedTables.set(row.file_path, row.rendered_html);
          perf.diffCacheReadMs = Math.round(performance.now() - diffCacheReadStart);
        }
        let diffCacheHits = 0;

        // Syntax highlighting is only correct when the grammar sees each file whole: a diff
        // hides whatever sits between its hunks, so a block comment closed in an elided
        // region never closes and every hunk below it comes back coloured as comment. One
        // git call for the whole PR supplies the real contents (see getFullContextPatches).
        // Skipped for historical and cross-revision views, whose patches are against a
        // different base. Any failure here is silent: highlighting falls back to per-hunk.
        const fullContextSources = new Map<string, FileSources>();
        const wantsSources =
          enableHighlighting && !lazyDiffs && !isHistoricalView && !isCrossRevisionView;
        if (wantsSources) {
          const needSources = filesToRender
            .filter((f) => {
              if (!f.patch) return false;
              const hasComments = (commentsByFile.get(f.filename)?.length || 0) > 0;
              const cacheable = canUseDiffCache && !hasComments;
              return !(cacheable && cachedTables.has(f.filename));
            })
            .map((f) => f.filename);

          if (needSources.length > 0) {
            try {
              const mergeBase = await span('mergeBaseMs', () =>
                computeMergeBase(
                  owner, repo, pr.base.sha, pr.head.sha, request.user!.accessToken
                )
              );
              const patches = await span('fullContextMs', () =>
                getFullContextPatches(
                  owner, repo, mergeBase, pr.head.sha, request.user!.accessToken, needSources
                )
              );
              for (const path of needSources) {
                const patch = patches.get(path);
                if (!patch) continue;
                const sources = sourcesFromFullContextPatch(patch);
                if (sources) fullContextSources.set(path, sources);
              }
            } catch (err: any) {
              console.error('Failed to load full-file context for highlighting:', err.message);
            }
          }
        }

        const renderFilesStart = performance.now();
        for (let i = 0; i < filesToRender.length; i++) {
          const file = filesToRender[i];
          const fileComments = (isHistoricalView || isCrossRevisionView) ? [] : (commentsByFile.get(file.filename) || []);

          if (!file.patch) {
            // Binary file or no changes
            const diffFile: DiffFile = {
              oldPath: file.filename,
              newPath: file.filename,
              status: file.status as any,
              hunks: [],
              additions: file.additions,
              deletions: file.deletions,
              isBinary: true,
            };

            const slug = fileSlug(file.filename);
            parsedFiles.push({
              file: diffFile,
              path: file.filename,
              renderedHtml: await renderFile(diffFile, slug, pr.head.sha, owner, repo, prNumber, fileComments, reviewedFilesSet.has(file.filename), enableHighlighting, file.sha || fileShaMap.get(file.filename) || ''),
              sidebarHtml: renderFileSidebarItem(diffFile, slug),
              truncated: false,
              totalLines: 0,
              comments: fileComments,
              commentCount: fileComments.length,
            });
            continue;
          }

          const parsedFile = parsePatch(file.patch, file.filename, file.status);

          const slug = fileSlug(file.filename);
          const fileSha = file.sha || fileShaMap.get(file.filename) || '';
          const isReviewed = reviewedFilesSet.has(file.filename);

          // Cached tables are comment-free by construction (see the write below), so they
          // may only be reused for files that currently have no inline comments.
          const cacheableFile = canUseDiffCache && fileComments.length === 0;
          const cachedTable = cacheableFile ? cachedTables.get(file.filename) : undefined;

          let renderedHtml: string;
          if (lazyDiffs) {
            renderedHtml = renderFileShell(
              parsedFile, slug, pr.head.sha, isReviewed, enableHighlighting, fileSha
            );
          } else if (cachedTable) {
            diffCacheHits++;
            renderedHtml = wrapCachedFileTable(
              parsedFile, slug, isReviewed, enableHighlighting, fileSha, pr.head.sha, cachedTable
            );
          } else {
            renderedHtml = await renderFile(
              parsedFile,
              slug,
              pr.head.sha,
              owner,
              repo,
              prNumber,
              fileComments,
              isReviewed,
              enableHighlighting,
              fileSha,
              fullContextSources.get(file.filename)
            );

            if (cacheableFile) {
              const table = extractDiffTable(renderedHtml);
              if (table) {
                query(
                  `INSERT OR REPLACE INTO diff_cache
                     (owner, repo, head_sha, file_path, highlighted, diff_data, rendered_html, fetched_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
                  [
                    owner, repo, pr.head.sha, file.filename,
                    enableHighlighting ? 1 : 0, file.patch, table,
                  ]
                );
              }
            }
          }
          parsedFiles.push({
            file: parsedFile,
            path: file.filename,
            renderedHtml,
            sidebarHtml: renderFileSidebarItem(parsedFile, slug),
            truncated: false,
            totalLines: 0,
            comments: fileComments,
            commentCount: fileComments.length,
          });
        }

        perf.renderFilesMs = Math.round(performance.now() - renderFilesStart);
        // Still reported as the whole-block total, so it stays comparable with older logs;
        // mergeBaseMs + fullContextMs + diffCacheReadMs + renderFilesMs now break it down.
        perf.diffRenderMs = Math.round(performance.now() - diffRenderStart);

        // Build directory tree from files
        const fileTree = buildFileTree(parsedFiles);
        const fileTreeHtml = renderDirectoryTree(fileTree);

        // Compute line stats for review progress
        let totalLines = 0;
        let reviewedLines = 0;
        for (const pf of parsedFiles) {
          const fileLines = pf.file.additions + pf.file.deletions;
          totalLines += fileLines;
          if (reviewedFilesSet.has(pf.path)) {
            reviewedLines += fileLines;
          }
        }

        // Summarize checks
        const checksSummary = summarizeChecks(checks, combinedStatus);

        // Render PR body as markdown
        const renderedBody = await span('bodyMarkdownMs', () => renderMarkdown(pr.body));

        // Freshness: the oldest confirmation time across this page's cached resources is
        // what the "Updated Xm ago" indicator reports — it's the honest figure, since the
        // page is only as current as its stalest part.
        const freshnessStart = performance.now();
        const freshnessTimes = prCacheKeys(owner, repo, prNumber)
          .map(getFetchedAt)
          .filter((d): d is Date => d !== null);
        perf.freshnessMs = Math.round(performance.now() - freshnessStart);
        const dataFetchedAt =
          freshnessTimes.length > 0
            ? new Date(Math.min(...freshnessTimes.map((d) => d.getTime()))).toISOString()
            : new Date().toISOString();

        // Get current timestamp
        const fetchedAt = new Date().toISOString();

        // These two markdown batches used to be evaluated inline in the reply.view() argument,
        // i.e. after the perf log had already been emitted — so their cost (including Shiki on
        // every fenced code block, none of it cached) was invisible in totalMs. Hoisted out and
        // run as one Promise.all rather than two sequential ones, since neither depends on the
        // other; object-literal properties would otherwise have evaluated them in order.
        const [renderedIssueComments, renderedReviews] = await span('viewMarkdownMs', () =>
          Promise.all([
            Promise.all(issueComments.map(async (c) => ({
              ...c,
              renderedBody: await renderMarkdown(c.body),
            }))),
            Promise.all(reviews.map(async (r) => ({
              ...r,
              renderedBody: await renderMarkdown(r.body),
            }))),
          ])
        );

        const viewData = {
          title: `#${prNumber} ${pr.title} - Argus`,
          user: request.user,
          owner,
          repo,
          pr: {
            ...pr,
            renderedBody,
          },
          files: parsedFiles,
          fileTreeHtml,
          lazyDiffs,
          commentFiles,
          issueComments: renderedIssueComments,
          reviewComments: reviewComments.map((c) => ({
            ...c,
            renderedBody: renderedCommentBodies.get(c.id) ?? '',
            renderedHunk: c.diff_hunk ? renderSimpleHunk(parseHunkString(c.diff_hunk)) : '',
          })),
          reviews: renderedReviews,
          timeline,
          checksSummary,
          checks,
          statuses: combinedStatus.statuses,
          revisions,
          isHistoricalView,
          selectedRevisionId,
          isCrossRevisionView,
          fromRevisionId,
          toRevisionId,
          isCurrentRevisionExplicit,
          commits,
          fetchedAt,
          dataFetchedAt,
          inlineCommentFormTemplate: renderInlineCommentForm(),
          pollIntervalMs: config.ui.pollIntervalMs,
          config,
          reviewedFiles,
          totalLines,
          reviewedLines,
          activeTab,
          hideWhitespace,
        };

        // Rendering is measured and the log emitted *after* it, so totalMs covers the whole
        // handler. In dev this also captures EJS compiling pr.ejs from scratch, which
        // @fastify/view only caches when NODE_ENV=production.
        try {
          return await span('ejsMs', async () => reply.view('pr', viewData));
        } finally {
          request.log.info(
            {
              pr: `${owner}/${repo}#${prNumber}`,
              totalMs: Math.round(performance.now() - perfStart),
              files: files.length,
              reviewComments: reviewComments.length,
              lazyDiffs,
              diffCacheHits,
              diffsRendered: lazyDiffs ? 0 : filesToRender.length - diffCacheHits,
              refresh: cacheMode === 'bypass',
              filesWithComments: commentsByFile.size,
              fullContextFiles: fullContextSources.size,
              ...perf,
              ...counterFields(),
            },
            'pr performance breakdown'
          );
        }
      } catch (err: any) {
        console.error('Error fetching PR:', err);

        if (err.status === 401) {
          return reply.status(401).view('error', {
            title: 'Authentication Error - Argus',
            user: request.user,
            message: 'GitHub token is invalid or expired. Please check your GITHUB_TOKEN environment variable.',
          });
        }

        if (err.status === 404) {
          return reply.status(404).view('error', {
            title: 'Not Found - Argus',
            user: request.user,
            message: `Pull request ${owner}/${repo}#${prNumber} not found`,
          });
        }

        return reply.view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: `Failed to load pull request: ${err.message}`,
        });
      }
    }
  );

  // Polling endpoint for head SHA
  fastify.get(
    '/pr/:owner/:repo/:number/head',
    async (
      request: FastifyRequest<{ Params: PRParams }>,
      reply: FastifyReply
    ) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { owner, repo, number } = request.params;
      const prNumber = parseInt(number, 10);

      if (isNaN(prNumber)) {
        return reply.status(400).send({ error: 'Invalid PR number' });
      }

      try {
        const octokit = createUserOctokit(request.user.accessToken);
        // This endpoint exists purely to detect that the PR moved, so it must not be
        // answered from cache: a stale-then-revalidate read would delay the "PR updated"
        // banner by a full poll cycle. The in-flight dedup in the cache layer still
        // collapses simultaneous polls from multiple tabs into one request.
        const { headSha, updatedAt } = await fetchHeadSha(octokit, owner, repo, prNumber, 'bypass');

        return reply.send({
          head_sha: headSha,
          updated_at: updatedAt,
        });
      } catch (err: any) {
        console.error('Error fetching head SHA:', err);
        return reply.status(500).send({ error: 'Failed to fetch head SHA' });
      }
    }
  );

  // Post top-level comment
  fastify.post(
    '/pr/:owner/:repo/:number/comment',
    async (
      request: FastifyRequest<{
        Params: PRParams;
        Body: { body: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo, number } = request.params;
      const { body } = request.body;
      const prNumber = parseInt(number, 10);

      if (!body || !body.trim()) {
        return reply.status(400).view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: 'Comment body is required',
        });
      }

      try {
        const octokit = createUserOctokit(request.user!.accessToken);
        await postComment(octokit, owner, repo, prNumber, body.trim());
        invalidateCache(prCacheKeys(owner, repo, prNumber));

        return reply.redirect(`/pr/${owner}/${repo}/${number}?tab=conversation`);
      } catch (err: any) {
        console.error('Error posting comment:', err);
        return reply.view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: `Failed to post comment: ${err.message}`,
        });
      }
    }
  );

  // Submit review
  fastify.post(
    '/pr/:owner/:repo/:number/review',
    async (
      request: FastifyRequest<{
        Params: PRParams;
        Body: { event: string; body?: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo, number } = request.params;
      const { event, body } = request.body;
      const prNumber = parseInt(number, 10);

      const validEvents = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];
      if (!event || !validEvents.includes(event)) {
        return reply.status(400).view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: 'Invalid review event',
        });
      }

      // REQUEST_CHANGES requires a body
      if (event === 'REQUEST_CHANGES' && (!body || !body.trim())) {
        return reply.status(400).view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: 'Body is required for request changes',
        });
      }

      try {
        const octokit = createUserOctokit(request.user!.accessToken);
        await submitReview(
          octokit,
          owner,
          repo,
          prNumber,
          event as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
          body?.trim()
        );
        invalidateCache(prCacheKeys(owner, repo, prNumber));

        return reply.redirect(`/pr/${owner}/${repo}/${number}?tab=files`);
      } catch (err: any) {
        console.error('Error submitting review:', err);
        return reply.view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: `Failed to submit review: ${err.message}`,
        });
      }
    }
  );

  // Create inline comment
  fastify.post(
    '/pr/:owner/:repo/:number/inline-comment',
    async (
      request: FastifyRequest<{
        Params: PRParams;
        Body: {
          body: string;
          path: string;
          line: string;
          side: string;
          commit_id: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo, number } = request.params;
      const { body, path, line, side, commit_id } = request.body;
      const prNumber = parseInt(number, 10);
      const lineNum = parseInt(line, 10);

      if (!body?.trim() || !path || isNaN(lineNum) || !commit_id) {
        return reply.status(400).view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: 'Missing required fields for inline comment',
        });
      }

      try {
        const octokit = createUserOctokit(request.user!.accessToken);
        const commentId = await createReviewComment(
          octokit,
          owner,
          repo,
          prNumber,
          body.trim(),
          commit_id,
          path,
          lineNum,
          (side as 'LEFT' | 'RIGHT') || 'RIGHT'
        );
        invalidateCache(prCacheKeys(owner, repo, prNumber));

        return reply.redirect(`/pr/${owner}/${repo}/${number}?tab=files#comment-${commentId}`);
      } catch (err: any) {
        console.error('Error creating inline comment:', err);
        return reply.view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: `Failed to create inline comment: ${err.message}`,
        });
      }
    }
  );

  // Reply to a comment thread
  fastify.post(
    '/pr/:owner/:repo/:number/reply',
    async (
      request: FastifyRequest<{
        Params: PRParams;
        Body: { comment_id: string; body: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo, number } = request.params;
      const { comment_id, body } = request.body;
      const prNumber = parseInt(number, 10);
      const commentId = parseInt(comment_id, 10);

      if (!body?.trim() || isNaN(commentId)) {
        return reply.status(400).view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: 'Missing required fields for reply',
        });
      }

      try {
        const octokit = createUserOctokit(request.user!.accessToken);
        await replyToReviewComment(
          octokit,
          owner,
          repo,
          prNumber,
          commentId,
          body.trim()
        );
        invalidateCache(prCacheKeys(owner, repo, prNumber));

        return reply.redirect(`/pr/${owner}/${repo}/${number}?tab=conversation`);
      } catch (err: any) {
        console.error('Error replying to comment:', err);
        return reply.view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: `Failed to reply: ${err.message}`,
        });
      }
    }
  );

  // Toggle file review status
  fastify.post(
    '/pr/:owner/:repo/:number/file-review',
    async (
      request: FastifyRequest<{
        Params: PRParams;
        Body: { file_path: string; head_sha: string; file_sha: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo, number } = request.params;
      const { file_path, head_sha, file_sha } = request.body;
      const prNumber = parseInt(number, 10);

      if (!file_path || !head_sha) {
        return reply.status(400).send({ error: 'Missing required fields' });
      }

      try {
        const isReviewed = toggleFileReview(
          request.user!.githubUserId,
          owner,
          repo,
          prNumber,
          file_path,
          head_sha,
          file_sha || ''
        );

        return reply.send({ reviewed: isReviewed });
      } catch (err: any) {
        console.error('Error toggling file review:', err);
        return reply.status(500).send({ error: 'Failed to toggle review' });
      }
    }
  );

  // Bulk file review (mark/unmark multiple files)
  fastify.post(
    '/pr/:owner/:repo/:number/file-review-bulk',
    async (
      request: FastifyRequest<{
        Params: PRParams;
        Body: { files: { file_path: string; file_sha: string }[]; head_sha: string; reviewed: boolean };
      }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo, number } = request.params;
      const { files, head_sha, reviewed } = request.body;
      const prNumber = parseInt(number, 10);

      if (!Array.isArray(files) || !head_sha || typeof reviewed !== 'boolean') {
        return reply.status(400).send({ error: 'Missing required fields' });
      }

      try {
        const db = getDb();
        const userId = request.user!.githubUserId;

        const bulkOp = db.transaction(() => {
          for (const file of files) {
            if (reviewed) {
              markFileReviewed(
                userId,
                owner,
                repo,
                prNumber,
                file.file_path,
                head_sha,
                file.file_sha || ''
              );
            } else {
              markFileUnreviewed(
                userId,
                owner,
                repo,
                prNumber,
                file.file_path
              );
            }
          }
        });
        bulkOp();

        return reply.send({ reviewed });
      } catch (err: any) {
        console.error('Error bulk toggling file reviews:', err);
        return reply.status(500).send({ error: 'Failed to bulk toggle reviews' });
      }
    }
  );

  // Toggle syntax highlighting
  fastify.post(
    '/pr/:owner/:repo/:number/syntax-toggle',
    async (
      request: FastifyRequest<{
        Params: PRParams;
        Body: { enabled: boolean };
      }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo } = request.params;
      const { enabled } = request.body;

      try {
        const prefKey = `syntax_${owner}/${repo}`;
        query(
          `INSERT OR REPLACE INTO user_preferences
           (user_id, preference_key, preference_value, updated_at)
           VALUES (?, ?, ?, datetime('now'))`,
          [request.user!.githubUserId, prefKey, enabled ? '1' : '0']
        );

        return reply.send({ enabled });
      } catch (err: any) {
        console.error('Error toggling syntax highlighting:', err);
        return reply.status(500).send({ error: 'Failed to toggle syntax highlighting' });
      }
    }
  );

  // Lazy diff body for a single file (AJAX). Used by the Files view on very large PRs, where
  // file bodies are rendered as shells and fetched when a file is expanded. Renders the
  // current-PR-patch diff table; with ?w=1 it recomputes the whitespace-ignored per-file diff
  // from the git cache so the lazy body matches the whitespace-hidden page.
  fastify.get(
    '/pr/:owner/:repo/:number/file-diff',
    async (
      request: FastifyRequest<{
        Params: PRParams;
        Querystring: { path: string; w?: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { owner, repo, number } = request.params;
      const prNumber = parseInt(number, 10);
      const filePath = (request.query as { path?: string }).path;
      const hideWhitespace = (request.query as { w?: string }).w === '1';

      if (!filePath) {
        return reply.status(400).send({ error: 'Missing path parameter' });
      }

      try {
        const octokit = createUserOctokit(request.user.accessToken);
        const pr = await fetchPR(octokit, owner, repo, prNumber);
        const headSha = pr.head.sha;

        // Syntax highlighting preference (default: true), matching the page render. Read
        // before the cache lookup because the rendered HTML differs by this flag and the
        // cache is keyed on it.
        let enableHighlighting = true;
        const { rows: prefRows } = query<{ preference_value: string }>(
          `SELECT preference_value FROM user_preferences WHERE user_id = ? AND preference_key = ?`,
          [request.user.githubUserId, `syntax_${owner}/${repo}`]
        );
        if (prefRows.length > 0) {
          enableHighlighting = prefRows[0].preference_value === '1';
        }

        // The diff_cache stores the standard (whitespace-included) render keyed by head SHA +
        // path, so it is only valid for the non-whitespace view — skip it entirely for ?w=1.
        if (!hideWhitespace) {
          // Serve cached rendered HTML when present. Only comment-less renders are cached, so a
          // cache hit is always comment-free and safe (inline comments can change without the
          // head SHA changing — see the write below).
          const cached = query<{ rendered_html: string | null }>(
            `SELECT rendered_html FROM diff_cache
             WHERE owner = ? AND repo = ? AND head_sha = ? AND file_path = ?
               AND highlighted = ? AND rendered_html IS NOT NULL`,
            [owner, repo, headSha, filePath, enableHighlighting ? 1 : 0]
          );
          if (cached.rows.length > 0 && cached.rows[0].rendered_html) {
            return reply.send({ html: cached.rows[0].rendered_html });
          }
        }

        // Resolve this file's patch/status/blob-sha for the active view mode.
        let patch: string | undefined;
        let status: string;
        let fileSha: string;
        if (hideWhitespace) {
          // Whitespace-ignored diff via the git cache. computeCrossDiff memoises the full
          // cross-diff in-process, so this reuses the work the page render already did.
          const mergeBase = await computeMergeBase(
            owner, repo, pr.base.sha, pr.head.sha, request.user.accessToken
          );
          const wFiles = await computeCrossDiff(
            owner, repo, mergeBase, pr.head.sha, request.user.accessToken, { ignoreWhitespace: true }
          );
          const wFile = wFiles.find(f => f.filename === filePath);
          if (!wFile) {
            return reply.send({ html: '<div class="diff-empty-notice">No changes</div>' });
          }
          patch = wFile.patch;
          status = wFile.status;
          fileSha = '';
        } else {
          const files = await fetchPRFiles(octokit, owner, repo, prNumber);
          const file = files.find(f => f.filename === filePath);
          if (!file) {
            return reply.status(404).send({ error: 'File not found in PR' });
          }
          patch = file.patch;
          status = file.status;
          fileSha = file.sha || '';
        }
        if (!patch) {
          return reply.send({ html: '<div class="diff-binary-notice">Binary file not shown</div>' });
        }

        // Inline comments for this file.
        const reviewComments = await fetchReviewComments(octokit, owner, repo, prNumber);
        const fileComments = await Promise.all(
          reviewComments
            .filter(c => c.path === filePath)
            .map(async (c) => ({ ...c, renderedBody: await renderMarkdown(c.body) }))
        );

        // The file's real contents, so constructs closed in an elided region still close.
        // Best-effort: without it renderFile highlights each hunk in isolation.
        let sources: FileSources | undefined;
        if (enableHighlighting) {
          try {
            const mergeBase = await computeMergeBase(
              owner, repo, pr.base.sha, headSha, request.user.accessToken
            );
            const patches = await getFullContextPatches(
              owner, repo, mergeBase, headSha, request.user.accessToken, [filePath]
            );
            const fullPatch = patches.get(filePath);
            if (fullPatch) sources = sourcesFromFullContextPatch(fullPatch) || undefined;
          } catch (err: any) {
            console.error('Failed to load full-file context for highlighting:', err.message);
          }
        }

        const parsedFile = parsePatch(patch, filePath, status);
        const slug = fileSlug(filePath);
        const renderedHtml = await renderFile(
          parsedFile, slug, headSha, owner, repo, prNumber, fileComments, false,
          enableHighlighting, fileSha, sources
        );

        // Extract just the <table> to inject into the file's existing .diff-content.
        const tableMatch = renderedHtml.match(/<table class="diff-table">[\s\S]*?<\/table>/);
        const tableHtml = tableMatch ? tableMatch[0] : renderedHtml;

        // Cache only standard, comment-free renders (the cache is keyed by head SHA + path,
        // not by comment state or whitespace mode). Re-expanding such a file is then instant.
        if (!hideWhitespace && fileComments.length === 0) {
          query(
            `INSERT OR REPLACE INTO diff_cache
               (owner, repo, head_sha, file_path, highlighted, diff_data, rendered_html, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
            [owner, repo, headSha, filePath, enableHighlighting ? 1 : 0, patch, tableHtml]
          );
        }

        return reply.send({ html: tableHtml });
      } catch (err: any) {
        console.error('Error fetching file diff:', err);
        return reply.status(500).send({ error: 'Failed to fetch file diff' });
      }
    }
  );

  // Full file diff (AJAX)
  fastify.get(
    '/pr/:owner/:repo/:number/full-file-diff',
    async (
      request: FastifyRequest<{
        Params: PRParams;
        Querystring: { path: string; w?: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { owner, repo, number } = request.params;
      const prNumber = parseInt(number, 10);
      const filePath = (request.query as { path?: string }).path;
      const hideWhitespace = (request.query as { w?: string }).w === '1';

      if (!filePath) {
        return reply.status(400).send({ error: 'Missing path parameter' });
      }

      try {
        const octokit = createUserOctokit(request.user.accessToken);
        const pr = await fetchPR(octokit, owner, repo, prNumber);

        // Compute merge-base for the diff
        const mergeBase = await computeMergeBase(
          owner, repo, pr.base.sha, pr.head.sha, request.user.accessToken
        );

        // Fetch review comments and full file diff in parallel
        const [patch, reviewComments] = await Promise.all([
          getFullFileDiff(
            owner, repo, mergeBase, pr.head.sha, filePath, request.user.accessToken,
            hideWhitespace ? { ignoreWhitespace: true } : undefined
          ),
          fetchReviewComments(octokit, owner, repo, prNumber),
        ]);

        if (!patch) {
          return reply.send({ html: '<div class="diff-empty-notice">No changes</div>' });
        }

        // Filter comments to this file and render markdown
        const fileComments = await Promise.all(
          reviewComments
            .filter(c => c.path === filePath)
            .map(async (c) => ({
              ...c,
              renderedBody: await renderMarkdown(c.body),
            }))
        );

        // Syntax highlighting preference (default: true), matching the page render.
        let enableHighlighting = true;
        const { rows: prefRows } = query<{ preference_value: string }>(
          `SELECT preference_value FROM user_preferences WHERE user_id = ? AND preference_key = ?`,
          [request.user.githubUserId, `syntax_${owner}/${repo}`]
        );
        if (prefRows.length > 0) {
          enableHighlighting = prefRows[0].preference_value === '1';
        }

        const parsedFile = parsePatch(patch, filePath, 'modified');
        const slug = fileSlug(filePath);
        // This patch is already -U99999, so it *is* the whole file — no second git call.
        const sources = sourcesFromFullContextPatch(patch) || undefined;
        const renderedHtml = await renderFile(
          parsedFile, slug, pr.head.sha, owner, repo, prNumber, fileComments, false,
          enableHighlighting, '', sources
        );

        // Extract just the diff-table content from the rendered HTML
        const tableMatch = renderedHtml.match(/<table class="diff-table">([\s\S]*?)<\/table>/);
        const tableHtml = tableMatch ? tableMatch[0] : renderedHtml;

        return reply.send({ html: tableHtml });
      } catch (err: any) {
        console.error('Error fetching full file diff:', err);
        return reply.status(500).send({ error: 'Failed to fetch full file diff' });
      }
    }
  );

  // Rendered preview for markdown/asciidoc files (AJAX)
  fastify.get(
    '/pr/:owner/:repo/:number/rendered-view',
    async (
      request: FastifyRequest<{
        Params: PRParams;
        Querystring: { path: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!request.user) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const { owner, repo, number } = request.params;
      const prNumber = parseInt(number, 10);
      const filePath = (request.query as { path?: string }).path;

      if (!filePath) {
        return reply.status(400).send({ error: 'Missing path parameter' });
      }

      try {
        const octokit = createUserOctokit(request.user.accessToken);
        const pr = await fetchPR(octokit, owner, repo, prNumber);
        const content = await fetchFileContent(octokit, owner, repo, filePath, pr.head.sha);

        let html: string;
        if (/\.adoc$/i.test(filePath)) {
          html = renderAsciidoc(content);
        } else {
          html = await renderMarkdown(content);
        }

        // Inline relative images as data: URIs so they resolve against the
        // repo (relative <img src> would otherwise resolve against this route).
        const baseDir = path.posix.dirname(filePath);
        html = await inlineRelativeImages(html, baseDir, (repoPath) =>
          fetchFileBuffer(octokit, owner, repo, repoPath, pr.head.sha)
        );

        return reply.send({ html: `<div class="rendered-preview markdown-body">${html}</div>` });
      } catch (err: any) {
        console.error('Error fetching rendered view:', err);
        return reply.status(500).send({ error: 'Failed to fetch rendered view' });
      }
    }
  );

  // Commits list
  fastify.get(
    '/pr/:owner/:repo/:number/commits',
    async (
      request: FastifyRequest<{ Params: PRParams }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo, number } = request.params;
      const prNumber = parseInt(number, 10);

      try {
        const octokit = createUserOctokit(request.user!.accessToken);
        const [pr, commits, timeline] = await Promise.all([
          fetchPR(octokit, owner, repo, prNumber),
          fetchPRCommits(octokit, owner, repo, prNumber),
          fetchPRTimeline(octokit, owner, repo, prNumber),
        ]);

        // Backfill all historical revisions from GitHub timeline (fetched in parallel above)
        await backfillRevisions(
          owner,
          repo,
          prNumber,
          pr.base.ref,
          pr.base.sha,
          pr.head.ref,
          pr.head.sha,
          request.user!.accessToken,
          timeline
        );

        const revisions = getRevisions(owner, repo, prNumber);

        return reply.view('commits', {
          title: `Commits - #${prNumber} - Argus`,
          user: request.user,
          owner,
          repo,
          prNumber,
          pr,
          commits,
          revisions,
        });
      } catch (err: any) {
        console.error('Error fetching commits:', err);
        return reply.view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: `Failed to load commits: ${err.message}`,
        });
      }
    }
  );

  // Compare two commits
  fastify.get(
    '/pr/:owner/:repo/:number/compare/:base/:head',
    async (
      request: FastifyRequest<{
        Params: PRParams & { base: string; head: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo, number, base, head } = request.params;
      const prNumber = parseInt(number, 10);

      try {
        const octokit = createUserOctokit(request.user!.accessToken);
        const comparison = await compareCommits(octokit, owner, repo, base, head);

        // Parse and render diffs
        const parsedFiles = comparison.files.map((file, i) => {
          if (!file.patch) {
            return {
              path: file.filename,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
              patch: null,
            };
          }
          return {
            path: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            patch: file.patch,
          };
        });

        return reply.view('compare', {
          title: `${base.slice(0, 7)}..${head.slice(0, 7)} - Argus`,
          user: request.user,
          owner,
          repo,
          prNumber,
          base,
          head,
          comparison,
          files: parsedFiles,
        });
      } catch (err: any) {
        console.error('Error comparing commits:', err);
        return reply.view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: `Failed to compare: ${err.message}`,
        });
      }
    }
  );

  // Range-diff between two revisions
  fastify.get(
    '/pr/:owner/:repo/:number/range-diff/:fromId/:toId',
    async (
      request: FastifyRequest<{
        Params: PRParams & { fromId: string; toId: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo, number, fromId, toId } = request.params;
      const prNumber = parseInt(number, 10);
      const fromRevId = parseInt(fromId, 10);
      const toRevId = parseInt(toId, 10);

      if (isNaN(prNumber) || isNaN(fromRevId) || isNaN(toRevId)) {
        return reply.status(400).view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: 'Invalid parameters',
        });
      }

      try {
        // Load both revisions from DB
        const { rows: fromRows } = query<{
          id: number;
          head_sha: string;
          head_ref: string;
          base_sha: string;
          base_ref: string;
          merge_base_sha: string | null;
          seen_at: string;
        }>(
          `SELECT id, head_sha, head_ref, base_sha, base_ref, merge_base_sha, seen_at
           FROM pr_revisions WHERE id = ?`,
          [fromRevId]
        );

        const { rows: toRows } = query<{
          id: number;
          head_sha: string;
          head_ref: string;
          base_sha: string;
          base_ref: string;
          merge_base_sha: string | null;
          seen_at: string;
        }>(
          `SELECT id, head_sha, head_ref, base_sha, base_ref, merge_base_sha, seen_at
           FROM pr_revisions WHERE id = ?`,
          [toRevId]
        );

        if (fromRows.length === 0 || toRows.length === 0) {
          return reply.status(404).view('error', {
            title: 'Error - Argus',
            user: request.user,
            message: 'Revision not found',
          });
        }

        const fromRev = fromRows[0];
        const toRev = toRows[0];

        // Check if we need to compute merge-base (requires git clone)
        const needsCompute = !fromRev.merge_base_sha || !toRev.merge_base_sha;

        // Check if user has enabled "don't ask again" preference for this repo
        const prefKey = `range_diff_skip_confirm:${owner}/${repo}`;
        const { rows: prefRows } = query<{ preference_value: string }>(
          `SELECT preference_value FROM user_preferences WHERE user_id = ? AND preference_key = ?`,
          [request.user!.githubUserId, prefKey]
        );
        const skipConfirm = prefRows.length > 0 && prefRows[0].preference_value === '1';

        // If merge-base not computed and user hasn't skipped confirmation, show warning page
        if (needsCompute && !skipConfirm) {
          return reply.view('range-diff-confirm', {
            title: `Range-diff - #${prNumber} - Argus`,
            user: request.user,
            owner,
            repo,
            prNumber,
            fromRev,
            toRev,
          });
        }

        // Compute merge-base on-demand if missing
        let fromMergeBase = fromRev.merge_base_sha;
        let toMergeBase = toRev.merge_base_sha;

        if (!fromMergeBase) {
          console.log(`Computing merge-base for revision ${fromRev.id} (${fromRev.head_sha.slice(0, 7)})...`);
          fromMergeBase = await computeMergeBase(
            owner,
            repo,
            fromRev.base_sha,
            fromRev.head_sha,
            request.user!.accessToken
          );
          // Update DB with computed merge-base
          query(
            `UPDATE pr_revisions SET merge_base_sha = ? WHERE id = ?`,
            [fromMergeBase, fromRevId]
          );
        }

        if (!toMergeBase) {
          console.log(`Computing merge-base for revision ${toRev.id} (${toRev.head_sha.slice(0, 7)})...`);
          toMergeBase = await computeMergeBase(
            owner,
            repo,
            toRev.base_sha,
            toRev.head_sha,
            request.user!.accessToken
          );
          // Update DB with computed merge-base
          query(
            `UPDATE pr_revisions SET merge_base_sha = ? WHERE id = ?`,
            [toMergeBase, toRevId]
          );
        }

        // Compute range-diff
        const rangeDiff = await computeRangeDiff(
          owner,
          repo,
          fromMergeBase,
          fromRev.head_sha,
          toMergeBase,
          toRev.head_sha,
          request.user!.accessToken
        );

        return reply.view('range-diff', {
          title: `Range-diff - #${prNumber} - Argus`,
          user: request.user,
          owner,
          repo,
          prNumber,
          fromRev: { ...fromRev, merge_base_sha: fromMergeBase },
          toRev: { ...toRev, merge_base_sha: toMergeBase },
          rangeDiff,
        });
      } catch (err: any) {
        console.error('Error computing range-diff:', err);
        return reply.view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: `Failed to compute range-diff: ${err.message}`,
        });
      }
    }
  );

  // Get commit diff
  fastify.get(
    '/pr/:owner/:repo/:number/commit/:sha',
    async (
      request: FastifyRequest<{
        Params: PRParams & { sha: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo, sha } = request.params;

      try {
        const octokit = createUserOctokit(request.user!.accessToken);
        const commit = await fetchCommit(octokit, owner, repo, sha);

        // Parse and render each file's diff
        const parsedFiles: Array<{
          file: DiffFile;
          path: string;
          renderedHtml: string;
        }> = [];

        for (let i = 0; i < commit.files.length; i++) {
          const file = commit.files[i];

          if (!file.patch) {
            // Binary file or no changes
            const diffFile: DiffFile = {
              oldPath: file.filename,
              newPath: file.filename,
              status: file.status as any,
              hunks: [],
              additions: file.additions,
              deletions: file.deletions,
              isBinary: true,
            };

            parsedFiles.push({
              file: diffFile,
              path: file.filename,
              renderedHtml: await renderFile(diffFile, fileSlug(file.filename), sha, owner, repo, 0, [], false, false),
            });
            continue;
          }

          const parsedFile = parsePatch(file.patch, file.filename, file.status);

          parsedFiles.push({
            file: parsedFile,
            path: file.filename,
            renderedHtml: await renderFile(parsedFile, fileSlug(file.filename), sha, owner, repo, 0, [], false, false),
          });
        }

        return reply.view('commit', {
          title: `Commit ${sha.slice(0, 7)} - Argus`,
          user: request.user,
          owner,
          repo,
          commit,
          files: parsedFiles,
        });
      } catch (err: any) {
        console.error('Error fetching commit:', err);
        return reply.view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: `Failed to fetch commit: ${err.message}`,
        });
      }
    }
  );

  // Handle range-diff confirmation form
  fastify.post(
    '/pr/:owner/:repo/:number/range-diff/:fromId/:toId/confirm',
    async (
      request: FastifyRequest<{
        Params: PRParams & { fromId: string; toId: string };
        Body: { dont_ask_again?: string };
      }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo, number, fromId, toId } = request.params;
      const prNumber = parseInt(number, 10);

      // Save preference if checkbox was checked
      if (request.body?.dont_ask_again === '1') {
        const prefKey = `range_diff_skip_confirm:${owner}/${repo}`;
        query(
          `INSERT OR REPLACE INTO user_preferences (user_id, preference_key, preference_value, updated_at)
           VALUES (?, ?, '1', datetime('now'))`,
          [request.user!.githubUserId, prefKey]
        );
      }

      // Redirect to the range-diff route which will now compute
      return reply.redirect(
        `/pr/${owner}/${repo}/${prNumber}/range-diff/${fromId}/${toId}`
      );
    }
  );

  // Merge PR
  fastify.post(
    '/pr/:owner/:repo/:number/merge',
    async (
      request: FastifyRequest<{
        Params: PRParams;
        Body: {
          merge_method?: 'merge' | 'squash' | 'rebase';
          commit_title?: string;
          commit_message?: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      if (!requireAuth(request, reply)) return;

      const { owner, repo, number } = request.params;
      const { merge_method = 'merge', commit_title, commit_message } = request.body;
      const prNumber = parseInt(number, 10);

      try {
        const octokit = createUserOctokit(request.user!.accessToken);
        const result = await mergePR(
          octokit,
          owner,
          repo,
          prNumber,
          commit_title,
          commit_message,
          merge_method
        );
        invalidateCache(prCacheKeys(owner, repo, prNumber));

        if (!result.merged) {
          return reply.view('error', {
            title: 'Merge Failed - Argus',
            user: request.user,
            message: `Failed to merge PR: ${result.message}`,
          });
        }

        return reply.redirect(`/pr/${owner}/${repo}/${number}?tab=conversation`);
      } catch (err: any) {
        console.error('Error merging PR:', err);
        return reply.view('error', {
          title: 'Error - Argus',
          user: request.user,
          message: `Failed to merge PR: ${err.message}`,
        });
      }
    }
  );
}

// Helper to summarize checks status
function summarizeChecks(
  checks: any[],
  combinedStatus: { state: string; statuses: any[] }
): {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  state: string;
} {
  let passed = 0;
  let failed = 0;
  let pending = 0;

  // Count check runs
  for (const check of checks) {
    if (check.status === 'completed') {
      if (check.conclusion === 'success' || check.conclusion === 'skipped') {
        passed++;
      } else if (
        check.conclusion === 'failure' ||
        check.conclusion === 'cancelled' ||
        check.conclusion === 'timed_out'
      ) {
        failed++;
      } else {
        pending++;
      }
    } else {
      pending++;
    }
  }

  // Count statuses
  for (const status of combinedStatus.statuses) {
    if (status.state === 'success') {
      passed++;
    } else if (status.state === 'failure' || status.state === 'error') {
      failed++;
    } else {
      pending++;
    }
  }

  const total = passed + failed + pending;

  let state = 'success';
  if (failed > 0) {
    state = 'failure';
  } else if (pending > 0) {
    state = 'pending';
  }

  return { total, passed, failed, pending, state };
}

// Save PR revision for force push tracking
async function saveRevision(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  headRef: string,
  baseSha: string,
  baseRef: string,
  accessToken: string,
  seenAt?: string
): Promise<void> {
  try {
    // Don't compute merge-base eagerly - do it lazily when range-diff is requested for speed
    const mergeBaseSha: string | null = null;

    if (seenAt) {
      // Insert with specific timestamp (for historical backfill)
      query(
        `INSERT OR IGNORE INTO pr_revisions (owner, repo, pr_number, head_sha, head_ref, base_sha, base_ref, merge_base_sha, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [owner, repo, prNumber, headSha, headRef, baseSha, baseRef, mergeBaseSha, seenAt]
      );
    } else {
      // Insert with current timestamp
      query(
        `INSERT OR IGNORE INTO pr_revisions (owner, repo, pr_number, head_sha, head_ref, base_sha, base_ref, merge_base_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [owner, repo, prNumber, headSha, headRef, baseSha, baseRef, mergeBaseSha]
      );
    }
  } catch (err) {
    console.error('Failed to save revision:', err);
    // Ignore errors - revision tracking is optional
  }
}

// Backfill historical revisions from GitHub timeline
async function backfillRevisions(
  owner: string,
  repo: string,
  prNumber: number,
  baseRef: string,
  baseSha: string,
  headRef: string,
  currentHeadSha: string,
  accessToken: string,
  timeline: Awaited<ReturnType<typeof fetchPRTimeline>>
): Promise<void> {
  try {
    // Extract force-push events and initial commit
    const revisions: Array<{ sha: string; timestamp: string }> = [];

    // Find the PR creation event to get the initial head SHA
    const createdEvent = timeline.find(e => e.event === 'committed' || e.event === 'head_ref_force_pushed');

    for (const event of timeline) {
      if (event.event === 'head_ref_force_pushed' && event.commit_id) {
        revisions.push({
          sha: event.commit_id,
          timestamp: event.created_at,
        });
      }
    }

    // Add current head if not already in the list
    if (!revisions.find(r => r.sha === currentHeadSha)) {
      revisions.push({
        sha: currentHeadSha,
        timestamp: new Date().toISOString(),
      });
    }

    // Sort by timestamp (oldest first)
    revisions.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Save each revision
    for (const rev of revisions) {
      await saveRevision(
        owner,
        repo,
        prNumber,
        rev.sha,
        headRef,
        baseSha,
        baseRef,
        accessToken,
        rev.timestamp
      );
    }
  } catch (err) {
    console.error('Failed to backfill revisions:', err);
    // Continue - backfill is optional
  }
}

// Get all revisions for a PR
function getRevisions(
  owner: string,
  repo: string,
  prNumber: number
): Array<{
  id: number;
  head_sha: string;
  head_ref: string;
  base_sha: string;
  base_ref: string;
  merge_base_sha: string | null;
  seen_at: string;
}> {
  const { rows } = query<{
    id: number;
    head_sha: string;
    head_ref: string;
    base_sha: string;
    base_ref: string;
    merge_base_sha: string | null;
    seen_at: string;
  }>(
    `SELECT id, head_sha, head_ref, base_sha, base_ref, merge_base_sha, seen_at FROM pr_revisions
     WHERE owner = ? AND repo = ? AND pr_number = ?
     ORDER BY seen_at DESC`,
    [owner, repo, prNumber]
  );
  return rows;
}
