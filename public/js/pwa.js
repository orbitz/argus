/*
 * Install prompt, and the service worker registration that makes it possible.
 *
 * Mirrors the banner we use elsewhere, in plain JS because Argus ships no framework:
 *
 *   android        — Chrome fired beforeinstallprompt; a real Install button drives it.
 *   android_manual — Android, but Chrome withheld the event (its engagement heuristic);
 *                    show where the menu item lives so there is still a way in.
 *   ios            — Safari never fires the event at all; Share > Add to Home Screen.
 *
 * Mobile only. On desktop an install banner is noise — the browser's own omnibox icon is
 * left alone for anyone who wants it.
 */
(function () {
  'use strict';

  var DISMISS_KEY = 'argus-install-dismissed';

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      // iOS Safari predates the standard and uses its own flag.
      window.navigator.standalone === true
    );
  }

  function isIOS() {
    var ua = navigator.userAgent;
    // iPadOS 13+ reports as MacIntel; the touch points are what separate it from a Mac.
    return (
      /iphone|ipad|ipod/i.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }

  function isAndroid() {
    return /android/i.test(navigator.userAgent);
  }

  // --- Service worker ------------------------------------------------------------
  // Registered from /static/ with an explicit root scope: Argus can be served from
  // github.com (docs/github-proxy.md), where root paths belong to the real site, so the
  // file cannot live at /sw.js. The response carries Service-Worker-Allowed: /.
  if ('serviceWorker' in navigator) {
    var register = function () {
      navigator.serviceWorker.register('/static/js/sw.js', { scope: '/' }).catch(function () {
        // A failed registration must never break the page.
      });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }

  // --- Install banner ------------------------------------------------------------
  var deferred = null;
  var fallbackTimer = null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch (err) {
      /* private mode */
    }
    var el = document.getElementById('install-banner');
    if (el) el.remove();
  }

  function show(mode) {
    if (document.getElementById('install-banner')) return;

    var text =
      mode === 'ios'
        ? 'Install Argus: tap Share, then <strong>Add to Home Screen</strong>.'
        : mode === 'android_manual'
          ? 'Install Argus: open the browser menu, then <strong>Add to Home screen</strong>.'
          : 'Install Argus for a full-screen app on your home screen.';

    var banner = document.createElement('div');
    banner.id = 'install-banner';
    banner.className = 'install-banner';
    banner.innerHTML =
      '<span class="install-banner-text">' +
      text +
      '</span>' +
      (mode === 'android' ? '<button type="button" class="btn btn-primary" id="install-go">Install</button>' : '') +
      '<button type="button" class="install-banner-close" id="install-dismiss" aria-label="Dismiss">&#x2715;</button>';
    document.body.appendChild(banner);

    document.getElementById('install-dismiss').addEventListener('click', dismiss);

    var go = document.getElementById('install-go');
    if (go) {
      go.addEventListener('click', function () {
        if (!deferred) return;
        deferred.prompt();
        deferred.userChoice.then(function () {
          deferred = null;
          dismiss();
        });
      });
    }
  }

  function start() {
    var dismissed = false;
    try {
      dismissed = !!localStorage.getItem(DISMISS_KEY);
    } catch (err) {
      /* private mode */
    }
    if (dismissed || isStandalone()) return;

    window.addEventListener('beforeinstallprompt', function (e) {
      // Desktop keeps the browser's own install affordance; only mobile gets a banner.
      if (!isAndroid()) return;
      e.preventDefault();
      deferred = e;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      show('android');
    });

    window.addEventListener('appinstalled', dismiss);

    if (isIOS()) {
      show('ios');
    } else if (isAndroid()) {
      // Give Chrome a moment to fire the event; if its heuristic withholds it, fall back
      // to instructions rather than leaving no way to install.
      fallbackTimer = setTimeout(function () {
        if (!deferred) show('android_manual');
      }, 1500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
