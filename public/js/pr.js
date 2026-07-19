// PR Page JavaScript
// Handles polling, inline comments, and diff loading

(function() {
  'use strict';

  const config = window.ARGUS_CONFIG;
  if (!config) {
    console.error('ARGUS_CONFIG not found');
    return;
  }

  // State
  let pollingInterval = null;
  let lastKnownHeadSha = config.headSha;

  function showLoadingOverlay() {
    sessionStorage.setItem('argus-loading', '1');
    document.documentElement.classList.add('argus-loading');
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.add('active');
  }

  function hideLoadingOverlay() {
    sessionStorage.removeItem('argus-loading');
    document.documentElement.classList.remove('argus-loading');
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.remove('active');
  }

  // DOM Elements
  const updatesBanner = document.getElementById('updates-banner');
  const reloadLink = document.getElementById('reload-link');
  const dismissBannerBtn = document.getElementById('dismiss-banner');
  const checkUpdatesBtn = document.getElementById('check-updates-btn');
  const currentHeadShaEl = document.getElementById('current-head-sha');
  const fetchedAtEl = document.getElementById('fetched-at');
  const diffContainer = document.getElementById('diff-container');
  const pollIntervalTextEl = document.getElementById('poll-interval-text');

  // ---- Lazy diff bodies (very large PRs) ----------------------------------------------
  // On large PRs the server renders file "shells" (<details data-lazy="1"> with an empty
  // placeholder body). The body is fetched on demand when the file is expanded, and can be
  // discarded again to free memory (collapse, Collapse All, or marking the file reviewed).
  // A file whose body is present has no `.diff-lazy-placeholder` child; that is what we key
  // load/discard decisions off, so it composes cleanly with the full-file/rendered toggles.

  const LAZY_PLACEHOLDER_HTML = '<div class="diff-lazy-placeholder">Loading diff…</div>';
  const lazyLoads = new Map(); // fileEl -> in-flight Promise (dedupes concurrent loads)

  // Fetch and inject a lazy file's diff body. Resolves once loaded (or immediately if the
  // body is already present / the file is not lazy). Never fetches the same file twice at once.
  function loadFileBody(fileEl) {
    if (!fileEl || !fileEl.hasAttribute('data-lazy')) return Promise.resolve();
    if (lazyLoads.has(fileEl)) return lazyLoads.get(fileEl);
    const diffContent = fileEl.querySelector(':scope > .diff-content');
    if (!diffContent || !diffContent.querySelector('.diff-lazy-placeholder')) {
      return Promise.resolve(); // already loaded
    }
    const path = fileEl.dataset.path;
    if (!path) return Promise.resolve();

    const p = (async () => {
      try {
        const url = `/pr/${config.owner}/${config.repo}/${config.prNumber}/file-diff?path=${encodeURIComponent(path)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('Server returned ' + response.status);
        const data = await response.json();
        diffContent.innerHTML = data.html;
      } catch (err) {
        console.error('Failed to load file diff:', err);
        diffContent.innerHTML = '<div class="diff-lazy-error">Failed to load diff. '
          + '<button type="button" class="lazy-retry btn btn-small">Retry</button></div>';
      } finally {
        lazyLoads.delete(fileEl);
      }
    })();
    lazyLoads.set(fileEl, p);
    return p;
  }

  // Drop a lazy file's body back to the placeholder to free memory. No-op for non-lazy files,
  // files already collapsed to a shell, or files with an open inline comment draft.
  function discardFileBody(fileEl) {
    if (!fileEl || !fileEl.hasAttribute('data-lazy')) return;
    const diffContent = fileEl.querySelector(':scope > .diff-content');
    if (!diffContent) return;
    if (diffContent.querySelector('.diff-lazy-placeholder')) return; // already a shell
    if (fileEl.querySelector('.inline-comment-form-row')) return; // unsent draft open
    diffContent.innerHTML = LAZY_PLACEHOLDER_HTML;
  }

  // Wire up lazy loading: fetch a file's body the first time its <details> opens. The toggle
  // event does not bubble, so we listen in the capture phase on the container.
  function setupLazyDiffs() {
    if (!diffContainer) return;

    diffContainer.addEventListener('toggle', (e) => {
      const fileEl = e.target;
      if (fileEl.classList && fileEl.classList.contains('diff-file') && fileEl.open) {
        loadFileBody(fileEl);
      }
    }, true);

    // Retry button inside a failed placeholder.
    diffContainer.addEventListener('click', (e) => {
      const retry = e.target.closest('.lazy-retry');
      if (!retry) return;
      const fileEl = retry.closest('.diff-file');
      if (!fileEl) return;
      const diffContent = fileEl.querySelector(':scope > .diff-content');
      if (diffContent) diffContent.innerHTML = LAZY_PLACEHOLDER_HTML;
      loadFileBody(fileEl);
    });

    // Seamless deep linking: resolve #file-/#comment- hashes on navigation, loading the
    // target's lazy file body if needed. The on-load case is handled in setupFileDeepLinks.
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash;
      if (hash.startsWith('#file-') || hash.startsWith('#comment-')) {
        revealHashTarget(hash);
      }
    });
  }

  // Open a file (and its parent directories), which triggers a lazy load via the toggle
  // listener if the body isn't present yet.
  function expandFileChain(fileEl) {
    fileEl.open = true;
    let parent = fileEl.parentElement && fileEl.parentElement.closest('details.diff-directory');
    while (parent) {
      parent.open = true;
      parent = parent.parentElement && parent.parentElement.closest('details.diff-directory');
    }
  }

  // ---- Current file marker + unreviewed navigation ------------------------------------
  // The "current" file is whichever file the user last navigated to — via the `n` shortcut
  // or by marking a file reviewed (which advances to the next unreviewed one). It gets a
  // border so the position is obvious when most of the diff is collapsed.
  function setCurrentFile(fileEl) {
    document.querySelectorAll('.diff-file.diff-file-current').forEach(el => {
      if (el !== fileEl) el.classList.remove('diff-file-current');
    });
    if (fileEl) fileEl.classList.add('diff-file-current');
  }

  // Expand a file (plus its parent directories), mark it current, and scroll it to the top.
  function goToFile(fileEl) {
    // Switch to the Files tab if we're not already on it
    const filesTab = document.querySelector('.pr-tab[data-tab="files"]');
    if (filesTab && !filesTab.classList.contains('active')) {
      filesTab.click();
    }

    expandFileChain(fileEl);
    setCurrentFile(fileEl);
    fileEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Find the next unreviewed file after `afterEl` in document order, wrapping around to the
  // first one. Returns null when nothing is left unreviewed. `afterEl` itself is skipped, so
  // this is safe to call with the file that was just marked reviewed.
  function findNextUnreviewedFile(afterEl) {
    const unreviewed = Array.from(document.querySelectorAll('.diff-file:not(.file-reviewed)'));
    if (unreviewed.length === 0) return null;
    if (!afterEl) return unreviewed[0];

    const following = unreviewed.find(el => el !== afterEl &&
      (afterEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
    return following || unreviewed.find(el => el !== afterEl) || null;
  }

  function scrollToHash(hash) {
    const el = document.querySelector(hash);
    if (el) {
      requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }

  // Expand and scroll to whatever a #file-/#comment- hash points at, loading the containing
  // lazy file first when necessary. For a #comment-<id> whose file body isn't loaded, the
  // file is resolved from the server-provided commentId → fileId map.
  async function revealHashTarget(hash) {
    const target = document.querySelector(hash);
    let fileEl = target ? target.closest('details.diff-file') : null;

    if (!fileEl && hash.indexOf('#comment-') === 0) {
      const commentId = hash.slice('#comment-'.length);
      const fileId = config.commentFiles && config.commentFiles[commentId];
      if (fileId) {
        const sel = '.diff-file[data-file-id="' +
          (window.CSS && CSS.escape ? CSS.escape(fileId) : fileId) + '"]';
        fileEl = document.querySelector(sel);
      }
    }

    if (!fileEl) {
      // Not a diff target (e.g. a conversation-tab comment) — best-effort scroll.
      scrollToHash(hash);
      return;
    }

    expandFileChain(fileEl);
    await loadFileBody(fileEl); // resolves immediately if already loaded / not lazy
    scrollToHash(hash);
  }

  // Initialize
  init();

  function init() {
    // Apply persisted whitespace preference
    const hideWsPref = localStorage.getItem('hideWhitespace');
    const currentUrl = new URL(window.location);
    const hasWParam = currentUrl.searchParams.get('w') === '1';
    if (hideWsPref === '1' && !hasWParam) {
      currentUrl.searchParams.set('w', '1');
      showLoadingOverlay();
      window.location.replace(currentUrl.toString());
      return;
    }

    // Set up event listeners
    setupPolling();
    setupSidebarLinks();
    setupInlineComments();
    setupLazyDiffs();
    setupCommentControls();
    setupReplyButtons();
    setupFileReviewToggles();
    setupDiffControls();
    setupDirectoryControlClickGuard();
    setupHeaderControlHitArea();
    setupHeaderSelectionGuard();
    setupDirectoryCollapseToggles();
    setupDirectoryReviewAllToggles();
    setupSyntaxToggle();
    setupWhitespaceToggle();
    setupFileDeepLinks();
    setupGoToFileModal();
    setupNextUnreviewedShortcut();
    setupCheckUpdatesShortcut();
    setupFullFileToggle();
    setupRenderedToggle();
    setupLoadingOverlayForNavigations();

    // Set initial state of all "Review all" directory checkboxes
    document.querySelectorAll('.dir-review-all-toggle').forEach(checkbox => {
      const dir = checkbox.closest('.diff-directory');
      if (!dir) return;
      const children = dir.querySelector('.directory-children');
      if (!children) return;
      const allFiles = children.querySelectorAll('.file-reviewed-toggle');
      const allChecked = allFiles.length > 0 &&
        children.querySelectorAll('.file-reviewed-toggle:not(:checked)').length === 0;
      checkbox.checked = allChecked;
    });

    // Auto-switch to Files tab for historical/cross-revision/explicit-current views
    // (only if no tab is explicitly set in the URL)
    if (!new URL(window.location).searchParams.has('tab')) {
      if (config.isHistoricalView || config.isCrossRevisionView || config.isCurrentRevisionExplicit) {
        const filesTab = document.querySelector('.pr-tab[data-tab="files"]');
        if (filesTab) {
          filesTab.click();
        }
      }
    }

    // Revision pill dropdowns
    setupRevisionDropdowns();

    // Dismiss banner
    if (dismissBannerBtn) {
      dismissBannerBtn.addEventListener('click', () => {
        updatesBanner.classList.add('hidden');
      });
    }

    // Check updates button
    if (checkUpdatesBtn) {
      checkUpdatesBtn.addEventListener('click', checkForUpdates);
    }

    // Reload link
    if (reloadLink) {
      reloadLink.addEventListener('click', (e) => {
        e.preventDefault();
        showLoadingOverlay();
        window.location.reload();
      });
    }

    // Page is ready - clear loading overlay from previous navigation
    hideLoadingOverlay();
  }

  // Compare dropdown
  function setupRevisionDropdowns() {
    const toggle = document.querySelector('.compare-dropdown-toggle');
    const dropdown = document.querySelector('.compare-dropdown');
    if (!toggle || !dropdown) return;

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    });

    // Close on outside click
    document.addEventListener('click', () => {
      if (dropdown) dropdown.style.display = 'none';
    });

    dropdown.addEventListener('click', (e) => e.stopPropagation());
  }

  // Polling for updates
  function setupPolling() {
    if (config.isHistoricalView || config.isCrossRevisionView) {
      // Don't poll for updates when viewing historical/cross-revision
      if (pollIntervalTextEl) {
        pollIntervalTextEl.textContent = config.isCrossRevisionView ? 'Comparison view' : 'Historical view';
      }
      return;
    }
    if (config.pollIntervalMs > 0) {
      pollingInterval = setInterval(checkForUpdates, config.pollIntervalMs);
    } else if (pollIntervalTextEl) {
      pollIntervalTextEl.textContent = 'Auto-check disabled';
    }
  }

  async function checkForUpdates() {
    // Visual feedback
    if (checkUpdatesBtn) {
      checkUpdatesBtn.textContent = 'Checking...';
      checkUpdatesBtn.disabled = true;
    }

    try {
      const url = `/pr/${config.owner}/${config.repo}/${config.prNumber}/head`;
      const response = await fetch(url);

      if (!response.ok) {
        console.warn('Failed to check for updates:', response.status);
        if (checkUpdatesBtn) {
          checkUpdatesBtn.textContent = 'Check failed';
          setTimeout(() => {
            checkUpdatesBtn.textContent = 'Check for updates';
            checkUpdatesBtn.disabled = false;
          }, 2000);
        }
        return;
      }

      const data = await response.json();

      if (data.head_sha && data.head_sha !== lastKnownHeadSha) {
        showUpdatesBanner();
        if (checkUpdatesBtn) {
          checkUpdatesBtn.textContent = 'Updates available!';
        }
        if (pollIntervalTextEl) {
          pollIntervalTextEl.textContent = 'Updates available';
        }
        // Stop polling after update detected
        if (pollingInterval) {
          clearInterval(pollingInterval);
          pollingInterval = null;
        }
      } else {
        // No updates
        if (checkUpdatesBtn) {
          checkUpdatesBtn.textContent = 'Up to date';
          setTimeout(() => {
            checkUpdatesBtn.textContent = 'Check for updates';
            checkUpdatesBtn.disabled = false;
          }, 2000);
        }
      }
    } catch (err) {
      console.error('Error checking for updates:', err);
      if (checkUpdatesBtn) {
        checkUpdatesBtn.textContent = 'Check failed';
        setTimeout(() => {
          checkUpdatesBtn.textContent = 'Check for updates';
          checkUpdatesBtn.disabled = false;
        }, 2000);
      }
    }
  }

  function showUpdatesBanner() {
    if (updatesBanner) {
      updatesBanner.classList.remove('hidden');
    }
  }

  // Sidebar links
  function setupSidebarLinks() {
    const sidebarItems = document.querySelectorAll('.file-sidebar-item');

    sidebarItems.forEach((item) => {
      item.addEventListener('click', (e) => {
        e.preventDefault();

        const fileId = item.dataset.fileId;

        // Highlight file
        const files = diffContainer.querySelectorAll('.diff-file');
        files.forEach((f) => {
          f.classList.toggle('highlighted', f.dataset.fileId === fileId);
        });

        // Scroll to file
        const targetFile = diffContainer.querySelector(`.diff-file[data-file-id="${fileId}"]`);
        if (targetFile) {
          // Ensure file is expanded (details element)
          targetFile.open = true;
          targetFile.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        // Update sidebar active state
        sidebarItems.forEach((sidebarItem) => {
          sidebarItem.classList.toggle('active', sidebarItem.dataset.fileId === fileId);
        });
      });
    });
  }

  // Inline comments
  //
  // The inline comment form is NOT rendered per-line anymore (that baked a <form>/<textarea>
  // into every commentable line — the biggest source of DOM bloat on large diffs). Instead a
  // single form is built on demand from #inline-comment-form-template and inserted after the
  // clicked line. There is at most one open form at a time.
  function setupInlineComments() {
    const template = document.getElementById('inline-comment-form-template');

    // Remove the currently open inline comment form, if any.
    function removeOpenForm() {
      const open = diffContainer.querySelector('.inline-comment-form-row');
      if (open) open.remove();
    }

    // Build and insert a form after the given diff line row.
    function openFormForLine(lineRow) {
      if (!template) return;
      removeOpenForm();

      const path = lineRow.dataset.path;
      const line = lineRow.dataset.line;
      const side = lineRow.dataset.side;
      const sha = lineRow.dataset.sha;
      if (!path || !line) return;

      const fragment = template.content.cloneNode(true);
      const formRow = fragment.querySelector('.inline-comment-form-row');
      const form = fragment.querySelector('form');
      form.action = `/pr/${config.owner}/${config.repo}/${config.prNumber}/inline-comment`;
      form.querySelector('input[name="path"]').value = path;
      form.querySelector('input[name="line"]').value = line;
      form.querySelector('input[name="side"]').value = side || 'RIGHT';
      form.querySelector('input[name="commit_id"]').value = sha || config.headSha;

      // Insert immediately after the line row (before any existing comment thread row).
      lineRow.insertAdjacentElement('afterend', formRow);

      const textarea = formRow.querySelector('textarea');
      if (textarea) textarea.focus();
    }

    diffContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.line-comment-btn');
      if (!btn) return;
      e.preventDefault(); // Prevent scroll to anchor

      const lineRow = btn.closest('.diff-line');
      if (lineRow) openFormForLine(lineRow);
    });

    // Handle cancel buttons (the form is removed entirely).
    diffContainer.addEventListener('click', (e) => {
      const cancelBtn = e.target.closest('.cancel-inline-comment, .comment-form-close');
      if (!cancelBtn) return;
      e.preventDefault();
      removeOpenForm();

      if (window.location.hash) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    });

    // Escape closes the open form.
    diffContainer.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.target.closest('.inline-comment-form-row')) {
        removeOpenForm();
      }
    });
  }

  // Expand/collapse all comments
  function setupCommentControls() {
    const expandAllBtn = document.getElementById('expand-all-comments');
    const collapseAllBtn = document.getElementById('collapse-all-comments');

    if (expandAllBtn) {
      expandAllBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const commentsList = document.querySelector('.comments-list');
        if (commentsList) {
          const allComments = commentsList.querySelectorAll('details.comment, details.review');
          allComments.forEach(comment => {
            comment.open = true;
          });
        }
      });
    }

    if (collapseAllBtn) {
      collapseAllBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const commentsList = document.querySelector('.comments-list');
        if (commentsList) {
          const allComments = commentsList.querySelectorAll('details.comment, details.review');
          allComments.forEach(comment => {
            comment.open = false;
          });
        }
      });
    }
  }

  // Reply to comments
  function setupReplyButtons() {
    const replyButtons = document.querySelectorAll('.reply-to-comment');
    const commentForm = document.querySelector('.pr-comment-form textarea[name="body"]');

    if (!commentForm) return;

    replyButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        const author = button.getAttribute('data-author');
        const body = button.getAttribute('data-body');
        const shouldQuote = button.getAttribute('data-quote') === 'true';

        let replyText;

        if (shouldQuote && body) {
          // Create quoted reply
          const quotedLines = body.split('\\n').map(line => `> ${line}`).join('\n');
          replyText = `@${author}\n\n${quotedLines}\n\n`;
        } else {
          // Simple mention reply
          replyText = `@${author} `;
        }

        // Set the form value and focus
        commentForm.value = replyText;
        commentForm.focus();

        // Scroll to the comment form
        commentForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }

  // File review toggles
  function setupFileReviewToggles() {
    if (!diffContainer) return;

    diffContainer.addEventListener('change', async (e) => {
      const checkbox = e.target.closest('.file-reviewed-toggle');
      if (!checkbox) return;

      const path = checkbox.dataset.path;
      const fileSha = checkbox.dataset.fileSha;

      try {
        const response = await fetch(
          `/pr/${config.owner}/${config.repo}/${config.prNumber}/file-review`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_path: path, head_sha: config.headSha, file_sha: fileSha })
          }
        );

        if (!response.ok) {
          throw new Error('Server returned ' + response.status);
        }

        const { reviewed } = await response.json();
        checkbox.checked = reviewed;

        const fileEl = checkbox.closest('.diff-file');
        if (fileEl) {
          fileEl.classList.toggle('file-reviewed', reviewed);
          // Collapse diff when marked as reviewed, expand when unmarked
          fileEl.open = !reviewed;
          if (reviewed) {
            // Marking reviewed collapses the file — discard its lazy body to free memory
            // (re-fetched on next expand). No-op for non-lazy files.
            discardFileBody(fileEl);
            // Advance to the next unreviewed file so a fully-collapsed diff can be walked
            // by checking Reviewed alone. Stay put if nothing is left unreviewed.
            const next = findNextUnreviewedFile(fileEl);
            if (next) {
              goToFile(next);
            } else {
              // Scroll collapsed file into view so the user can see where they ended up
              fileEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
          }
        }

        // Update review progress count
        updateReviewProgress();

        // Sync parent directory "Review all" checkboxes
        if (fileEl) {
          syncDirectoryReviewAllCheckboxes(fileEl);
        }
      } catch (err) {
        console.error('Failed to toggle review:', err);
        checkbox.checked = !checkbox.checked; // Revert
      }
    });
  }

  // Static review-progress totals are computed once and cached. The file set and per-file
  // line counts don't change after load, so each progress update only needs to re-sum the
  // currently-checked files (via a path→lines map) instead of rescanning every file — this
  // matters when bulk "Review all" toggles hundreds of files at once on a large PR.
  let reviewProgressTotals = null;
  function getReviewProgressTotals() {
    if (reviewProgressTotals) return reviewProgressTotals;
    const linesByPath = new Map();
    let totalLines = 0;
    document.querySelectorAll('.diff-file').forEach(el => {
      const lines = (parseInt(el.dataset.additions) || 0) + (parseInt(el.dataset.deletions) || 0);
      totalLines += lines;
      if (el.dataset.path) linesByPath.set(el.dataset.path, lines);
    });
    reviewProgressTotals = { totalLines, linesByPath };
    return reviewProgressTotals;
  }

  function updateReviewProgress() {
    const panel = document.getElementById('review-progress-panel');
    if (!panel) return;

    const { totalLines, linesByPath } = getReviewProgressTotals();
    const checked = document.querySelectorAll('.file-reviewed-toggle:checked');
    const reviewedFileCount = checked.length;

    let reviewedLines = 0;
    checked.forEach(cb => {
      reviewedLines += linesByPath.get(cb.dataset.path) || 0;
    });

    const percent = totalLines > 0 ? Math.round(reviewedLines / totalLines * 100) : 0;

    const filesEl = document.getElementById('review-progress-files');
    const linesEl = document.getElementById('review-progress-lines');
    const percentEl = document.getElementById('review-progress-percent');
    const barEl = document.getElementById('review-progress-bar');

    if (filesEl) filesEl.textContent = reviewedFileCount;
    if (linesEl) linesEl.textContent = reviewedLines;
    if (percentEl) percentEl.textContent = `${percent}%`;
    if (barEl) barEl.style.width = `${percent}%`;
  }

  // Run async tasks with a bounded number in flight at once.
  async function runWithConcurrency(items, limit, worker) {
    let index = 0;
    async function next() {
      while (index < items.length) {
        const i = index++;
        await worker(items[i], i);
      }
    }
    const runners = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(next());
    await Promise.all(runners);
  }

  // Diff controls
  function setupDiffControls() {
    const expandBtn = document.getElementById('expand-all-diffs');
    const collapseBtn = document.getElementById('collapse-all-diffs');

    if (expandBtn) {
      expandBtn.addEventListener('click', async () => {
        // Materialize every lazy file body first so the entire diff is in the DOM (this is
        // what makes browser find-in-page work across the whole PR). Then expand everything.
        const lazyFiles = Array.from(
          document.querySelectorAll('.diff-file[data-lazy]')
        ).filter(el => el.querySelector(':scope > .diff-content > .diff-lazy-placeholder'));

        if (lazyFiles.length > 0) {
          const originalLabel = expandBtn.textContent;
          expandBtn.disabled = true;
          let done = 0;
          const tick = () => { expandBtn.textContent = `Loading ${++done}/${lazyFiles.length}…`; };
          try {
            await runWithConcurrency(lazyFiles, 6, async (el) => {
              await loadFileBody(el);
              tick();
            });
          } finally {
            expandBtn.disabled = false;
            expandBtn.textContent = originalLabel;
          }
        }

        document.querySelectorAll('.diff-directory, .diff-file').forEach(el => {
          el.open = true;
        });
      });
    }

    if (collapseBtn) {
      collapseBtn.addEventListener('click', () => {
        // Collapse everything, and discard loaded lazy bodies to free memory.
        document.querySelectorAll('.diff-directory, .diff-file').forEach(el => {
          el.open = false;
        });
        document.querySelectorAll('.diff-file[data-lazy]').forEach(discardFileBody);
      });
    }
  }

  // Selecting text in a file header (e.g. dragging across the path to copy it) ends in a
  // click on the <summary>, which would collapse/expand the file. Toggling is the summary's
  // default action, so cancelling the click in the bubble phase suppresses it — and the
  // selection survives. A plain click leaves the selection collapsed and toggles as usual.
  function setupHeaderSelectionGuard() {
    if (!diffContainer) return;

    diffContainer.addEventListener('click', (e) => {
      const summary = e.target.closest('summary');
      if (summary && hasSelectionWithin(summary)) e.preventDefault();
    });
  }

  // True when a non-empty text selection lives inside `el` — i.e. this click is the tail end
  // of a drag-select, not a plain click. A plain click leaves the selection collapsed.
  function hasSelectionWithin(el) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
    return el.contains(selection.anchorNode) || el.contains(selection.focusNode);
  }

  const HEADER_CONTROL_SELECTOR =
    '.syntax-checkbox, .full-file-checkbox, .rendered-checkbox, .file-review-checkbox';

  // Make each header control (Reviewed / Full file / Rendered / Syntax) a single hit target:
  // a click anywhere in its padded box toggles the checkbox and never collapses the file.
  //
  // We cancel the click outright rather than just stopping propagation. Toggling a <details>
  // is the <summary>'s activation behaviour, which is the click's *default action* — only
  // preventDefault reliably cancels it; stopPropagation is a browser-dependent accident.
  // Cancelling also suppresses the native checkbox change and the <label>'s click-forwarding,
  // so we drive the checkbox ourselves and every path below produces exactly one toggle.
  function setupHeaderControlHitArea() {
    if (!diffContainer) return;

    diffContainer.addEventListener('click', (e) => {
      const stats = e.target.closest('.file-header .file-stats');
      if (!stats) return;

      // Nothing in the stats area should ever collapse the file, including the +/- counts.
      e.preventDefault();

      const control = e.target.closest(HEADER_CONTROL_SELECTOR);
      if (!control) return;

      const input = control.querySelector('input[type="checkbox"]');
      if (!input || input.disabled) return;

      input.checked = !input.checked;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // Prevent clicks on directory control checkboxes from toggling the parent <details>.
  // Checkboxes and labels inside a <summary> cause the <details> to toggle on click.
  // We stop propagation at the .dir-controls boundary so the click never reaches the
  // <summary>, while letting the native checkbox/label behavior work normally.
  function setupDirectoryControlClickGuard() {
    if (!diffContainer) return;

    // Use querySelectorAll to attach directly to each .dir-controls element.
    // stopPropagation here prevents the click from reaching the parent <summary>,
    // without interfering with native checkbox toggle or label forwarding.
    diffContainer.querySelectorAll('.dir-controls').forEach(controls => {
      controls.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    });
  }

  // Directory collapse toggle checkbox
  function setupDirectoryCollapseToggles() {
    if (!diffContainer) return;

    diffContainer.addEventListener('change', (e) => {
      const checkbox = e.target.closest('.dir-collapse-toggle');
      if (!checkbox) return;

      const directory = checkbox.closest('.diff-directory');
      if (!directory) return;

      const children = directory.querySelector('.directory-children');
      if (!children) return;

      const collapse = checkbox.checked;
      children.querySelectorAll('.diff-directory, .diff-file').forEach(el => {
        el.open = !collapse;
      });
    });
  }

  // Directory "Review all" toggle checkbox
  function setupDirectoryReviewAllToggles() {
    if (!diffContainer) return;

    diffContainer.addEventListener('change', async (e) => {
      const checkbox = e.target.closest('.dir-review-all-toggle');
      if (!checkbox) return;

      const directory = checkbox.closest('.diff-directory');
      if (!directory) return;

      const children = directory.querySelector('.directory-children');
      if (!children) return;

      const reviewed = checkbox.checked;

      if (reviewed) {
        // Find all unreviewed files in this directory (including nested subdirectories)
        const unreviewed = children.querySelectorAll('.file-reviewed-toggle:not(:checked)');
        if (unreviewed.length === 0) {
          // No unreviewed files, but still sync descendant checkboxes
          children.querySelectorAll('.dir-review-all-toggle').forEach(cb => { cb.checked = true; });
          return;
        }

        const files = Array.from(unreviewed).map(cb => ({
          file_path: cb.dataset.path,
          file_sha: cb.dataset.fileSha || ''
        }));

        showLoadingOverlay();
        try {
          const response = await fetch(
            `/pr/${config.owner}/${config.repo}/${config.prNumber}/file-review-bulk`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ files, head_sha: config.headSha, reviewed: true })
            }
          );

          if (!response.ok) throw new Error('Server returned ' + response.status);

          unreviewed.forEach(cb => {
            cb.checked = true;
            const fileEl = cb.closest('.diff-file');
            if (fileEl) {
              fileEl.classList.add('file-reviewed');
              fileEl.open = false;
            }
          });

          // Sync all descendant "Review all" checkboxes to checked
          children.querySelectorAll('.dir-review-all-toggle').forEach(cb => { cb.checked = true; });
          // Sync ancestor "Review all" checkboxes
          syncAncestorReviewAllCheckboxes(directory);

          updateReviewProgress();
        } catch (err) {
          console.error('Failed to bulk review:', err);
          checkbox.checked = false; // Revert
        } finally {
          hideLoadingOverlay();
        }
      } else {
        // Find all reviewed files in this directory (including nested subdirectories)
        const reviewedCbs = children.querySelectorAll('.file-reviewed-toggle:checked');
        if (reviewedCbs.length === 0) {
          // No reviewed files, but still sync descendant checkboxes
          children.querySelectorAll('.dir-review-all-toggle').forEach(cb => { cb.checked = false; });
          return;
        }

        const files = Array.from(reviewedCbs).map(cb => ({
          file_path: cb.dataset.path,
          file_sha: cb.dataset.fileSha || ''
        }));

        showLoadingOverlay();
        try {
          const response = await fetch(
            `/pr/${config.owner}/${config.repo}/${config.prNumber}/file-review-bulk`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ files, head_sha: config.headSha, reviewed: false })
            }
          );

          if (!response.ok) throw new Error('Server returned ' + response.status);

          reviewedCbs.forEach(cb => {
            cb.checked = false;
            const fileEl = cb.closest('.diff-file');
            if (fileEl) {
              fileEl.classList.remove('file-reviewed');
              fileEl.open = true;
            }
          });

          // Sync all descendant "Review all" checkboxes to unchecked
          children.querySelectorAll('.dir-review-all-toggle').forEach(cb => { cb.checked = false; });
          // Sync ancestor "Review all" checkboxes
          syncAncestorReviewAllCheckboxes(directory);

          updateReviewProgress();
        } catch (err) {
          console.error('Failed to bulk unreview:', err);
          checkbox.checked = true; // Revert
        } finally {
          hideLoadingOverlay();
        }
      }
    });
  }

  // Sync "Review all" checkboxes for all ancestor directories based on their descendant file state
  function syncAncestorReviewAllCheckboxes(startDir) {
    let dir = startDir.parentElement ? startDir.parentElement.closest('.diff-directory') : null;
    while (dir) {
      const reviewAllCheckbox = dir.querySelector(':scope > .directory-header .dir-review-all-toggle');
      if (reviewAllCheckbox) {
        const dirChildren = dir.querySelector('.directory-children');
        if (dirChildren) {
          const allFiles = dirChildren.querySelectorAll('.file-reviewed-toggle');
          const allChecked = allFiles.length > 0 &&
            dirChildren.querySelectorAll('.file-reviewed-toggle:not(:checked)').length === 0;
          reviewAllCheckbox.checked = allChecked;
        }
      }
      dir = dir.parentElement ? dir.parentElement.closest('.diff-directory') : null;
    }
  }

  // Sync "Review all" checkboxes when individual files change (walks up the tree)
  function syncDirectoryReviewAllCheckboxes(fileEl) {
    let dir = fileEl.closest('.diff-directory');
    while (dir) {
      const reviewAllCheckbox = dir.querySelector(':scope > .directory-header .dir-review-all-toggle');
      if (reviewAllCheckbox) {
        const dirChildren = dir.querySelector('.directory-children');
        if (dirChildren) {
          const allFiles = dirChildren.querySelectorAll('.file-reviewed-toggle');
          const allChecked = allFiles.length > 0 &&
            dirChildren.querySelectorAll('.file-reviewed-toggle:not(:checked)').length === 0;
          reviewAllCheckbox.checked = allChecked;
        }
      }
      dir = dir.parentElement ? dir.parentElement.closest('.diff-directory') : null;
    }
  }

  // Syntax highlighting toggle
  function setupSyntaxToggle() {
    if (!diffContainer) return;

    diffContainer.addEventListener('change', async (e) => {
      const checkbox = e.target.closest('.syntax-toggle');
      if (!checkbox) return;

      const newState = checkbox.checked;

      try {
        const response = await fetch(
          `/pr/${config.owner}/${config.repo}/${config.prNumber}/syntax-toggle`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: newState })
          }
        );

        if (response.ok) {
          // Reload page to apply new highlighting state
          showLoadingOverlay();
          window.location.reload();
        }
      } catch (err) {
        console.error('Failed to toggle syntax highlighting:', err);
        checkbox.checked = !checkbox.checked; // Revert on error
      }
    });
  }

  // Whitespace toggle
  function setupWhitespaceToggle() {
    const checkbox = document.getElementById('whitespace-toggle');
    if (!checkbox) return;

    checkbox.addEventListener('change', () => {
      localStorage.setItem('hideWhitespace', checkbox.checked ? '1' : '0');
      const url = new URL(window.location);
      if (checkbox.checked) {
        url.searchParams.set('w', '1');
      } else {
        url.searchParams.delete('w');
      }
      showLoadingOverlay();
      window.location.href = url.toString();
    });
  }

  // File deep links
  function setupFileDeepLinks() {
    // Handle clicking file deep links: update URL tab param and ensure file is expanded
    document.addEventListener('click', (e) => {
      const link = e.target.closest('.file-deep-link');
      if (!link) return;

      // Drag-selecting the file path ends in a click on the link — don't treat that as a
      // navigation (it would expand the file and clobber the selection).
      if (hasSelectionWithin(link)) {
        e.preventDefault();
        return;
      }

      e.preventDefault();
      const hash = link.getAttribute('href');
      const url = new URL(window.location);
      url.searchParams.set('tab', 'files');
      url.hash = hash;
      history.replaceState(null, '', url);

      // Ensure the Files tab is active
      const filesTab = document.querySelector('.pr-tab[data-tab="files"]');
      if (filesTab && !filesTab.classList.contains('active')) {
        filesTab.click();
      }

      // Expand and scroll to the target file
      const target = document.querySelector(hash);
      if (target) {
        const details = target.closest('details.diff-file');
        if (details) details.open = true;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    // On page load, if there's a hash, expand ancestors and scroll to it. This also resolves
    // #comment-<id> links that point into a lazily-unloaded file (see revealHashTarget).
    const hash = window.location.hash;
    if (hash && (hash.startsWith('#file-') || hash.startsWith('#comment-'))) {
      revealHashTarget(hash);
    }
  }

  // Go to file modal
  function setupGoToFileModal() {
    const overlay = document.getElementById('goto-file-overlay');
    const modal = document.getElementById('goto-file-modal');
    const input = document.getElementById('goto-file-input');
    const resultsList = document.getElementById('goto-file-results');
    if (!overlay || !modal || !input || !resultsList) return;

    let selectedIndex = 0;
    let filteredFiles = [];

    function getFiles() {
      const els = document.querySelectorAll('.diff-file');
      const files = [];
      els.forEach(el => {
        const path = el.dataset.path;
        const fileId = el.dataset.fileId;
        const reviewed = el.classList.contains('file-reviewed');
        if (path && fileId) files.push({ path, fileId, el, reviewed });
      });
      return files;
    }

    function openModal() {
      const allFiles = getFiles();
      filteredFiles = allFiles;
      selectedIndex = 0;
      input.value = '';
      renderResults();
      overlay.classList.add('active');
      modal.classList.add('active');
      input.focus();
    }

    function closeModal() {
      overlay.classList.remove('active');
      modal.classList.remove('active');
    }

    function renderResults() {
      resultsList.innerHTML = '';
      filteredFiles.forEach((file, i) => {
        const li = document.createElement('li');
        li.className = 'goto-file-result' + (i === selectedIndex ? ' selected' : '');
        const lastSlash = file.path.lastIndexOf('/');
        let nameHtml;
        if (lastSlash >= 0) {
          const dir = file.path.substring(0, lastSlash + 1);
          const name = file.path.substring(lastSlash + 1);
          nameHtml = '<span class="goto-file-dir">' + escapeHtml(dir) + '</span>' + escapeHtml(name);
        } else {
          nameHtml = escapeHtml(file.path);
        }
        const icon = file.reviewed
          ? '<span class="goto-file-status reviewed" title="Reviewed">✓</span>'
          : '<span class="goto-file-status" title="Not reviewed">○</span>';
        li.innerHTML = '<span class="goto-file-name">' + nameHtml + '</span>' + icon;
        li.addEventListener('click', () => navigateToFile(file));
        resultsList.appendChild(li);
      });
    }

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function filterFiles(query) {
      const allFiles = getFiles();
      if (!query.trim()) {
        filteredFiles = allFiles;
      } else {
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        filteredFiles = allFiles.filter(f => {
          const lower = f.path.toLowerCase();
          return tokens.every(t => lower.includes(t));
        });
      }
      selectedIndex = 0;
      renderResults();
    }

    function navigateToFile(file) {
      closeModal();

      // Switch to Files tab
      const filesTab = document.querySelector('.pr-tab[data-tab="files"]');
      if (filesTab && !filesTab.classList.contains('active')) {
        filesTab.click();
      }

      // Expand parent directories
      let parent = file.el.parentElement?.closest('details.diff-directory');
      while (parent) {
        parent.open = true;
        parent = parent.parentElement?.closest('details.diff-directory');
      }

      // Expand file
      file.el.open = true;
      file.el.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Update hash
      const url = new URL(window.location);
      url.searchParams.set('tab', 'files');
      url.hash = '#file-' + file.fileId;
      history.replaceState(null, '', url);
    }

    input.addEventListener('input', () => filterFiles(input.value));

    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (selectedIndex < filteredFiles.length - 1) {
          selectedIndex++;
          renderResults();
          const sel = resultsList.querySelector('.selected');
          if (sel) sel.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (selectedIndex > 0) {
          selectedIndex--;
          renderResults();
          const sel = resultsList.querySelector('.selected');
          if (sel) sel.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filteredFiles[selectedIndex]) {
          navigateToFile(filteredFiles[selectedIndex]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
      }
    });

    overlay.addEventListener('click', closeModal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'g' && !modal.classList.contains('active')) {
        const tag = document.activeElement?.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        // Don't trigger if review form is open
        const reviewForm = document.getElementById('review-form');
        if (reviewForm && reviewForm.classList.contains('active')) return;
        e.preventDefault();
        openModal();
      }
    });
  }

  // Next unreviewed file shortcut
  function setupNextUnreviewedShortcut() {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'n') return;

      // Don't trigger in form elements
      const tag = document.activeElement?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      // Don't trigger if go-to-file modal is open
      const modal = document.getElementById('goto-file-modal');
      if (modal && modal.classList.contains('active')) return;

      // Don't trigger if review form is open
      const reviewForm = document.getElementById('review-form');
      if (reviewForm && reviewForm.classList.contains('active')) return;

      e.preventDefault();

      const unreviewed = document.querySelectorAll('.diff-file:not(.file-reviewed)');
      if (unreviewed.length === 0) return;

      // Find the first unreviewed file whose top is below the current scroll position
      const threshold = 10;
      let target = null;
      for (const file of unreviewed) {
        if (file.getBoundingClientRect().top > threshold) {
          target = file;
          break;
        }
      }

      // Wrap around to the first unreviewed file if none found below
      if (!target) {
        target = unreviewed[0];
      }

      goToFile(target);
    });
  }

  // Check for updates shortcut
  function setupCheckUpdatesShortcut() {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'c') return;

      // Don't trigger in form elements
      const tag = document.activeElement?.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      // Don't trigger if go-to-file modal is open
      const modal = document.getElementById('goto-file-modal');
      if (modal && modal.classList.contains('active')) return;

      // Don't trigger if review form is open
      const reviewForm = document.getElementById('review-form');
      if (reviewForm && reviewForm.classList.contains('active')) return;

      e.preventDefault();
      checkForUpdates();
    });
  }

  // Full file toggle
  function setupFullFileToggle() {
    if (!diffContainer) return;

    // Store original diff table HTML per file path
    const originalDiffTables = new Map();

    diffContainer.addEventListener('change', async (e) => {
      const checkbox = e.target.closest('.full-file-toggle');
      if (!checkbox) return;

      const path = checkbox.dataset.path;
      const fileEl = checkbox.closest('.diff-file');
      if (!fileEl) return;

      const diffContent = fileEl.querySelector('.diff-content');
      if (!diffContent) return;

      if (checkbox.checked) {
        // Stash original HTML
        originalDiffTables.set(path, diffContent.innerHTML);

        // Show loading state
        checkbox.disabled = true;
        const label = checkbox.nextElementSibling || checkbox.parentElement.querySelector('label');
        const originalLabel = label ? label.textContent : '';
        if (label) label.textContent = 'Loading...';

        try {
          const url = new URL(window.location);
          const w = url.searchParams.get('w');
          let fetchUrl = `/pr/${config.owner}/${config.repo}/${config.prNumber}/full-file-diff?path=${encodeURIComponent(path)}`;
          if (w === '1') fetchUrl += '&w=1';

          const response = await fetch(fetchUrl);
          if (!response.ok) throw new Error('Server returned ' + response.status);

          const data = await response.json();
          diffContent.innerHTML = data.html;
        } catch (err) {
          console.error('Failed to load full file diff:', err);
          checkbox.checked = false;
          // Restore original
          if (originalDiffTables.has(path)) {
            diffContent.innerHTML = originalDiffTables.get(path);
            originalDiffTables.delete(path);
          }
        } finally {
          checkbox.disabled = false;
          if (label) label.textContent = originalLabel;
        }
      } else {
        // Restore original diff
        if (originalDiffTables.has(path)) {
          diffContent.innerHTML = originalDiffTables.get(path);
          originalDiffTables.delete(path);
        }
        // After collapsing, ensure the file header is still visible.
        // With a large full-file view, the viewport may end up far
        // below the file after content shrinks.
        const headerRect = fileEl.getBoundingClientRect();
        if (headerRect.top < 0 || headerRect.top > window.innerHeight) {
          fileEl.scrollIntoView({ block: 'start' });
        }
      }
    });
  }

  // Rendered preview toggle
  function setupRenderedToggle() {
    if (!diffContainer) return;

    const originalDiffContents = new Map();

    diffContainer.addEventListener('change', async (e) => {
      const checkbox = e.target.closest('.rendered-toggle');
      if (!checkbox) return;

      const path = checkbox.dataset.path;
      const fileEl = checkbox.closest('.diff-file');
      if (!fileEl) return;

      const diffContent = fileEl.querySelector('.diff-content');
      if (!diffContent) return;

      if (checkbox.checked) {
        originalDiffContents.set(path, diffContent.innerHTML);

        checkbox.disabled = true;
        const label = checkbox.parentElement.querySelector('label');
        const originalLabel = label ? label.textContent : '';
        if (label) label.textContent = 'Loading...';

        try {
          const fetchUrl = `/pr/${config.owner}/${config.repo}/${config.prNumber}/rendered-view?path=${encodeURIComponent(path)}`;
          const response = await fetch(fetchUrl);
          if (!response.ok) throw new Error('Server returned ' + response.status);

          const data = await response.json();
          diffContent.innerHTML = data.html;
        } catch (err) {
          console.error('Failed to load rendered view:', err);
          checkbox.checked = false;
          if (originalDiffContents.has(path)) {
            diffContent.innerHTML = originalDiffContents.get(path);
            originalDiffContents.delete(path);
          }
        } finally {
          checkbox.disabled = false;
          if (label) label.textContent = originalLabel;
        }
      } else {
        if (originalDiffContents.has(path)) {
          diffContent.innerHTML = originalDiffContents.get(path);
          originalDiffContents.delete(path);
        }
      }
    });
  }

  // Show loading overlay for link clicks and form submissions that navigate away
  function setupLoadingOverlayForNavigations() {
    // Intercept link clicks that cause full-page navigation
    document.addEventListener('click', (e) => {
      if (e.defaultPrevented) return;
      const link = e.target.closest('a[href]');
      if (!link) return;
      // Skip links that open in new tabs, use javascript:, or are fragment-only
      if (link.target === '_blank') return;
      const href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      showLoadingOverlay();
    });

    // Intercept form submissions that cause full-page navigation
    document.addEventListener('submit', () => {
      showLoadingOverlay();
    });
  }

  // Cleanup on page unload
  window.addEventListener('beforeunload', () => {
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }
  });
})();
