# Tech-Website (v5)

Server-rendered Node 24 app: plain `node:http` core, EJS views, SQLite via
Drizzle, and a small TypeScript client. No React, no hydration.

## Stack

- Node 24 + TypeScript, CommonJS server build, ESM source for tooling.
- pnpm (single lockfile, `pnpm-lock.yaml`).
- EJS compiled at boot; pages work without JavaScript.
- Drizzle ORM + better-sqlite3 (WAL), two databases under `data/`: `main.db`
  (tech tools) and `web.db` (IPstress SaaS).
- Dual client build: both bundles are ES5 (IE11 polyfills via `nomodule`; modern
  browsers load the same code with module semantics).
- Build: `tsc` (server and legacy client) + esbuild (modern/minify) +
  PostCSS/autoprefixer + precompressed `.br`/`.gz` siblings.

## Commands

```bash
pnpm install
pnpm run dev          # server + client + CSS watchers
pnpm run build        # dist/ (server, views, assets, compressed files)
pnpm start            # production server from dist/

pnpm run check        # tsc + eslint + pnpm audit
pnpm test             # unit tests
pnpm run parity       # diff rendered pages against frozen legacy baselines
pnpm run check:views  # render every EJS view with sample data
pnpm run check:full   # check + tests + views + hot reload
pnpm run check:flows  # end-to-end flows on a throwaway database copy
pnpm run check:seo    # metadata, sitemap, feed and social previews
pnpm run check:config # deployment config + local health preflight
pnpm run check:contrast
pnpm run format       # prettier (EJS templates are excluded)
pnpm run format:check

pnpm run db:init
pnpm run db:seed
pnpm run db:reset
pnpm run db:migrate   # generate SQL from schema changes
pnpm run setup        # set the IPstress web admin from ADMIN_USERNAME/ADMIN_PASSWORD
```

## Configuration

Copy `.env.example` to `.env`. **`SESSION_SECRET`, `SESSION_SECRET_WEB` and
`SITE_ORIGIN` are required in production**; the app refuses to boot without
them. `PORT` sets the listening port (default `3000`). When no proxy is in front,
keep `SITE_ORIGIN` on the same port, for example `PORT=4000` and
`SITE_ORIGIN=http://localhost:4000`; behind a proxy, `PORT` is the internal port
and `SITE_ORIGIN` is the public HTTPS origin. Set `TRUST_PROXY=true` when a trusted reverse proxy supplies
`X-Forwarded-For`/`X-Forwarded-Proto`; it is required when HTTPS is terminated before Node. Set `SETTINGS_KEY` (32-byte base64) to encrypt payment
secrets stored in SQLite. `FEATURE_*` flags disable payments, the wheel,
affiliate, gift cards or the IPstress hub without a code change.

The directory administrator is not stored in SQLite. `ADMIN_USERNAME` and
`ADMIN_PASSWORD` in `.env` are read at every boot, so changing either value there
and restarting the server is the only way to change the login. Restarting with a
new password invalidates every existing admin session. Use at least 10
characters; 16 or more is recommended. Keep `.env` out of version control and,
on Linux, restrict it with `chmod 600 .env`.

Demo seed data (`pnpm run db:seed`) never overwrites existing tools. Seed
credentials (`admin` / `admin12345`) apply only to the IPstress web app on a
database that had no web admin yet. `pnpm run setup` configures that web admin
from `ADMIN_USERNAME`/`ADMIN_PASSWORD`; it does not write the directory
operator to SQLite.

The directory covers six Teaching and Learning domains (TL1-TL6). Tools have strand tags for TL1-TL4, write-ups for all six, and optional resource links. Bulk submissions use `/submission/import`: the CSV is parsed in the browser, the entries are rate-limited by row count, and screenshots are uploaded separately. A sample file is served at `/sample-submissions.csv`.

The operator portals (`/login` and `/web/admin/*`) are intentionally unlinked.
Public pages and the user dashboard show no admin entry point, and
unauthenticated or non-admin requests to `/admin*` and `/web/admin*` return the
ordinary 404 page. The user app (`/web/login`, `/web/register`, `/web/dashboard`)
is likewise reachable only by typing its URL: no public page links to sign-in.

## Themes

Both sites share one `theme` cookie (`light` / `dark`) and stamp `data-theme`
on the root `<html>` before first paint. Server responses stamp the same value,
so there is no flash, and a dark OS preference is only the initial default.
The dashboard and admin chrome inherit the stamped theme instead of forcing
dark.

## Payments

Stripe only, charged in USD. Checkout refuses to start until the webhook secret is configured. Plan terms and amounts are snapshotted at checkout. PayPal and Bitcoin endpoints return `503` until server-side verification exists. Webhooks verify signature, status, currency
and amount before granting a plan, and hourly plans are honoured in expiry
math.

## Security posture

- Canonical `SITE_ORIGIN` for redirects/CSRF/Stripe; never trusts the `Host`
  header.
- Signed cookie sessions (`__Host-` in production, HttpOnly, SameSite). The
  directory operator is compared against `.env` with constant-time hashes and is
  never stored in SQLite; its session fingerprint changes with the password.
  Web-app passwords use bcrypt with constant-time failure paths; legacy scrypt
  hashes are rehashed on successful login.
- Signed, expiring CSRF tokens on every mutation; Origin checks on all mutating
  requests, including proxy-safe host comparison. Form posts answer with `303`
  redirects or JSON, never raw bodies.
- Uploads: magic-byte validation, canonical filename, stored outside `dist/`,
  served as image-only. Pending screenshots are visible only to the operator;
  accepted images are versioned and revalidated.
- Attack hub: target validation (private/loopback/metadata ranges refused), DNS
  re-checks, URL-template origin pinning, manual redirect handling, per-user
  serialized quota checks. Public-target abuse is still the operator's risk.
- Attack quotas use the plan's concurrency and max time plus the admin-set
  per-user cooldown and 24-hour cap; finished attacks are marked stopped lazily
  by `date + time <= now`.
- Strict CSP (`script-src 'self'` plus a per-request JSON-LD nonce,
  `style-src 'self'`, `object-src 'none'`, `form-action 'self'`), COOP/CORP, HSTS
  in production.
- `pnpm audit --audit-level=moderate` is a release gate; CI runs it plus tests,
  typecheck, lint and a production build.

## Deploy

`deploy.sh` asserts the branch, stops the service, backs up both databases with
SQLite's online backup API, syncs the schema, builds with the previous `dist/`
kept for rollback, fixes ownership, restarts, and polls `/api/health`. A failed
health check restores the previous build. Fresh databases require
`ADMIN_USERNAME`/`ADMIN_PASSWORD` (in `.env` or the environment) so a deploy
never ships the demo credentials. The directory operator is read from these
values at boot and is not written to either database.

The app works standalone with `pnpm start` (production mode, in-process
compression, caching and security headers). `pnpm start` works with either HTTP or HTTPS
`SITE_ORIGIN`. Use HTTPS for any deployment that handles real accounts or payments. Nginx is optional; if used, set
`TRUST_PROXY=true`, point `proxy_pass` at the `PORT` value in `.env`, forward
`X-Forwarded-Proto` and `X-Forwarded-For`, and do not double-compress. Backups
live under `backups/<timestamp>/` on the server.

`PORT` is the internal listener. `PUBLIC_PORT` is the browser/Cloudflare port
and must match the port in `SITE_ORIGIN`; it defaults to that port. Behind a
proxy they differ naturally: `PORT=19198`, `PUBLIC_PORT=443`,
`SITE_ORIGIN=https://tech.biszweb.club`.

### Running without nginx

`pnpm start` can be the only Node process, but something must still terminate
TLS for `https://tech.biszweb.club/`:

- Cloudflare Tunnel, hosting panel or Caddy: set `TRUST_PROXY=true`, keep
  `TLS_CERT`/`TLS_KEY` empty, and point the tunnel/panel at
  `127.0.0.1:${PORT}`. `PUBLIC_PORT=443` and `SITE_ORIGIN` stay on the public
  HTTPS origin.
- Direct Node HTTPS: set `TLS_CERT` and `TLS_KEY` to the certificate and key
  file paths. Use `PORT=443` with `PUBLIC_PORT=443`,
  `SITE_ORIGIN=https://tech.biszweb.club`, or include the same non-standard
  port in `PORT`, `PUBLIC_PORT` and `SITE_ORIGIN`
  (`https://tech.biszweb.club:19198`). Binding 443 needs root or
  `CAP_NET_BIND_SERVICE`; the systemd unit grants that capability.
- No proxy and no certificate: HTTPS on 443 cannot reach port 19198. Use an
  HTTP origin on that port, or add a TLS terminator.

### Cloudflare directly in front

Cloudflare is itself a proxy, so set `TRUST_PROXY=true` even though there is no
nginx. Cloudflare Origin Rules can set the destination port to any value from
1 to 65535, so `PORT=19198` is valid when an active Origin Rule targets 19198.
The DNS record must be proxied (orange cloud); Origin Rules do not apply to
DNS-only records.

If `pnpm run check:config -- --public` times out while the local health check
passes, Cloudflare cannot reach the origin:

1. Confirm the DNS record is Proxied. A proxied `dig` returns Cloudflare IPs,
   not your server's IP.
2. Confirm the Origin Rule is enabled and matches `tech.biszweb.club`, with
   destination port `19198`.
3. Check Cloudflare SSL/TLS mode. An HTTP origin on 19198 needs **Flexible**.
   Full or Full (strict) makes Cloudflare attempt HTTPS to a plain-HTTP app and
   stalls. For Full (strict), install a Cloudflare Origin Certificate and set
   `TLS_CERT`/`TLS_KEY`.
4. Allow inbound TCP 19198 from Cloudflare IP ranges in UFW, the cloud
   provider firewall, and any NAT.
5. Check for a stale AAAA record. If the server has no working IPv6 address,
   remove it.

Diagnose on the server:

```bash
ss -ltnp | grep 19198                 # 0.0.0.0 is IPv4-only; :: is dual-stack
sudo ufw status verbose               # allow 19198 from Cloudflare
curl -v --max-time 60 https://tech.biszweb.club/api/health
dig +short A tech.biszweb.club
dig +short AAAA tech.biszweb.club
```

Test the origin port from another machine or network:

```bash
curl -v --max-time 10 http://208.109.228.92:19198/api/health
```

- If that times out, the firewall or bind address is wrong. Allow 19198 in
  UFW and any cloud firewall/NAT.
- If it returns 200 but the public URL times out, Cloudflare is not reaching
  the origin. Check the Origin Rule, the proxied DNS record, and the origin
  A/AAAA values.
- If `ss` shows only `0.0.0.0:19198` and Cloudflare's origin record has an
  AAAA, either remove the AAAA or set `HOST=::` in `.env` and restart so Node
  listens on IPv6 too.
- A 15-second curl can time out before Cloudflare returns its 522/524 error.
  Use `--max-time 60` to see the real Cloudflare status.

The `curl -v` response identifies the failure: `521/522/523/524` means the
origin port or firewall is wrong; `525/526` means the Cloudflare SSL/TLS mode
does not match the origin.

Alternatives:

- Cloudflare Tunnel to `http://127.0.0.1:19198` avoids inbound ports and
  certificates entirely.
- An HTTPS origin on 19198 with a Cloudflare Origin Certificate plus Full
  (strict) is the most secure direct setup.
- Port 80 with `CAP_NET_BIND_SERVICE` and Flexible mode also works.

- Restrict the origin firewall to Cloudflare IP ranges. If `TRUST_PROXY=true`
  but the origin is publicly reachable, clients can spoof
  `X-Forwarded-For` and bypass IP rate limits.

Run the preflight before starting:

```bash
pnpm run check:config -- --config-only
pnpm run check:config                 # also checks local /api/health
pnpm run check:config -- --public     # also checks the public origin
```
