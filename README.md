# Tech-Website (v4)

Server-rendered Node 24 app: plain `node:http` core, EJS views, SQLite via
Drizzle, and a small TypeScript client. No React, no hydration.

## Stack

- Node 24 + TypeScript, CommonJS server build, ESM source for tooling.
- pnpm (single lockfile, `pnpm-lock.yaml`).
- EJS compiled at boot; pages work without JavaScript.
- Drizzle ORM + better-sqlite3 (WAL).
- Legacy IE11 path: ES5 + polyfills via `nomodule`; modern browsers get an
  ES2015 bundle via `<script type="module">`.
- Build: `tsc` (server/legacy) + esbuild (modern/minify) + PostCSS/autoprefixer
  + precompressed `.br`/`.gz` siblings.

## Commands

```bash
pnpm install
pnpm run dev          # server + client + CSS watchers
pnpm run build        # dist/ (server, views, assets, compressed files)
pnpm start            # production server from dist/

pnpm run check        # tsc + eslint + pnpm audit
pnpm test             # unit tests
pnpm run check:views  # render every EJS view with sample data
pnpm run check:full   # check + tests + views + hot reload
pnpm run db:init
pnpm run db:seed
pnpm run db:reset
```

## Configuration

Copy `.env.example` to `.env`. **`SESSION_SECRET`, `SESSION_SECRET_WEB` and
`SITE_ORIGIN` are required in production**; the app refuses to boot without
them. Set `TRUST_PROXY=true` only when a trusted reverse proxy supplies
`X-Forwarded-For`. Set `SETTINGS_KEY` (32-byte base64) to encrypt payment
secrets stored in SQLite.

## Security posture

- Canonical `SITE_ORIGIN` for redirects/CSRF/Stripe; never trusts the `Host`
  header.
- Signed cookie sessions (`__Host-` in production, HttpOnly, SameSite),
  bcrypt with constant-time failure paths.
- Double-submit CSRF tokens on session-bearing mutations; Origin checks on all
  mutating requests.
- Uploads: magic-byte validation, canonical filename, stored outside `dist/`,
  served as image-only with immutable caching.
- Attack hub: target validation (private/loopback/metadata ranges refused), DNS
  re-checks, URL-template origin pinning, manual redirect handling, per-user
  serialized quota checks.
- Strict CSP (`script-src 'self'`, `style-src 'self'`, `object-src 'none'`,
  `form-action 'self'`), COOP/CORP, HSTS in production.
- Stripe-only payments; PayPal/Bitcoin are disabled until server-side
  verification exists. Stripe webhooks verify signature, status, currency and
  amount.
- `pnpm audit --audit-level=moderate` is a release gate; CI runs it plus tests,
  typecheck, lint and a production build.

## Deploy

`deploy.sh` installs from the lockfile, syncs the schema, builds and restarts
the systemd unit. The app works standalone with `pnpm start` (compression,
caching and security headers are in-process). Nginx is optional; if used, set
`TRUST_PROXY=true` and do not double-compress.
