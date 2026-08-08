# Running Argus as your github.com front end

Typing `github.com` lands you on the Argus dashboard, and any pull request URL — a
bookmark, a link in a review request, `gh pr view --web` — opens in Argus. Everything Argus
does not have a view for (issues, actions, settings, `git push`, the `gh` CLI, OAuth) goes
on to the real site untouched.

Three pieces make that work:

1. **A hosts entry** on each client machine points `github.com` at the Argus host.
2. **nginx** terminates TLS for `github.com` with a certificate from a CA you install
   yourself, then splits requests between Argus and the real github.com.
3. **Argus's compatibility routes** translate GitHub's URLs into Argus's own
   (`/octocat/repo/pull/42/files` → `/pr/octocat/repo/42?tab=review`). These are always on
   and need no configuration.

## Read this before you start

This is a man-in-the-middle of github.com on the machines you set it up on, and it has two
consequences you should accept deliberately:

- **The CA private key can impersonate any website** to every machine that trusts it. Keep
  it on the Argus host, readable only by root. If it leaks, remove the CA from your trust
  stores.
- **All your GitHub traffic passes through this nginx** — session cookies, and the
  credentials `git push` sends over HTTPS. It is not logged by this config, but it is
  decrypted in memory on that host.

For a single browser with no server involved, a redirect extension is a smaller hammer.
This setup is the one to use when you want git, the CLI, and several machines to keep
working against one shared Argus.

## Setup

### 1. Certificates (on the Argus host)

```bash
# Docker
deploy/nginx/setup.sh ./deploy/nginx/certs

# Bare metal
sudo deploy/nginx/setup.sh
```

Uses [mkcert](https://github.com/FiloSottile/mkcert) if installed, otherwise openssl:

| File | Purpose |
| --- | --- |
| `argus-local-ca.pem` | The CA. Install on every client machine. |
| `argus-local-ca-key.pem` | The CA private key. Never leaves this host. |
| `github.com.pem` / `github.com-key.pem` | What nginx serves. |

`deploy/nginx/certs/` is gitignored.

### 2. Run it (on the Argus host)

**Docker** — the overlay adds an nginx container and publishes 443:

```bash
docker compose -f docker-compose.yml -f docker-compose.github-proxy.yml up -d
```

The nginx container shares the Argus container's network namespace, which is why the
`127.0.0.1:3000` in `argus-github.conf` works unchanged in both deployments.

**Bare metal:**

```bash
sudo cp deploy/nginx/argus-github.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/argus-github.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Either way the config assumes Argus is on `127.0.0.1:3000`; change the
`http://127.0.0.1:3000` in the `$argus_backend` map if it is not.

Nothing listens on port 80. github.com is in every browser's HSTS preload list, so a
browser will not try plaintext for it, and leaving 80 alone avoids a fight with any other
web server on the host.

### 3. Hosts entry (on each client machine)

`/etc/hosts`, or `C:\Windows\System32\drivers\etc\hosts`:

```
192.0.2.10  github.com www.github.com
```

Use whichever address of the Argus host that machine can actually reach — its LAN address,
or its Tailscale address if you want this to follow you off the network.

Do **not** add this on a machine that needs to reach github.com without the proxy — CI
runners, build boxes.

### 4. Trust the CA (on each client machine)

Copy `argus-local-ca.pem` over, then:

```bash
# Linux
sudo cp argus-local-ca.pem /usr/local/share/ca-certificates/argus-local-ca.crt
sudo update-ca-certificates

# macOS
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain argus-local-ca.pem

# Windows (elevated)
certutil -addstore -f ROOT argus-local-ca.pem
```

Firefox keeps its own store: Settings → Privacy & Security → Certificates → View
Certificates → Authorities → Import, and tick "identify websites". Restart the browser
fully afterwards — both Chrome and Firefox cache the old trust decision.

The system store is also what `git` and `gh` check, so step 4 is what keeps them working
through the proxy.

## What goes where

| URL | Served by |
| --- | --- |
| `github.com/` | Argus dashboard |
| `github.com/pulls` | Argus dashboard |
| `github.com/notifications` | Argus notifications |
| `github.com/owner/repo/pulls` | Argus PR list |
| `github.com/owner/repo/pull/42` and its sub-pages | Argus PR view |
| everything else | the real github.com |

GitHub's Files and Commits tabs both map to Argus's merged Review tab; `/checks` maps to
the Checks tab; `/pull/42/commits/<sha>` maps to Argus's single-commit view. `?w=1` carries
across. GitHub-only options like `?diff=split` are dropped.

### Reaching the real page

Append `?argus=0` to any URL to bypass Argus for that request. The "View on GitHub" link on
every Argus PR page already carries it.

### Changing the split

The `$argus_owns_path` map at the top of `argus-github.conf` is the whole routing decision.
Anything not listed there falls through to GitHub, so a missing entry degrades to "the real
site answers" rather than to a broken page. To keep GitHub's own notifications inbox, for
example, comment out the `/notifications` line.

`/login` and `/logout` are deliberately GitHub's — Argus's own live under `/auth/`.

## Troubleshooting

**502 on GitHub pages, `upstream sent too big header` in the log.** GitHub's headers are
larger than nginx's defaults; the shipped config raises `proxy_buffer_size` to 32k for this
reason. Check the setting survived your edits.

**Browser warns about the certificate.** The CA is not trusted by *that* browser. Firefox
needs its own import; Chrome and Safari need a full restart after the system-store install.

**Every request reaches the real GitHub, none reach Argus.** Usually the hosts entry is on
a machine other than the one running the browser, or a VPN/DNS profile is overriding it.
Check with `curl -sI https://github.com/ | grep -i server`.

**nginx cannot reach GitHub (`502`, resolver timeouts).** The config resolves `github.com`
through the `resolver` addresses (1.1.1.1, 8.8.8.8) precisely so it does not follow the
hosts entry back to itself. If your network blocks outbound DNS, point `resolver` at a
resolver you can reach — but never at one that honours the hijacking hosts entry.

**git or gh fails with a certificate error.** They read the system trust store, not the
browser's. Redo step 4 on that machine.

## Undoing it

Remove the hosts entry, remove the CA (`/usr/local/share/ca-certificates/argus-local-ca.crt`
plus `update-ca-certificates`, or the equivalent), and `rm
/etc/nginx/sites-enabled/argus-github.conf && systemctl reload nginx`. Removing just the
hosts entry is enough to get the real github.com back immediately.
