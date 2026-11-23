# Tech-Website (v4)

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
pnpm run format       # prettier (EJS templates are excluded)
pnpm run format:check

pnpm run db:init
pnpm run db:seed
pnpm run db:reset
pnpm run db:migrate   # generate SQL from schema changes
pnpm run setup        # create the first admin from ADMIN_USERNAME/ADMIN_PASSWORD
```

## Configuration

Copy `.env.example` to `.env`. **`SESSION_SECRET`, `SESSION_SECRET_WEB` and
`SITE_ORIGIN` are required in production**; the app refuses to boot without
them. Set `TRUST_PROXY=true` only when a trusted reverse proxy supplies
`X-Forwarded-For`. Set `SETTINGS_KEY` (32-byte base64) to encrypt payment
secrets stored in SQLite. `FEATURE_*` flags disable payments, the wheel,
affiliate, gift cards, reCAPTCHA or the IPstress hub without a code change.

Demo seed data (`pnpm run db:seed`) never overwrites an existing operator
account or an edited plan. Seed credentials (`admin` / `admin123`) exist only
on a database that had no operator yet. Use `pnpm run setup` with a 10+
character password for any real deployment.
Re-running `pnpm run setup` rotates the existing operator account: the password
is replaced and a new `ADMIN_USERNAME` renames that account in both databases
(no duplicate admin rows, existing sessions keep their user id).

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

Stripe only, charged in USD. PayPal and Bitcoin endpoints return `503` until
server-side verification exists. Webhooks verify signature, status, currency
and amount before granting a plan, and hourly plans are honoured in expiry
math.

## Security posture

- Canonical `SITE_ORIGIN` for redirects/CSRF/Stripe; never trusts the `Host`
  header.
- Signed cookie sessions (`__Host-` in production, HttpOnly, SameSite),
  bcrypt with constant-time failure paths; legacy scrypt hashes are rehashed on
  successful login.
- Double-submit CSRF tokens on session-bearing mutations; Origin checks on all
  mutating requests. Form posts answer with `303` redirects or JSON, never raw
  bodies.
- Uploads: magic-byte validation, canonical filename, stored outside `dist/`,
  served as image-only with immutable caching.
- Attack hub: target validation (private/loopback/metadata ranges refused), DNS
  re-checks, URL-template origin pinning, manual redirect handling, per-user
  serialized quota checks. Public-target abuse is still the operator's risk.
- Attack quotas use the plan's concurrency and max time plus the admin-set
  per-user cooldown and 24-hour cap; finished attacks are marked stopped lazily
  by `date + time <= now`.
- Strict CSP (`script-src 'self'`, `style-src 'self'`, `object-src 'none'`,
  `form-action 'self'`), COOP/CORP, HSTS in production.
- `pnpm audit --audit-level=moderate` is a release gate; CI runs it plus tests,
  typecheck, lint and a production build.

## Deploy

`deploy.sh` asserts the branch, stops the service, backs up both databases with
SQLite's online backup API, syncs the schema, builds with the previous `dist/`
kept for rollback, fixes ownership, restarts, and polls `/api/health`. A failed
health check restores the previous build. Fresh databases require
`ADMIN_USERNAME`/`ADMIN_PASSWORD` (in `.env` or the environment) so a deploy
never ships the demo credentials.

The app works standalone with `pnpm start` (production mode, in-process
compression, caching and security headers). Nginx is optional; if used, set
`TRUST_PROXY=true`, forward only `X-Forwarded-For $remote_addr`, and do not
double-compress. Backups live under `backups/<timestamp>/` on the server.
